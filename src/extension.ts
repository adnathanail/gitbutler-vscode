import * as vscode from "vscode";
import { FileChange, run, Stack, Status } from "./but";
import { RevisionContentProvider } from "./content";
import { ChangeResource, Repository } from "./repository";
import { behindDescription, StacksProvider } from "./stacksView";

const WORKSPACE_BRANCH = "gitbutler/workspace";

let repositories: Repository[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("GitButler");
  const stacks = new StacksProvider(() => repositories);
  const stacksView = vscode.window.createTreeView("gitbutler.stacks", { treeDataProvider: stacks });

  const onRepositoryChange = () => {
    stacks.refresh();
    stacksView.description = repositories.length === 1 ? behindDescription(repositories[0]) : undefined;
  };

  const discover = async () => {
    const found = await findRepositoryRoots(log);
    repositories.forEach((r) => r.dispose());
    repositories = found.map((root) => {
      const repository = new Repository(root, log);
      repository.onDidChange(onRepositoryChange);
      return repository;
    });
    await vscode.commands.executeCommand("setContext", "gitbutler.hasRepository", repositories.length > 0);
    onRepositoryChange();
    await Promise.all(repositories.map((r) => r.refresh()));
  };

  const showError = async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showErrorMessage(message.split("\n")[0], "Show Output");
    if (choice) {
      log.show();
    }
  };

  context.subscriptions.push(
    log,
    stacksView,
    vscode.workspace.registerTextDocumentContentProvider(
      RevisionContentProvider.scheme,
      new RevisionContentProvider(log),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void discover()),
    { dispose: () => repositories.forEach((r) => r.dispose()) },

    vscode.commands.registerCommand("gitbutler.refresh", async () => {
      await Promise.all(repositories.map((r) => r.refresh()));
    }),

    vscode.commands.registerCommand("gitbutler.openChange", async (repository: Repository, change: FileChange, commitId?: string) => {
      try {
        if (commitId) {
          await repository.openCommittedChange(commitId, change);
        } else {
          await repository.openUncommittedChange(change);
        }
      } catch (err) {
        await showError(err);
      }
    }),

    // Invoked from the SCM title bar (with the SourceControl), or the input box (with the Repository).
    vscode.commands.registerCommand("gitbutler.commitAll", async (arg?: Repository | vscode.SourceControl) => {
      const repository = await resolveRepository(arg);
      if (!repository) {
        return;
      }
      await repository.refresh();
      const status = repository.status;
      if (!status) {
        return showError(repository.error ?? "Could not read GitButler status");
      }
      const paths = [
        ...status.uncommittedChanges.map((c) => c.filePath),
        ...status.stacks.flatMap((s) => s.assignedChanges.map((c) => c.filePath)),
      ];
      if (paths.length === 0) {
        vscode.window.showInformationMessage("There are no changes to commit.");
        return;
      }
      await commit(repository, paths, assignedStack(status, paths)).catch(showError);
    }),

    // Invoked from the context menu on one or more selected changes in the Source Control panel.
    vscode.commands.registerCommand("gitbutler.commitSelected", async (...selected: ChangeResource[]) => {
      const resources = selected.filter((r) => r?.repository);
      if (resources.length === 0) {
        return;
      }
      const repository = resources[0].repository;
      const paths = resources.filter((r) => r.repository === repository).map((r) => r.change.filePath);
      await repository.refresh();
      if (!repository.status) {
        return showError(repository.error ?? "Could not read GitButler status");
      }
      await commit(repository, paths, assignedStack(repository.status, paths)).catch(showError);
    }),
  );

  void discover();
}

export function deactivate(): void {}

async function findRepositoryRoots(log: vscode.OutputChannel): Promise<string[]> {
  const roots = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") {
      continue;
    }
    try {
      const root = (await run("git", ["rev-parse", "--show-toplevel"], folder.uri.fsPath, log)).trim();
      const branch = (await run("git", ["branch", "--show-current"], root, log)).trim();
      if (branch === WORKSPACE_BRANCH) {
        roots.add(root);
      }
    } catch {
      // Not a git repository.
    }
  }
  return [...roots];
}

async function resolveRepository(arg?: Repository | vscode.SourceControl): Promise<Repository | undefined> {
  if (arg instanceof Repository) {
    return arg;
  }
  if (arg) {
    const match = repositories.find((r) => r.sourceControl === arg);
    if (match) {
      return match;
    }
  }
  if (repositories.length <= 1) {
    return repositories[0];
  }
  const picked = await vscode.window.showQuickPick(
    repositories.map((r) => ({ label: r.name, description: r.root, repository: r })),
    { placeHolder: "Choose a repository" },
  );
  return picked?.repository;
}

/** The stack every path is assigned to, if they're all assigned to the same one. */
function assignedStack(status: Status, paths: string[]): Stack | undefined {
  const stacks = new Set(
    paths.map((p) => status.stacks.find((s) => s.assignedChanges.some((c) => c.filePath === p))),
  );
  const [only] = stacks;
  return stacks.size === 1 ? only : undefined;
}

/**
 * Asks which branch to commit to when it's ambiguous.
 *
 * Returns `null` if the user cancelled, `""` for a new branch with a generated name, or `undefined`
 * to let `but` decide (the tip of the only applied stack, or a new branch when none are applied).
 */
async function pickBranch(status: Status, preferred?: Stack): Promise<string | undefined | null> {
  if (preferred) {
    return preferred.branches[0]?.name;
  }
  if (status.stacks.length <= 1) {
    return undefined;
  }
  type Item = vscode.QuickPickItem & { branch?: string };
  const items: Item[] = [];
  for (const stack of status.stacks) {
    items.push({ label: stack.branches.length > 1 ? "Stack" : "", kind: vscode.QuickPickItemKind.Separator });
    stack.branches.forEach((branch, i) => {
      items.push({
        label: branch.name,
        description: stack.branches.length > 1 ? (i === 0 ? "top of stack" : "lower in stack") : undefined,
        iconPath: new vscode.ThemeIcon("git-branch"),
        branch: branch.name,
      });
    });
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "New Branch…", iconPath: new vscode.ThemeIcon("add") });

  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Choose a branch to commit to" });
  if (!picked) {
    return null;
  }
  if (picked.branch) {
    return picked.branch;
  }
  const name = await vscode.window.showInputBox({
    prompt: "New branch name",
    placeHolder: "Leave empty to generate a name",
  });
  if (name === undefined) {
    return null;
  }
  // An unknown branch name creates a new unstacked branch; an empty one generates a name.
  return name.trim();
}

async function commit(repository: Repository, paths: string[], preferred?: Stack): Promise<void> {
  const status = repository.status!;
  const inputBox = repository.sourceControl.inputBox;

  let message = inputBox.value.trim();
  if (!message) {
    message =
      (await vscode.window.showInputBox({
        prompt: "Commit message",
        validateInput: (v) => (v.trim() ? undefined : "A commit message is required"),
      })) ?? "";
    if (!message.trim()) {
      return;
    }
  }

  const branch = await pickBranch(status, preferred);
  if (branch === null) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: "Committing…" },
    () => repository.but.commit(message, paths, branch),
  );
  inputBox.value = "";
  await repository.refresh();
}
