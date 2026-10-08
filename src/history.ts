import * as vscode from "vscode";
import { run } from "./but";
import { RevisionFileSystemProvider } from "./content";
import { committedChangeUri } from "./decorations";

/** The branch GitButler keeps checked out, pointing at the workspace commit. */
const WORKSPACE_REF = "refs/heads/gitbutler/workspace";

/** git's empty tree, the parent side of a root commit's diff. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** `git log` fields, separated by unit separators. With `-z`, commits are separated by NULs. */
const LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%at", "%B"].join("%x1f");

/**
 * The Source Control Graph for a GitButler repository: the applied stacks and the target branch,
 * as git stores them.
 *
 * Each stack is a chain of commits from the commit it's based on. GitButler's workspace commit
 * (`gitbutler/workspace`, what HEAD points at) merges the top of every stack. It's recreated
 * whenever anything changes, so it's left out: when the graph asks for history from it, history
 * from its parents is given instead.
 *
 * Uses the proposed `scmHistoryProvider` API, which VS Code only allows for extensions under
 * development or listed in `enable-proposed-api` (in `~/.vscode/argv.json`, or a command line flag).
 */
export class HistoryProvider implements vscode.SourceControlHistoryProvider, vscode.Disposable {
  /** `gitbutler/workspace`. Its revision is the workspace commit, which isn't shown. */
  currentHistoryItemRef: vscode.SourceControlHistoryItemRef | undefined;
  /** The target branch, e.g. `origin/main`. Commits on it that aren't applied show as incoming. */
  currentHistoryItemRemoteRef: vscode.SourceControlHistoryItemRef | undefined;
  readonly currentHistoryItemBaseRef = undefined;

  private readonly onDidChangeCurrentHistoryItemRefsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCurrentHistoryItemRefs = this.onDidChangeCurrentHistoryItemRefsEmitter.event;
  private readonly onDidChangeHistoryItemRefsEmitter =
    new vscode.EventEmitter<vscode.SourceControlHistoryItemRefsChangeEvent>();
  readonly onDidChangeHistoryItemRefs = this.onDidChangeHistoryItemRefsEmitter.event;

  /** The applied branches, then the target branch. */
  private refs: vscode.SourceControlHistoryItemRef[] = [];

