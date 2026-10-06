import * as path from "node:path";
import * as vscode from "vscode";
import { But, ChangeType, FileChange, Stack, Status } from "./but";
import { RevisionFileSystemProvider } from "./content";

/** An uncommitted change. */
export interface UncommittedChange {
  readonly change: FileChange;
  /** The stack the change is assigned to, if any. */
  readonly stack?: Stack;
}

/** An uncommitted change shown in the Source Control panel. */
export interface ChangeResource extends vscode.SourceControlResourceState, UncommittedChange {
  readonly repository: Repository;
}

/** Argument to the `gitbutlerVscode.openChange` command. Without a commit, opens an uncommitted change. */
export interface OpenChangeTarget {
  readonly repository: Repository;
  readonly change: FileChange;
  readonly commitId?: string;
}

/** Repository paths that change without the workspace state changing, e.g. `but`'s own lock file. */
function isIgnoredPath(root: string, uri: vscode.Uri): boolean {
  const relative = path.relative(root, uri.fsPath).split(path.sep).join("/");
  if (!relative.startsWith(".git/")) {
    return false;
  }
  return !(relative === ".git/HEAD" || relative === ".git/packed-refs" || relative.startsWith(".git/refs/"));
}

export function changeLetter(type: ChangeType): string {
  return { added: "A", modified: "M", removed: "D", renamed: "R" }[type] ?? "?";
}

export class Repository implements vscode.Disposable {
  readonly but: But;
  readonly sourceControl: vscode.SourceControl;
  readonly stagedGroup: vscode.SourceControlResourceGroup;
  readonly unassignedGroup: vscode.SourceControlResourceGroup;
  private readonly stackGroups = new Map<string, vscode.SourceControlResourceGroup>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  status?: Status;
  error?: string;
  /**
   * Paths of the staged changes, which committing is limited to. Kept by the extension, since
   * GitButler has no staging area.
   */
  private readonly staged = new Set<string>();
  /** Identifies the commits HEAD (the workspace commit) was built from, as of the last refresh. */
  private headCommits?: string;

  private refreshTimer?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private refreshQueued = false;

  constructor(
    readonly root: string,
    private readonly log: vscode.OutputChannel,
    private readonly revisions: RevisionFileSystemProvider,
  ) {
    this.but = new But(root, log);

    this.sourceControl = vscode.scm.createSourceControl("gitbutlerVscode", "GitButler", vscode.Uri.file(root));
    this.sourceControl.acceptInputCommand = {
      command: "gitbutlerVscode.commit",
      title: "Commit",
      arguments: [this],
    };
    this.sourceControl.inputBox.placeholder = "Message (⌘Enter to commit all changes)";
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => {
        if (uri.scheme !== "file") {
          return undefined;
        }
        // HEAD is the GitButler workspace commit, which merges every applied stack.
        return RevisionFileSystemProvider.uri(root, path.relative(root, uri.fsPath), "HEAD");
      },
    };

    // Groups are shown in the order they're created.
    this.stagedGroup = this.sourceControl.createResourceGroup("staged", "Staged Changes");
    this.stagedGroup.hideWhenEmpty = true;
    this.unassignedGroup = this.sourceControl.createResourceGroup("unassigned", "Uncommitted Changes");

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**"));
    const onFileEvent = (uri: vscode.Uri) => {
      if (!isIgnoredPath(root, uri)) {
        this.scheduleRefresh();
      }
    };
    watcher.onDidChange(onFileEvent);
    watcher.onDidCreate(onFileEvent);
    watcher.onDidDelete(onFileEvent);

