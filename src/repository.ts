import * as path from "node:path";
import * as vscode from "vscode";
import { But, ChangeType, FileChange, Stack, Status } from "./but";
import { RevisionContentProvider } from "./content";

/** An uncommitted change shown in the Source Control panel. */
export interface ChangeResource extends vscode.SourceControlResourceState {
  readonly repository: Repository;
  readonly change: FileChange;
  /** The stack the change is assigned to, if any. */
  readonly stack?: Stack;
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
  readonly unassignedGroup: vscode.SourceControlResourceGroup;
  private readonly stackGroups = new Map<string, vscode.SourceControlResourceGroup>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  status?: Status;
  error?: string;

  private refreshTimer?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private refreshQueued = false;

  constructor(
    readonly root: string,
    private readonly log: vscode.OutputChannel,
  ) {
    this.but = new But(root, log);

    this.sourceControl = vscode.scm.createSourceControl("gitbutlerVscode", "GitButler", vscode.Uri.file(root));
    this.sourceControl.inputBox.placeholder = "Message (⌘Enter to commit all changes)";
    this.sourceControl.acceptInputCommand = {
      command: "gitbutlerVscode.commitAll",
      title: "Commit All Changes",
      arguments: [this],
    };
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => {
        if (uri.scheme !== "file") {
          return undefined;
        }
        // HEAD is the GitButler workspace commit, which merges every applied stack.
        return RevisionContentProvider.uri(root, path.relative(root, uri.fsPath), "HEAD");
      },
    };

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
      this.updateResources();
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

  private updateResources(): void {
    const status = this.status;
    this.unassignedGroup.resourceStates = (status?.uncommittedChanges ?? []).map((c) => this.resource(c));

    const seen = new Set<string>();
    for (const stack of status?.stacks ?? []) {
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
      group.resourceStates = stack.assignedChanges.map((c) => this.resource(c, stack));
    }
    for (const [key, group] of this.stackGroups) {
      if (!seen.has(key)) {
        group.dispose();
        this.stackGroups.delete(key);
      }
    }

    const assigned = status?.stacks.reduce((n, s) => n + s.assignedChanges.length, 0) ?? 0;
    this.sourceControl.count = (status?.uncommittedChanges.length ?? 0) + assigned;
  }

  private resource(change: FileChange, stack?: Stack): ChangeResource {
    const resourceUri = vscode.Uri.file(path.join(this.root, change.filePath));
    return {
      repository: this,
      change,
      stack,
      resourceUri,
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
    const fileUri = vscode.Uri.file(path.join(this.root, change.filePath));
    const left = RevisionContentProvider.uri(this.root, change.filePath, change.changeType === "added" ? "" : "HEAD");
    const right =
      change.changeType === "removed" ? RevisionContentProvider.uri(this.root, change.filePath, "") : fileUri;
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
    const left = RevisionContentProvider.uri(
      this.root,
      change.filePath,
      change.changeType === "added" ? "" : `${commitId}^`,
    );
    const right = RevisionContentProvider.uri(
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
