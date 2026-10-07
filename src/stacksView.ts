import * as path from "node:path";
import * as vscode from "vscode";
import { Branch, Commit, FileChange, Stack } from "./but";
import { RevisionFileSystemProvider } from "./content";
import { changeLetter, OpenChangeTarget, Repository } from "./repository";

export type StacksNode =
  | { kind: "repository"; repository: Repository }
  | { kind: "message"; text: string; error?: boolean }
  | { kind: "stack"; repository: Repository; stack: Stack }
  | { kind: "branch"; repository: Repository; branch: Branch; stack: Stack }
  | { kind: "commit"; repository: Repository; commit: Commit }
  | { kind: "file"; repository: Repository; commit: Commit; change: FileChange };

/** Argument to the `gitbutlerVscode.amend` command. */
export interface AmendTarget {
  readonly repository: Repository;
  readonly commitId: string;
}

/**
 * Tree of applied stacks → branches → commits → files. Files dropped onto a commit, or one of its
 * files, are added to that commit if they have uncommitted changes.
 */
export class StacksProvider implements vscode.TreeDataProvider<StacksNode>, vscode.TreeDragAndDropController<StacksNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  // Set by the Source Control panel, the Explorer and editor tabs when dragging files.
  readonly dropMimeTypes = ["text/uri-list"];
  readonly dragMimeTypes = [];

  constructor(private readonly getRepositories: () => Repository[]) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getChildren(node?: StacksNode): StacksNode[] {
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
      case "stack":
        return node.stack.branches.map((branch) => ({
          kind: "branch",
          repository: node.repository,
          branch,
          stack: node.stack,
        }));
      case "branch":
        return node.branch.commits.map((commit) => ({ kind: "commit", repository: node.repository, commit }));
      case "commit":
        return (node.commit.changes ?? []).map((change) => ({
          kind: "file",
          repository: node.repository,
          commit: node.commit,
          change,
        }));
      default:
        return [];
    }
  }

  async handleDrop(target: StacksNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const uriList = await dataTransfer.get("text/uri-list")?.asString();
    if (!uriList) {
      return;
    }
    const uris = uriList
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => vscode.Uri.parse(line));
    if (target?.kind !== "commit" && target?.kind !== "file") {
      void vscode.window.showInformationMessage("Drop changes onto a commit to add them to it.");
      return;
    }
    const amendTarget: AmendTarget = { repository: target.repository, commitId: target.commit.commitId };
    await vscode.commands.executeCommand("gitbutlerVscode.amend", amendTarget, uris);
  }

  private repositoryChildren(repository: Repository): StacksNode[] {
    if (repository.error) {
      return [{ kind: "message", text: repository.error.split("\n")[0], error: true }];
    }
    if (!repository.status) {
      return [{ kind: "message", text: "Loading…" }];
    }
    if (repository.status.stacks.length === 0) {
      return [{ kind: "message", text: "No branches applied" }];
    }
    // A stack with a single branch is shown as just that branch.
    return repository.status.stacks.map((stack) =>
      stack.branches.length === 1
        ? { kind: "branch", repository, branch: stack.branches[0], stack }
        : { kind: "stack", repository, stack },
    );
  }

  getTreeItem(node: StacksNode): vscode.TreeItem {
    switch (node.kind) {
      case "repository": {
        const item = new vscode.TreeItem(node.repository.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon("repo");
        item.tooltip = node.repository.root;
        item.description = behindDescription(node.repository);
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
      case "stack": {
        const names = node.stack.branches.map((b) => b.name);
        const item = new vscode.TreeItem(names[0], vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon("layers");
        item.description = `stack of ${names.length}`;
        item.tooltip = `Stack (top to bottom):\n${names.join("\n")}`;
        return item;
      }
      case "branch": {
        const { branch } = node;
        const item = new vscode.TreeItem(
          branch.name,
          branch.commits.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon("git-branch");
        const parts = [humanise(branch.branchStatus)];
        if (branch.upstreamCommits.length > 0) {
          parts.push(`${branch.upstreamCommits.length} upstream`);
        }
        item.description = parts.join(" · ");
        item.tooltip = `${branch.name}\n${item.description}`;
        return item;
      }
      case "commit": {
        const { commit } = node;
        const [subject] = commit.message.split("\n");
        const item = new vscode.TreeItem(subject || "(no message)", vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = commit.conflicted
          ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
          : new vscode.ThemeIcon("git-commit");
        // Read by menus as `viewItem`.
        item.contextValue = "commit";
        item.description = commit.commitId.slice(0, 7);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendText(commit.message.trim());
        tooltip.appendMarkdown("\n\n---\n\n");
        tooltip.appendText(
          `${commit.authorName} · ${new Date(commit.createdAt).toLocaleString()} · ${commit.commitId}`,
        );
        if (commit.conflicted) {
          tooltip.appendMarkdown("\n\n**Conflicted**");
        }
        item.tooltip = tooltip;
        return item;
      }
      case "file": {
        const { change, commit, repository } = node;
        // At the commit, rather than the working tree file, so the item gets the file's icon without
        // decorations for its uncommitted changes. A deleted file would otherwise look deleted in
        // the commit that added it.
        const item = new vscode.TreeItem(RevisionFileSystemProvider.uri(repository.root, change.filePath, commit.commitId));
        item.label = path.basename(change.filePath);
        const dir = path.dirname(change.filePath);
        item.description = `${changeLetter(change.changeType)}${dir === "." ? "" : `  ${dir}`}`;
        item.tooltip = `${change.filePath} (${change.changeType})`;
        item.command = {
          command: "gitbutlerVscode.openChange",
          title: "Open Changes",
          arguments: [{ repository, change, commitId: commit.commitId } satisfies OpenChangeTarget],
        };
        return item;
      }
    }
  }
}

export function behindDescription(repository: Repository): string | undefined {
  const behind = repository.status?.upstreamState.behind ?? 0;
  return behind > 0 ? `${behind} behind upstream` : undefined;
}

/** "completelyUnpushed" → "completely unpushed". */
function humanise(camel: string): string {
  return camel.replace(/([A-Z])/g, " $1").toLowerCase().trim();
}
