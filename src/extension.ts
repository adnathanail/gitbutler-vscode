import * as vscode from "vscode";
import { externalOpener, FileChange, run, Stack, Status } from "./but";
import { RevisionFileSystemProvider } from "./content";
import { isGitDisabledByExtension, suggestDisablingGit, suggestReenablingGit } from "./gitIntegration";
import { ChangeResource, OpenChangeTarget, Repository } from "./repository";
import { behindDescription, Node, StacksProvider } from "./stacksView";

const WORKSPACE_BRANCH = "gitbutler/workspace";

let repositories: Repository[] = [];

/** Returned from `activate`, for tests. */
export interface ExtensionApi {
  /** Resolves once the repositories found at activation have loaded their status. */
  readonly ready: Promise<void>;
  readonly repositories: () => Repository[];
  /** Fires with the full message of every error shown to the user. */
  readonly onDidShowError: vscode.Event<string>;
  readonly revisions: RevisionFileSystemProvider;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const log = vscode.window.createOutputChannel("GitButler");
  const stacks = new StacksProvider(() => repositories);
  const stacksView = vscode.window.createTreeView("gitbutlerVscode.stacks", { treeDataProvider: stacks });

  const revisions = new RevisionFileSystemProvider();

  const onRepositoryChange = () => {
    stacks.refresh();
    stacksView.description = repositories.length === 1 ? behindDescription(repositories[0]) : undefined;
  };

  // Workspace folders already prompted about. Each prompt is shown once per change in whether a
  // folder is managed by GitButler, rather than on every discovery.
  const promptedToDisableGit = new Set<string>();
  const promptedToReenableGit = new Set<string>();

  const doDiscover = async () => {
    const found = await findRepositories(log);

    // Keep repositories that are still present, so their views don't reset.
    for (const repository of repositories.filter((r) => !found.has(r.root))) {
      repository.dispose();
    }
    const kept = repositories.filter((r) => found.has(r.root));
    const added = [...found.keys()]
      .filter((root) => !kept.some((r) => r.root === root))
      .map((root) => {
        const repository = new Repository(root, log, revisions);
        repository.onDidChange(onRepositoryChange);
        return repository;
      });
    repositories = [...kept, ...added];
    await vscode.commands.executeCommand("setContext", "gitbutlerVscode.hasRepository", repositories.length > 0);
    onRepositoryChange();

    const gitButlerRoots = new Map<string, string>();
    for (const [root, folders] of found) {
      folders.forEach((folder) => gitButlerRoots.set(folder.uri.toString(), root));
    }
    const state = context.workspaceState;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = folder.uri.toString();
      const root = gitButlerRoots.get(key);
      // Not awaited: notifications stay until the user responds.
      if (root !== undefined) {
        promptedToReenableGit.delete(key);
        if (!promptedToDisableGit.has(key)) {
          promptedToDisableGit.add(key);
          void suggestDisablingGit(folder, vscode.Uri.file(root), state);
        }
      } else {
        promptedToDisableGit.delete(key);
        if (!promptedToReenableGit.has(key) && isGitDisabledByExtension(folder, state)) {
          promptedToReenableGit.add(key);
          void suggestReenablingGit(folder, state);
        }
      }
    }

    await Promise.all(added.map((r) => r.refresh()));
  };

  // Runs one discovery at a time, so overlapping triggers can't create duplicate repositories.
  let discovering = Promise.resolve();
  const discover = () => {
    discovering = discovering.then(doDiscover).catch((err) => log.appendLine(`Discovery failed: ${err}`));
    return discovering;
  };

  // `but setup` and `but teardown` switch branches in a folder that's already open.
  let headTimer: NodeJS.Timeout | undefined;
  const onHeadChange = () => {
    clearTimeout(headTimer);
    headTimer = setTimeout(() => void discover(), 500);
  };
  const headWatcher = vscode.workspace.createFileSystemWatcher("**/.git/HEAD");
  headWatcher.onDidChange(onHeadChange);
  headWatcher.onDidCreate(onHeadChange);
  headWatcher.onDidDelete(onHeadChange);

  const errorEmitter = new vscode.EventEmitter<string>();

  // Doesn't wait for the notification to be dismissed, so commands finish when their work does.
  const showError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    errorEmitter.fire(message);
    void vscode.window.showErrorMessage(message.split("\n")[0], "Show Output").then((choice) => {
      if (choice) {
        log.show();
      }
    });
  };

  context.subscriptions.push(
    log,
    errorEmitter,
    stacksView,
    revisions,
    vscode.workspace.registerFileSystemProvider(RevisionFileSystemProvider.scheme, revisions, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void discover()),
    headWatcher,
    { dispose: () => clearTimeout(headTimer) },
    { dispose: () => repositories.forEach((r) => r.dispose()) },

    vscode.commands.registerCommand("gitbutlerVscode.refresh", async () => {
      await Promise.all(repositories.map((r) => r.refresh()));
    }),

    // The Source Control panel appends a `preserveFocus` argument when opening a resource.
    vscode.commands.registerCommand("gitbutlerVscode.openChange", async (target: OpenChangeTarget, preserveFocus?: boolean) => {
      const options = { preserveFocus: preserveFocus === true };
      try {
        if (target.commitId) {
          await target.repository.openCommittedChange(target.commitId, target.change, options);
        } else {
          await target.repository.openUncommittedChange(target.change, options);
        }
      } catch (err) {
        showError(err);
      }
    }),

    // Invoked from the SCM or Stacks view title bars, the command palette, or a branch or commit in
    // the Stacks view, which opens GitButler with it selected.
    vscode.commands.registerCommand("gitbutlerVscode.openInGitButler", async (arg?: vscode.SourceControl | Node) => {
      let repository: Repository | undefined;
      let target: string | undefined;
      if (arg && "kind" in arg && (arg.kind === "branch" || arg.kind === "commit")) {
        repository = arg.repository;
        target = arg.kind === "branch" ? arg.branch.name : (arg.commit.changeId ?? arg.commit.commitId);
      } else {
        repository = await resolveRepository(arg && "kind" in arg ? undefined : arg);
      }
      if (repository) {
        await repository.but
          .link(target)
          .then((url) => externalOpener.open(url, log))
          .catch(showError);
      }
    }),

    // Invoked from the SCM title bar (with the SourceControl), or the input box (with the Repository).
    vscode.commands.registerCommand("gitbutlerVscode.commitAll", async (arg?: Repository | vscode.SourceControl) => {
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
    vscode.commands.registerCommand("gitbutlerVscode.commitSelected", async (...selected: ChangeResource[]) => {
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

  return { ready: discover(), repositories: () => repositories, onDidShowError: errorEmitter.event, revisions };
}

export function deactivate(): void {}

/** Root paths of the GitButler repositories containing each workspace folder. */
async function findRepositories(log: vscode.OutputChannel): Promise<Map<string, vscode.WorkspaceFolder[]>> {
  const found = new Map<string, vscode.WorkspaceFolder[]>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") {
      continue;
    }
    try {
      const root = (await run("git", ["rev-parse", "--show-toplevel"], folder.uri.fsPath, log)).trim();
      const branch = (await run("git", ["branch", "--show-current"], root, log)).trim();
      if (branch === WORKSPACE_BRANCH) {
        found.set(root, [...(found.get(root) ?? []), folder]);
      }
    } catch {
      // Not a git repository.
    }
  }
  return found;
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
