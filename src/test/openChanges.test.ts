import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import type { Repository } from "../repository";
import { StacksProvider } from "../stacksView";
import { TargetProvider } from "../targetView";
import { activate, collectErrors, useTestRepo } from "./helpers";

/**
 * The multi-file diff editor's input, which `@types/vscode` 1.90 doesn't declare. It only lists
 * files with both sides, so not added or deleted ones.
 */
interface MultiDiffInput {
  readonly textDiffs: readonly { original: vscode.Uri; modified: vscode.Uri }[];
}

describe("opening all changes", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  /** Runs a tree item's command the way clicking it does, returning the editor tab it opened. */
  async function open(item: vscode.TreeItem): Promise<vscode.Tab> {
    const command = item.command;
    assert.ok(command, "the item has no command");
    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand(command.command, ...command.arguments!);
    } finally {
      dispose();
    }
    assert.deepStrictEqual(errors, []);
    return vscode.window.tabGroups.activeTabGroup.activeTab!;
  }

  async function text(uri: vscode.Uri): Promise<string> {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  }

  function stacks(repository: Repository) {
    const provider = new StacksProvider(() => [repository]);
    const [branch] = provider.getChildren();
    return { provider, branch, commits: provider.getChildren(branch) };
  }

  it("opens a commit's changes from the Stacks view", async () => {
    repo().commit("a.txt", "one\n", "Add a", "feature");
    repo().commit("a.txt", "two\n", "Change a", "feature");
    const repository = await repo().repository();
    const { provider, commits } = stacks(repository);

    const tab = await open(provider.getTreeItem(commits[0]));

    assert.match(tab.label, /^[0-9a-f]{7} - Change a \(1 file\)$/);
    const [diff] = (tab.input as MultiDiffInput).textDiffs;
    assert.strictEqual(await text(diff.original), "one\n");
    assert.strictEqual(await text(diff.modified), "two\n");
  });

  it("opens every change on a branch from the Stacks view", async () => {
    repo().commit("a.txt", "one\n", "Add a", "feature");
    repo().commit("a.txt", "two\n", "Change a", "feature");
    repo().commit("b.txt", "b\n", "Add b", "feature");
    const repository = await repo().repository();
    const { provider, branch } = stacks(repository);

    const tab = await open(provider.getTreeItem(branch));

    // Compared with the branch's base, so a.txt is added rather than changed, and has no diff
    // with both sides.
    assert.strictEqual(tab.label, "feature (2 files)");
    assert.deepStrictEqual((tab.input as MultiDiffInput).textDiffs, []);
  });

  it("opens a commit's changes from the Target Branch view", async () => {
    repo().setTarget();
    const clone = `${repo().root}-clone`;
    execFileSync("git", ["clone", "-q", repo().origin, clone]);
    fs.writeFileSync(`${clone}/one.txt`, "one\n");
    execFileSync("git", ["add", "one.txt"], { cwd: clone });
    execFileSync("git", ["commit", "-q", "-m", "Upstream"], { cwd: clone });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: clone });
    repo().git("fetch", "-q", "origin");
    const repository = await repo().repository();
    const provider = new TargetProvider(() => [repository], vscode.window.createOutputChannel("GitButler Tests"));
    const [commit] = await provider.getChildren();

    const tab = await open(provider.getTreeItem(commit));

    assert.match(tab.label, /^[0-9a-f]{7} - Upstream \(1 file\)$/);
  });
});