  constructor(
    private readonly root: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  dispose(): void {
    this.onDidChangeCurrentHistoryItemRefsEmitter.dispose();
    this.onDidChangeHistoryItemRefsEmitter.dispose();
  }

  /**
   * Reads where the refs point, given the applied branches' names and the target branch (e.g.
   * "origin/main"), and tells the graph about any changes.
   */
  async update(branchNames: string[], target: string | undefined): Promise<void> {
    const revisions = new Map<string, string>();
    try {
      const output = await this.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes"]);
      for (const line of output.split("\n")) {
        const [revision, ref] = line.split(" ");
        if (ref) {
          revisions.set(ref, revision);
        }
      }
    } catch {
      // Not a repository any more. The refs are cleared below.
    }

    const workspace = revisions.get(WORKSPACE_REF);
    const current: vscode.SourceControlHistoryItemRef | undefined = workspace
      ? { id: WORKSPACE_REF, name: "gitbutler/workspace", revision: workspace, icon: new vscode.ThemeIcon("target") }
      : undefined;
    const targetRef = target && `refs/remotes/${target}`;
    const remote: vscode.SourceControlHistoryItemRef | undefined =
      targetRef && revisions.has(targetRef)
        ? {
            id: targetRef,
            name: target,
            revision: revisions.get(targetRef),
            category: "remote branches",
            icon: new vscode.ThemeIcon("cloud"),
          }
        : undefined;
    const refs: vscode.SourceControlHistoryItemRef[] = branchNames
      .filter((name) => revisions.has(`refs/heads/${name}`))
      .map((name) => ({
        id: `refs/heads/${name}`,
        name,
        revision: revisions.get(`refs/heads/${name}`),
        category: "branches",
        icon: new vscode.ThemeIcon("git-branch"),
      }));
    if (remote) {
      refs.push(remote);
    }

    const before = new Map([...this.refs, ...(this.currentHistoryItemRef ? [this.currentHistoryItemRef] : [])].map((r) => [r.id, r]));
    const after = new Map([...refs, ...(current ? [current] : [])].map((r) => [r.id, r]));
    const added = [...after.values()].filter((r) => !before.has(r.id));
    const removed = [...before.values()].filter((r) => !after.has(r.id));
    const modified = [...after.values()].filter((r) => before.has(r.id) && before.get(r.id)!.revision !== r.revision);
    const currentChanged =
      current?.revision !== this.currentHistoryItemRef?.revision ||
      remote?.id !== this.currentHistoryItemRemoteRef?.id ||
      remote?.revision !== this.currentHistoryItemRemoteRef?.revision;

    this.refs = refs;
    this.currentHistoryItemRef = current;
    this.currentHistoryItemRemoteRef = remote;
    if (currentChanged) {
      this.onDidChangeCurrentHistoryItemRefsEmitter.fire();
    }
    if (added.length > 0 || removed.length > 0 || modified.length > 0) {
      this.onDidChangeHistoryItemRefsEmitter.fire({ added, removed, modified, silent: false });
    }
  }

  provideHistoryItemRefs(historyItemRefs: string[] | undefined): vscode.SourceControlHistoryItemRef[] {
    const all = [...(this.currentHistoryItemRef ? [this.currentHistoryItemRef] : []), ...this.refs];
    return historyItemRefs ? all.filter((ref) => historyItemRefs.includes(ref.id)) : all;
  }

  async provideHistoryItems(
    options: vscode.SourceControlHistoryOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItem[]> {
    const workspace = this.currentHistoryItemRef?.revision;
    if (!workspace || !options.historyItemRefs) {
      return [];
    }
    // The graph passes each ref's revision, or its ID if it has none. History from the workspace
    // commit is replaced with history from its parents (`^@`), which leaves it out.
    const revisions = [...new Set(options.historyItemRefs)].map((ref) =>
      ref === workspace || ref === WORKSPACE_REF ? `${workspace}^@` : ref,
    );
    const args = ["log", "--topo-order", "-z", `--format=${LOG_FORMAT}`];
    if (typeof options.limit === "object") {
      // Everything from the given commit onwards.
      if (options.limit.id) {
        const parent = await this.git(["rev-parse", "--verify", "--quiet", `${options.limit.id}^`]).catch(() => "");
        if (parent.trim()) {
          args.push(`^${parent.trim()}`);
        }
      }
    } else {
      args.push(`--max-count=${options.limit ?? 50}`);
    }
    if (options.skip) {
      args.push(`--skip=${options.skip}`);
    }
    if (options.filterText?.trim()) {
      args.push("--regexp-ignore-case", "--fixed-strings", `--grep=${options.filterText.trim()}`);
    }
    try {
      const items = this.parseLog(await this.git([...args, ...revisions, "--"]));
      return token.isCancellationRequested ? [] : items;
    } catch {
      return [];
    }
  }

  async provideHistoryItemChanges(
    historyItemId: string,
    historyItemParentId: string | undefined,
  ): Promise<vscode.SourceControlHistoryItemChange[]> {
    const parent = historyItemParentId ?? EMPTY_TREE;
    const output = await this.git(["diff", "--name-status", "-z", "-M", parent, historyItemId]);
    const fields = output.split("\0");
    const changes: vscode.SourceControlHistoryItemChange[] = [];
    for (let i = 0; i < fields.length - 1; ) {
      const status = fields[i++];
      const oldPath = fields[i++];
      // Renames and copies list the old path, then the new one.
      const newPath = status.startsWith("R") || status.startsWith("C") ? fields[i++] : oldPath;
      const changeType = status.startsWith("A")
        ? "added"
        : status.startsWith("D")
          ? "removed"
          : status.startsWith("R")
            ? "renamed"
            : "modified";
      changes.push({
        uri: committedChangeUri(this.root, historyItemId, { cliId: "", filePath: newPath, changeType }),
        originalUri: changeType === "added" ? undefined : RevisionFileSystemProvider.uri(this.root, oldPath, parent),
        modifiedUri:
          changeType === "removed" ? undefined : RevisionFileSystemProvider.uri(this.root, newPath, historyItemId),
      });
    }
    return changes;
  }

  async resolveHistoryItem(historyItemId: string): Promise<vscode.SourceControlHistoryItem | undefined> {
    try {
      return this.parseLog(await this.git(["log", "-1", "-z", `--format=${LOG_FORMAT}`, historyItemId, "--"]))[0];
    } catch {
      return undefined;
    }
  }

  resolveHistoryItemChatContext(): undefined {
    return undefined;
  }

  resolveHistoryItemChangeRangeChatContext(): undefined {
    return undefined;
  }

  /**
   * The merge base of the given refs (IDs or names). The graph asks for the current ref's with
   * the target, to place incoming changes.
   */
  async resolveHistoryItemRefsCommonAncestor(historyItemRefs: string[]): Promise<string | undefined> {
    const current = this.currentHistoryItemRef;
    const refs =
      historyItemRefs.length === 1 && (historyItemRefs[0] === current?.id || historyItemRefs[0] === current?.name)
        ? [historyItemRefs[0], this.currentHistoryItemRemoteRef?.id]
        : historyItemRefs;
    if (refs.length < 2 || refs.some((ref) => !ref)) {
      return undefined;
    }
    try {
      return (await this.git(["merge-base", ...(refs as string[])])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private parseLog(output: string): vscode.SourceControlHistoryItem[] {
    return output
      .split("\0")
      .filter((record) => record.trim())
      .map((record) => {
        const [id, parents, author, authorEmail, timestamp, ...body] = record.replace(/^\n/, "").split("\x1f");
        const message = body.join("\x1f").trim();
        const references = this.refs.filter((ref) => ref.revision === id);
        return {
          id,
          parentIds: parents ? parents.split(" ") : [],
          subject: message.split("\n")[0],
          message,
          displayId: id.slice(0, 7),
          author,
          authorEmail,
          authorIcon: new vscode.ThemeIcon("account"),
          timestamp: Number(timestamp) * 1000,
          references: references.length > 0 ? references : undefined,
        };
      });
  }

  private git(args: string[]): Promise<string> {
    return run("git", args, this.root, this.log);
  }
}