    this.disposables.push(
      this.sourceControl,
      this.stagedGroup,
      this.unassignedGroup,
      watcher,
      this.onDidChangeEmitter,
      // Changes made outside VS Code (e.g. in the GitButler app) may not all produce file events.
      vscode.window.onDidChangeWindowState((state) => state.focused && this.scheduleRefresh()),
    );
  }

  get name(): string {
    return path.basename(this.root);
  }

  /** Uncommitted changes, unassigned ones first, then each stack's. */
  get changes(): UncommittedChange[] {
    return [
      ...(this.status?.uncommittedChanges ?? []).map((change) => ({ change })),
      ...(this.status?.stacks ?? []).flatMap((stack) => stack.assignedChanges.map((change) => ({ change, stack }))),
    ];
  }

  /** Paths of the staged uncommitted changes. */
  get stagedPaths(): string[] {
    return this.changes.map((c) => c.change.filePath).filter((p) => this.staged.has(p));
  }

  setStaged(filePaths: string[], staged: boolean): void {
    for (const filePath of filePaths) {
      if (staged) {
        this.staged.add(filePath);
      } else {
        this.staged.delete(filePath);
      }
    }
    this.updateResources();
    this.onDidChangeEmitter.fire();
  }

  uri(change: FileChange): vscode.Uri {
    return vscode.Uri.file(path.join(this.root, change.filePath));
  }

  /** Coalesces bursts of file events into a single refresh. */
  scheduleRefresh(delay = 300): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  /** Reloads status. Calls made while a refresh is running cause one more refresh after it. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        this.status = await this.but.status();
        this.error = undefined;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
      this.updateHead();
      this.updateResources();
      this.updateStatusBar();
      this.onDidChangeEmitter.fire();
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
    if (this.refreshQueued) {
      this.refreshQueued = false;
      await this.refresh();
    }
  }

  /** Makes editors showing files at HEAD reload them when the applied commits change. */
  private updateHead(): void {
    if (!this.status) {
      return;
    }
    const branches = this.status.stacks.map((s) => s.branches.map((b) => b.commits.map((c) => c.commitId)));
    const headCommits = JSON.stringify([this.status.mergeBase.commitId, branches]);
    if (headCommits !== this.headCommits) {
      this.headCommits = headCommits;
      this.revisions.repositoryChanged(this.root);
    }
  }

  private updateResources(): void {
    const changes = this.changes;
    const paths = new Set(changes.map((c) => c.change.filePath));
    for (const filePath of this.staged) {
      if (!paths.has(filePath)) {
        this.staged.delete(filePath);
      }
    }
    const isStaged = (c: UncommittedChange) => this.staged.has(c.change.filePath);

    this.stagedGroup.resourceStates = changes.filter(isStaged).map((c) => this.resource(c));
    const unstaged = changes.filter((c) => !isStaged(c));
    this.unassignedGroup.resourceStates = unstaged.filter((c) => !c.stack).map((c) => this.resource(c));

    const seen = new Set<string>();
    for (const stack of this.status?.stacks ?? []) {
      // Stack CLI IDs are positional, so key groups by the stack's bottom branch, which is stable.
      const key = stack.branches[stack.branches.length - 1]?.name ?? stack.cliId;
      seen.add(key);
      let group = this.stackGroups.get(key);
      if (!group) {
        group = this.sourceControl.createResourceGroup(`stack:${key}`, "");
        group.hideWhenEmpty = true;
        this.stackGroups.set(key, group);
      }
      group.label = `Assigned to ${stack.branches[0]?.name ?? key}`;
      group.resourceStates = unstaged.filter((c) => c.stack === stack).map((c) => this.resource(c));
    }
    for (const [key, group] of this.stackGroups) {
      if (!seen.has(key)) {
        group.dispose();
        this.stackGroups.delete(key);
      }
    }

    this.sourceControl.count = changes.length;
    this.sourceControl.inputBox.placeholder = `Message (⌘Enter to commit ${this.staged.size > 0 ? "staged" : "all"} changes)`;
  }

  /**
   * Shows the applied branches in the status bar, as the Git extension shows the current branch.
   * Stacks are listed left to right, separated by `|`, and each stack's branches from top to bottom.
   */
  private updateStatusBar(): void {
    const command = { command: "gitbutlerVscode.openInGitButler", arguments: [this.sourceControl] };
    const stacks = this.status?.stacks.map((s) => s.branches.map((b) => b.name)) ?? [];
    let title: string;
    let tooltip: string;
    if (!this.status) {
      title = "$(gitbutler-vscode-logo) $(warning)";
      tooltip = `GitButler: ${this.error?.split("\n")[0] ?? "status not loaded"}`;
    } else if (stacks.length === 0) {
      title = "$(gitbutler-vscode-logo) No branches";
      tooltip = "GitButler: no branches applied";
    } else {
      title = `$(gitbutler-vscode-logo) ${stacks.map((branches) => branches.join(", ")).join(" | ")}`;
      tooltip = ["Applied GitButler branches, one stack per line, top of stack first:", ...stacks.map((branches) => branches.join(", "))].join("\n");
    }
    this.sourceControl.statusBarCommands = [{ ...command, title, tooltip: `${tooltip}\n\nClick to open in GitButler` }];
  }

  private resource({ change, stack }: UncommittedChange): ChangeResource {
    return {
      repository: this,
      change,
      stack,
      resourceUri: this.uri(change),
      // Read by menus as `scmResourceState`.
      contextValue: change.changeType,
      command: {
        command: "gitbutlerVscode.openChange",
        title: "Open Changes",
        arguments: [{ repository: this, change } satisfies OpenChangeTarget],
      },
      decorations: {
        strikeThrough: change.changeType === "removed",
        faded: change.changeType === "removed",
        tooltip: `${change.changeType} (${changeLetter(change.changeType)})`,
      },
    };
  }

  /** Opens a diff of an uncommitted change against the workspace commit. */
  async openUncommittedChange(change: FileChange, options?: vscode.TextDocumentShowOptions): Promise<void> {
    const fileUri = this.uri(change);
    const left = RevisionFileSystemProvider.uri(this.root, change.filePath, change.changeType === "added" ? "" : "HEAD");
    const right =
      change.changeType === "removed" ? RevisionFileSystemProvider.uri(this.root, change.filePath, "") : fileUri;
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${path.basename(change.filePath)} (Uncommitted)`,
      options,
    );
  }

  /** Opens a diff of a file as changed by a commit. */
  async openCommittedChange(
    commitId: string,
    change: FileChange,
    options?: vscode.TextDocumentShowOptions,
  ): Promise<void> {
    const left = RevisionFileSystemProvider.uri(
      this.root,
      change.filePath,
      change.changeType === "added" ? "" : `${commitId}^`,
    );
    const right = RevisionFileSystemProvider.uri(
      this.root,
      change.filePath,
      change.changeType === "removed" ? "" : commitId,
    );
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${path.basename(change.filePath)} (${commitId.slice(0, 7)})`,
      options,
    );
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const group of this.stackGroups.values()) {
      group.dispose();
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
