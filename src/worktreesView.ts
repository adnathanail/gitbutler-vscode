import * as vscode from "vscode";
import { Worktree, WorktreeStatus } from "./but";
import { Repository } from "./repository";
import { StacksNode, StacksProvider } from "./stacksView";

/** A worktree's branches, commits and files are the Stacks view's items. */
type SharedNode = Extract<StacksNode, { kind: "branch" | "commit" | "file" }>;

export type WorktreesNode =
  | { kind: "repository"; repository: Repository }
  | { kind: "message"; text: string; error?: boolean }
  | { kind: "worktree"; repository: Repository; worktree: Worktree; status?: WorktreeStatus }
  | SharedNode;

/**
 * Tree of the linked worktrees GitButler manages (`but worktree`) → their branches → commits →
 * files.
 */
export class WorktreesProvider implements vscode.TreeDataProvider<WorktreesNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  /** Makes the items and children of branches, commits and files, as in the Stacks view. */
  private readonly stacks: StacksProvider;

  constructor(private readonly getRepositories: () => Repository[]) {
    this.stacks = new StacksProvider(getRepositories);
  }

  /** The view showing this tree, which clicked commits and branches are expanded in. */
  set view(view: vscode.TreeView<WorktreesNode>) {
    // Only shared nodes are revealed through it.
    this.stacks.view = view as vscode.TreeView<StacksNode>;
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  /** Required by `TreeView.reveal`, as in the Stacks view. */
  getParent(): undefined {
    return undefined;
  }

  getChildren(node?: WorktreesNode): WorktreesNode[] {
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
      case "worktree":
        return (node.status?.branches ?? []).map((branch) => ({ kind: "branch", repository: node.repository, branch }));
      case "message":
        return [];
      default:
        return this.stacks.getChildren(node) as SharedNode[];
    }
  }

  private repositoryChildren(repository: Repository): WorktreesNode[] {
    if (repository.error) {
      return [{ kind: "message", text: repository.error.split("\n")[0], error: true }];
    }
    if (!repository.status) {
      return [{ kind: "message", text: "Loading…" }];
    }
    if (repository.worktrees.length === 0) {
      return [{ kind: "message", text: "No worktrees" }];
    }
    // `but worktree list` has the paths, and `but status` the branches.
    const statuses = repository.status.worktrees ?? [];
    return repository.worktrees.map((worktree) => ({
      kind: "worktree",
      repository,
      worktree,
      status: statuses.find((status) => status.name === worktree.name),
    }));
  }

  getTreeItem(node: WorktreesNode): vscode.TreeItem {
    switch (node.kind) {
      case "repository": {
        const item = new vscode.TreeItem(node.repository.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon("repo");
        item.tooltip = node.repository.root;
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
      case "worktree": {
        const { worktree } = node;
        const item = new vscode.TreeItem(
          worktree.name,
          node.status?.branches.length
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `${node.repository.root}\0${worktree.path}`;
        item.iconPath = new vscode.ThemeIcon("folder");
        // The branch is its child, so it's only in the tooltip.
        const branch = worktree.refName.replace(/^refs\/heads\//, "");
        item.tooltip = `${worktree.name}\n${branch}\n${worktree.path}`;
        // For the Open in New Window menu items.
        item.contextValue = "worktree";
        return item;
      }
      default: {
        const item = this.stacks.getTreeItem(node);
        // Branches start folded, unlike in the Stacks view, so a worktree's commits don't fill the view.
        if (node.kind === "branch" && item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded) {
          item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        }
        return item;
      }
    }
  }
}
