import * as path from "node:path";
import * as vscode from "vscode";
import { FileChange, run, Stack, Status } from "./but";
import { RevisionFileSystemProvider } from "./content";
import { ChangeDecorationProvider } from "./decorations";
import { isGitDisabledByExtension, suggestDisablingGit, suggestReenablingGit } from "./gitIntegration";
import { ChangeResource, OpenChangeTarget, Repository } from "./repository";
import { AmendTarget, behindDescription, StacksProvider } from "./stacksView";

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
  const stacksView = vscode.window.createTreeView("gitbutlerVscode.stacks", {
    treeDataProvider: stacks,
    dragAndDropController: stacks,
  });

  const revisions = new RevisionFileSystemProvider();
  const decorations = new ChangeDecorationProvider(() => repositories);

  const onRepositoryChange = () => {
    stacks.refresh();
    decorations.refresh();
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

  /** Opens the working tree file at the path of `uri`, which may be at a revision. */
  const openWorkingFile = async (uri: vscode.Uri, options: vscode.TextDocumentShowOptions) => {
    const file = vscode.Uri.file(uri.fsPath);
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      return showError(`${vscode.workspace.asRelativePath(file)} doesn't exist in the working tree.`);
    }
    await vscode.commands.executeCommand("vscode.open", file, options);
  };

  context.subscriptions.push(
    log,
    errorEmitter,
    stacksView,
    revisions,
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
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

    // Invoked by clicking a change in the Source Control panel or the Stacks view. The Source
    // Control panel appends a `preserveFocus` argument.
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

    // Invoked from a diff editor's title bar (with the URI of the diff's right side), the Source
    // Control panel (with the selected changes), or the command palette (with nothing, for the
    // active diff). Opens working tree files. From a diff, keeps the cursor position.
    vscode.commands.registerCommand("gitbutlerVscode.openFile", async (...args: unknown[]) => {
      const resources = changeResources(args);
      if (resources.length > 0) {
        // Opened in preview mode, each file would replace the one before.
        const preview = resources.length === 1 ? undefined : false;
        for (const resource of resources) {
          await openWorkingFile(resource.resourceUri, { preview });
        }
        return;
      }
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const [arg] = args;
      const uri = arg instanceof vscode.Uri ? arg : input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
      if (!uri) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      const fromDiff = editor?.document.uri.toString() === uri.toString();
      await openWorkingFile(uri, {
        selection: fromDiff ? editor.selection : undefined,
        viewColumn: fromDiff ? editor.viewColumn : undefined,
      });
    }),

    // Invoked from the SCM title bar (with the SourceControl), the Stacks view title bar or the
    // command palette.
    vscode.commands.registerCommand("gitbutlerVscode.openInGitButler", async (arg?: vscode.SourceControl) => {
      const repository = await resolveRepository(arg);
      await repository?.but.gui().catch(showError);
    }),

    // Invoked from the SCM title bar (with the SourceControl), or the input box (with the Repository).
    // Commits the staged changes, or every change if none are staged.
    vscode.commands.registerCommand("gitbutlerVscode.commit", async (arg?: Repository | vscode.SourceControl) => {
      const repository = await resolveRepository(arg);
      if (!repository) {
        return;
      }
      await repository.refresh();
      const status = repository.status;
      if (!status) {
        return showError(repository.error ?? "Could not read GitButler status");
      }
      const staged = repository.stagedPaths;
      const paths = staged.length > 0 ? staged : repository.changes.map((c) => c.change.filePath);
      if (paths.length === 0) {
        vscode.window.showInformationMessage("There are no changes to commit.");
        return;
      }
      await commit(repository, paths, assignedStack(status, paths)).catch(showError);
    }),

    // Invoked by dropping files onto a commit in the Stacks view. Adds the files' uncommitted
    // changes to the commit.
    vscode.commands.registerCommand("gitbutlerVscode.amend", async (target: AmendTarget, uris: vscode.Uri[]) => {
      const { repository, commitId } = target;
      await repository.refresh();
      const changed = new Set(repository.changes.map((c) => c.change.filePath));
      const paths = uris
        .filter((uri) => uri.scheme === "file")
        .map((uri) => path.relative(repository.root, uri.fsPath).split(path.sep).join("/"))
        .filter((p) => changed.has(p));
      if (paths.length === 0) {
        return showError("Only files with uncommitted changes can be added to a commit.");
      }
      if (!(await confirmAmend(repository, commitId, paths))) {
        return;
      }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.SourceControl, title: "Amending…" },
          () => repository.but.amend(commitId, paths),
        );
      } catch (err) {
        showError(err);
      } finally {
        await repository.refresh();
      }
    }),

    // These are invoked from the Source Control panel, with the selected changes or a group.
    vscode.commands.registerCommand("gitbutlerVscode.stage", (...args: unknown[]) => {
      const resources = changeResources(args);
      resources[0]?.repository.setStaged(resources.map((r) => r.change.filePath), true);
    }),
    vscode.commands.registerCommand("gitbutlerVscode.unstage", (...args: unknown[]) => {
      const resources = changeResources(args);
      resources[0]?.repository.setStaged(resources.map((r) => r.change.filePath), false);
    }),
    vscode.commands.registerCommand("gitbutlerVscode.discard", async (...args: unknown[]) => {
      await discard(changeResources(args)).catch(showError);
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

/**
 * The changes a Source Control panel command applies to, all from one repository. Commands on
 * changes get every selected change, and commands on a group get the group.
 */
function changeResources(args: unknown[]): ChangeResource[] {
  const resources = args.flatMap((arg): unknown[] =>
    arg instanceof Object && "resourceStates" in arg ? (arg as vscode.SourceControlResourceGroup).resourceStates : [arg],
  );
  const changes = resources.filter((r): r is ChangeResource => r instanceof Object && "repository" in r && "change" in r);
  return changes.filter((c) => c.repository === changes[0].repository);
}

/** Asks whether to add the changes at `paths` to a commit. */
async function confirmAmend(repository: Repository, commitId: string, paths: string[]): Promise<boolean> {
  // Commits are listed top of stack first.
  const stackCommits = repository.status?.stacks.map((s) => s.branches.flatMap((b) => b.commits)) ?? [];
  const commits = stackCommits.find((commits) => commits.some((c) => c.commitId === commitId)) ?? [];
  const index = commits.findIndex((c) => c.commitId === commitId);
  const subject = commits[index]?.message.split("\n")[0] || commitId.slice(0, 7);
  const target = paths.length === 1 ? paths[0] : `${paths.length} files`;
  const rebased = index === 1 ? "The commit above it will be rebased. " : index > 1 ? `The ${index} commits above it will be rebased. ` : "";
  const choice = await vscode.window.showWarningMessage(
    `Add the changes in ${target} to "${subject}"?`,
    { modal: true, detail: `${rebased}This can be undone with \`but undo\`.` },
    "Add to Commit",
  );
  return choice === "Add to Commit";
}

/** Discards the given uncommitted changes, all from one repository, after asking for confirmation. */
async function discard(resources: ChangeResource[]): Promise<void> {
  if (resources.length === 0) {
    return;
  }
  const repository = resources[0].repository;
  const changes = resources.map((r) => r.change);

  const target = changes.length === 1 ? changes[0].filePath : `${changes.length} files`;
  const deletes = changes.some((c) => c.changeType === "added");
  const choice = await vscode.window.showWarningMessage(
    `Discard changes in ${target}?`,
    {
      modal: true,
      detail: `${deletes ? "New files will be deleted. " : ""}This can be undone with \`but undo\`.`,
    },
    "Discard Changes",
  );
  if (choice !== "Discard Changes") {
    return;
  }

  try {
    await repository.but.discard(changes.map((c) => c.filePath));
  } finally {
    await repository.refresh();
  }
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
