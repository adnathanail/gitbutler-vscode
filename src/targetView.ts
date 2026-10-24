import * as vscode from "vscode";
import { FileChange, run } from "./but";
import { commitChanges } from "./history";
import { Repository } from "./repository";
import { committedFileItem } from "./stacksView";

/** Commits shown at first, and added by each Load More. */
export const PAGE_SIZE = 50;

/** `git log` fields, separated by unit separators. With `-z`, commits are separated by NULs. */
const LOG_FORMAT = ["%H", "%an", "%at", "%B"].join("%x1f");

export interface TargetCommit {
  readonly id: string;
  readonly message: string;
  readonly authorName: string;
  /** Milliseconds since the epoch. */
  readonly timestamp: number;
  /** On the target, but not yet in the workspace (the workspace is behind upstream). */
  readonly upstream: boolean;
}

export type TargetNode =
  | { kind: "repository"; repository: Repository }
  | { kind: "message"; text: string; error?: boolean }
  | { kind: "commit"; repository: Repository; commit: TargetCommit }
  | { kind: "file"; repository: Repository; commit: TargetCommit; change: FileChange }
  | { kind: "more"; repository: Repository };

/** One repository's loaded history, and the refs and limit it was loaded for. */
interface Page {
  readonly key: string;
  readonly commits: TargetCommit[];
  readonly hasMore: boolean;
}

/**
 * Tree of the target branch's history (e.g. `origin/main`): its commits, newest first, then the
 * files each changed. Commits on the target that aren't in the workspace yet are marked upstream.
 */
export class TargetProvider implements vscode.TreeDataProvider<TargetNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  /** How many commits to show, by repository root. */
  private readonly limits = new Map<string, number>();
  /** Loaded history by repository root, reused until the target, the workspace or the limit change. */
  private readonly pages = new Map<string, Page>();

  constructor(
    private readonly getRepositories: () => Repository[],
    private readonly log: vscode.OutputChannel,
  ) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  /** Shows another page of commits. */
  loadMore(repository: Repository): void {
    this.limits.set(repository.root, this.limit(repository) + PAGE_SIZE);
    this.refresh();
  }

  async getChildren(node?: TargetNode): Promise<TargetNode[]> {
    if (!node) {
      const repositories = this.getRepositories();
      if (repositories.length === 1) {
        return this.repositoryChildren(repositories[0]);
      }
      return repositories.map((repository) => ({ kind: "repository", repository }));
    }
    switch (node.kind) {
      case "repository":
        return this.repositoryChildren(node.repository);
      case "commit": {
        const changes = await commitChanges(node.repository.root, this.log, node.commit.id);
        return changes.map(({ change }) => ({
          kind: "file",
          repository: node.repository,
          commit: node.commit,
          change,
        }));
      }
      default:
        return [];
    }
  }

  private async repositoryChildren(repository: Repository): Promise<TargetNode[]> {
    if (repository.error) {
      return [{ kind: "message", text: repository.error.split("\n")[0], error: true }];
    }
    if (!repository.status) {
      return [{ kind: "message", text: "Loading…" }];
    }
    if (!repository.targetBranch) {
      return [{ kind: "message", text: "No target branch set" }];
    }
    // Read from git by the Source Control Graph's history provider on each refresh.
    const target = repository.history.currentHistoryItemRemoteRef;
    const workspace = repository.history.currentHistoryItemRef;
    if (!target?.revision) {
      return [{ kind: "message", text: `${repository.targetBranch} not found`, error: true }];
    }
    let page: Page;
    try {
      page = await this.page(repository, target.revision, workspace?.revision);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [{ kind: "message", text: message.split("\n")[0], error: true }];
    }
    const nodes: TargetNode[] = page.commits.map((commit) => ({ kind: "commit", repository, commit }));
    if (page.hasMore) {
      nodes.push({ kind: "more", repository });
    }
    return nodes;
  }

  private async page(repository: Repository, target: string, workspace: string | undefined): Promise<Page> {
    const limit = this.limit(repository);
    const key = `${target} ${workspace} ${limit}`;
    const cached = this.pages.get(repository.root);
    if (cached?.key === key) {
      return cached;
    }
    const git = (args: string[]) => run("git", args, repository.root, this.log);
    // One more than shown, to know whether there are more.
    const [log, upstream] = await Promise.all([
      git(["log", "-z", `--max-count=${limit + 1}`, `--format=${LOG_FORMAT}`, target, "--"]),
      workspace ? git(["rev-list", target, `^${workspace}`, "--"]) : Promise.resolve(""),
    ]);
    const upstreamIds = new Set(upstream.split("\n").filter(Boolean));
    const commits = log
      .split("\0")
      .filter((record) => record.trim())
      .map((record) => {
        const [id, authorName, timestamp, ...body] = record.replace(/^\n/, "").split("\x1f");
        return {
          id,
          message: body.join("\x1f").trim(),
          authorName,
          timestamp: Number(timestamp) * 1000,
          upstream: upstreamIds.has(id),
        };
      });
    const page = { key, commits: commits.slice(0, limit), hasMore: commits.length > limit };
    this.pages.set(repository.root, page);
    return page;
  }

  private limit(repository: Repository): number {
    return this.limits.get(repository.root) ?? PAGE_SIZE;
  }

  getTreeItem(node: TargetNode): vscode.TreeItem {
    switch (node.kind) {
      case "repository": {
        const item = new vscode.TreeItem(node.repository.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon("repo");
        item.tooltip = node.repository.root;
        item.description = node.repository.targetBranch;
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.text);
        if (node.error) {
          item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
          item.tooltip = node.text;
        }
        return item;
      }
      case "commit": {
        const { commit } = node;
        const [subject] = commit.message.split("\n");
        const item = new vscode.TreeItem(subject || "(no message)", vscode.TreeItemCollapsibleState.Collapsed);
        // Keeps commits expanded across refreshes.
        item.id = `${node.repository.root}\0${commit.id}`;
        item.iconPath = commit.upstream
          ? new vscode.ThemeIcon("cloud-download", new vscode.ThemeColor("charts.blue"))
          : new vscode.ThemeIcon("git-commit");
        item.description = `${commit.id.slice(0, 7)} · ${commit.authorName}`;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendText(commit.message);
        tooltip.appendMarkdown("\n\n---\n\n");
        tooltip.appendText(`${commit.authorName} · ${new Date(commit.timestamp).toLocaleString()} · ${commit.id}`);
        if (commit.upstream) {
          tooltip.appendMarkdown("\n\n**Upstream**: not yet in the workspace");
        }
        item.tooltip = tooltip;
        return item;
      }
      case "file":
        return committedFileItem(node.repository, node.commit.id, node.change);
      case "more": {
        const item = new vscode.TreeItem("Load More…");
        item.iconPath = new vscode.ThemeIcon("ellipsis");
        item.command = {
          command: "gitbutlerVscode.loadMoreTargetHistory",
          title: "Load More",
          arguments: [node.repository],
        };
        return item;
      }
    }
  }
}
