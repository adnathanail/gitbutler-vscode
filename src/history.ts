import * as vscode from "vscode";
import { FileChange, run } from "./but";
import { RevisionFileSystemProvider } from "./content";
import { committedChangeUri } from "./decorations";

/** git's empty tree, the parent side of a root commit's diff. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** `git log` fields, separated by unit separators. With `-z`, commits are separated by NULs. */
const LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%at", "%B"].join("%x1f");

/** A commit's first parent, or the empty tree for a root commit. */
export async function firstParent(root: string, log: vscode.OutputChannel, commitId: string): Promise<string> {
  const parents = await run("git", ["rev-list", "--parents", "-n", "1", commitId], root, log);
  return parents.trim().split(" ")[1] ?? EMPTY_TREE;
}

/**
 * The files a commit changed, compared with `parent` (by default its first parent, or the empty tree
 * for a root commit). Renamed files also have the path they were renamed from.
 */
export async function commitChanges(
  root: string,
  log: vscode.OutputChannel,
  commitId: string,
  parent?: string,
): Promise<{ change: FileChange; oldPath: string }[]> {
  parent ??= await firstParent(root, log, commitId);
  const output = await run("git", ["diff", "--name-status", "-z", "-M", parent, commitId], root, log);
  const fields = output.split("\0");
  const changes: { change: FileChange; oldPath: string }[] = [];
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++];
    const oldPath = fields[i++];
    // Renames and copies list the old path, then the new one.
    const filePath = status.startsWith("R") || status.startsWith("C") ? fields[i++] : oldPath;
    const changeType = status.startsWith("A")
      ? "added"
      : status.startsWith("D")
        ? "removed"
        : status.startsWith("R")
          ? "renamed"
          : "modified";
    changes.push({ change: { cliId: "", filePath, changeType }, oldPath });
  }
  return changes;
}

/**
 * The Source Control Graph for a GitButler repository: the applied stacks and the target branch,
 * as git stores them.
 *
 * Each stack is a chain of commits from the commit it's based on. With two or more stacks applied,
 * GitButler checks out `gitbutler/workspace`, pointing at a workspace commit that merges the top of
 * every stack. With one, it checks out that stack's branch, and with none, the target branch. The
 * graph's current ref is whatever HEAD points at.
 *
 * Uses the proposed `scmHistoryProvider` API, which VS Code only allows for extensions under
 * development or listed in `enable-proposed-api` (in `~/.vscode/argv.json`, or a command line flag).
 */
export class HistoryProvider implements vscode.SourceControlHistoryProvider, vscode.Disposable {
  /** What HEAD points at: `gitbutler/workspace`, another branch, or a commit if HEAD is detached. */
  currentHistoryItemRef: vscode.SourceControlHistoryItemRef | undefined;
  /**
   * The target branch, e.g. `origin/main`, or a local branch such as `main` in a repository
   * without remotes. Commits on it that aren't applied show as incoming.
   */
  currentHistoryItemRemoteRef: vscode.SourceControlHistoryItemRef | undefined;
  readonly currentHistoryItemBaseRef = undefined;

  private readonly onDidChangeCurrentHistoryItemRefsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCurrentHistoryItemRefs = this.onDidChangeCurrentHistoryItemRefsEmitter.event;
  private readonly onDidChangeHistoryItemRefsEmitter =
    new vscode.EventEmitter<vscode.SourceControlHistoryItemRefsChangeEvent>();
  readonly onDidChangeHistoryItemRefs = this.onDidChangeHistoryItemRefsEmitter.event;

  /** The applied branches, then the target branch, apart from whichever is the current ref. */
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
   * "origin/main" or "main"), and tells the graph about any changes.
   */
  async update(branchNames: string[], target: string | undefined): Promise<void> {
    const revisions = new Map<string, string>();
    let current: vscode.SourceControlHistoryItemRef | undefined;
    try {
      const [refs, head, headRef] = await Promise.all([
        this.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes"]),
        this.git(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => ""),
        // Fails when HEAD is detached.
        this.git(["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
      ]);
      for (const line of refs.split("\n")) {
        const [revision, ref] = line.split(" ");
        if (ref) {
          revisions.set(ref, revision);
        }
      }
      if (head.trim()) {
        const id = headRef.trim() || "HEAD";
        current = {
          id,
          name: id.replace(/^refs\/heads\//, ""),
          revision: head.trim(),
          icon: new vscode.ThemeIcon("target"),
        };
      }
    } catch {
      // Not a repository any more. The refs are cleared below.
    }

    // `but` reports a target tracking a remote branch as the remote branch, and otherwise the
    // local branch.
    const targetRef = [`refs/remotes/${target}`, `refs/heads/${target}`].find((ref) => target && revisions.has(ref));
    const remote: vscode.SourceControlHistoryItemRef | undefined =
      target && targetRef
        ? {
            id: targetRef,
            name: target,
            revision: revisions.get(targetRef),
            category: targetRef.startsWith("refs/remotes/") ? "remote branches" : "branches",
            icon: new vscode.ThemeIcon(targetRef.startsWith("refs/remotes/") ? "cloud" : "git-branch"),
          }
        : undefined;
    // The current ref is listed separately, and may be an applied branch or the target.
    const refs: vscode.SourceControlHistoryItemRef[] = branchNames
      .filter((name) => revisions.has(`refs/heads/${name}`) && `refs/heads/${name}` !== current?.id)
      .map((name) => ({
        id: `refs/heads/${name}`,
        name,
        revision: revisions.get(`refs/heads/${name}`),
        category: "branches",
        icon: new vscode.ThemeIcon("git-branch"),
      }));
    if (remote && remote.id !== current?.id) {
      refs.push(remote);
    }

    const before = new Map([...this.refs, ...(this.currentHistoryItemRef ? [this.currentHistoryItemRef] : [])].map((r) => [r.id, r]));
    const after = new Map([...refs, ...(current ? [current] : [])].map((r) => [r.id, r]));
    const added = [...after.values()].filter((r) => !before.has(r.id));
    const removed = [...before.values()].filter((r) => !after.has(r.id));
    const modified = [...after.values()].filter((r) => before.has(r.id) && before.get(r.id)!.revision !== r.revision);
    const currentChanged =
      current?.id !== this.currentHistoryItemRef?.id ||
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
    if (!this.currentHistoryItemRef || !options.historyItemRefs) {
      return [];
    }
    // The graph passes each ref's revision, or its ID if it has none.
    const revisions = [...new Set(options.historyItemRefs)];
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
    const changes = await commitChanges(this.root, this.log, historyItemId, parent);
    return changes.map(({ change, oldPath }) => ({
      uri: committedChangeUri(this.root, historyItemId, change),
      originalUri: change.changeType === "added" ? undefined : RevisionFileSystemProvider.uri(this.root, oldPath, parent),
      modifiedUri:
        change.changeType === "removed"
          ? undefined
          : RevisionFileSystemProvider.uri(this.root, change.filePath, historyItemId),
    }));
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
        const references = this.provideHistoryItemRefs(undefined).filter((ref) => ref.revision === id);
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
