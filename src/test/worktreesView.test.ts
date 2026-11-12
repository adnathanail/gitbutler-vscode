import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { WorktreesNode, WorktreesProvider } from "../worktreesView";
import { activate, collectErrors, useTestRepo } from "./helpers";

describe("Worktrees view", () => {
  const repo = useTestRepo();

  function labels(provider: WorktreesProvider, nodes: WorktreesNode[]): string[] {
    return nodes.map((node) => String(provider.getTreeItem(node).label));
  }

  it("says when there are no worktrees", async () => {
    const repository = await repo().repository();
    const provider = new WorktreesProvider(() => [repository]);

    assert.deepStrictEqual(labels(provider, provider.getChildren()), ["No worktrees"]);
  });

  it("lists active worktrees by name", async () => {
    repo().but("worktree", "new", "--json", "feature/a");
    repo().but("worktree", "new", "--json", "archived");
    repo().but("worktree", "archive", "--json", "archived");
    const repository = await repo().repository();
    const provider = new WorktreesProvider(() => [repository]);

    const nodes = provider.getChildren();

    // Archived worktrees are hidden from the workspace.
    assert.deepStrictEqual(labels(provider, nodes), ["feature-a"]);
    const item = provider.getTreeItem(nodes[0]);
    // The branch is shown as its child instead.
    assert.strictEqual(item.description, undefined);
    assert.strictEqual(item.contextValue, "worktree");
    assert.ok(nodes[0].kind === "worktree" && fs.existsSync(nodes[0].worktree.path));
  });

  it("shows each worktree's branches, commits and files as the Stacks view does", async () => {
    const created = JSON.parse(repo().but("worktree", "new", "--json", "feature-c"));
    fs.writeFileSync(`${created.path}/c.txt`, "c\n");
    execFileSync("git", ["add", "c.txt"], { cwd: created.path });
    execFileSync("git", ["commit", "-q", "-m", "Add c"], { cwd: created.path });
    const repository = await repo().repository();
    const provider = new WorktreesProvider(() => [repository]);

    const [worktree] = provider.getChildren();
    assert.strictEqual(provider.getTreeItem(worktree).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    const [branch] = provider.getChildren(worktree);
    const [commit] = provider.getChildren(branch);
    const files = provider.getChildren(commit);

    assert.deepStrictEqual(labels(provider, [branch, commit, ...files]), ["feature-c", "Add c", "c.txt"]);
    assert.strictEqual(provider.getTreeItem(branch).contextValue, "branch");
    // Unpushed, so greyed out, as on applied branches.
    assert.ok(commit.kind === "commit" && repository.unpushedCommits.has(commit.commit.commitId));
  });

  it("opens a worktree in a new window", async () => {
    repo().but("worktree", "new", "--json", "feature-b");
    const repository = await repo().repository();
    const [node] = new WorktreesProvider(() => [repository]).getChildren();
    assert.ok(node.kind === "worktree");

    const api = await activate();
    const commands = vscode.commands as { executeCommand: unknown };
    const original = vscode.commands.executeCommand;
    const opened: unknown[][] = [];
    commands.executeCommand = async (command: string, ...args: unknown[]) => {
      if (command === "vscode.openFolder") {
        opened.push(args);
        return;
      }
      return original(command, ...args);
    };
    const { errors, dispose } = collectErrors(api);
    try {
      await original("gitbutlerVscode.openWorktree", node);
    } finally {
      commands.executeCommand = original;
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    assert.strictEqual(opened.length, 1);
    const [uri, options] = opened[0] as [vscode.Uri, { forceNewWindow: boolean }];
    assert.strictEqual(uri.fsPath, node.worktree.path);
    assert.deepStrictEqual(options, { forceNewWindow: true });
  });
});
