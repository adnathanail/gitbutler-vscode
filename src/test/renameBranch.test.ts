import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { StacksNode, StacksProvider } from "../stacksView";
import { activate, collectErrors, stubInputBox, stubWarningMessage, useTestRepo } from "./helpers";

describe("renaming branches", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  function branchNames(): string[] {
    return repo()
      .status()
      .stacks.flatMap((s) => s.branches.map((b) => b.name));
  }

  /** The Stacks view node for the branch with this name. */
  async function branchNode(name: string): Promise<StacksNode> {
    const repository = await repo().repository();
    const stacks = new StacksProvider(() => [repository]);
    const node = stacks.getChildren().find((n) => n.kind === "branch" && n.branch.name === name);
    assert.ok(node, `no branch "${name}"`);
    return node;
  }

  /** Pushes a branch to a new bare repository, set up as its upstream. */
  function push(branch: string): void {
    const remote = `${repo().root}-origin.git`;
    fs.rmSync(remote, { recursive: true, force: true });
    repo().git("init", "-q", "--bare", remote);
    repo().git("remote", "add", "origin", remote);
    repo().git("push", "-q", "-u", "origin", branch);
  }

  /**
   * Runs Rename Branch as the Stacks view does, answering the input box with `answer` and any
   * warning with `warningAnswer`.
   */
  async function rename(
    node: StacksNode,
    answer?: string,
    warningAnswer?: string,
  ): Promise<{ inputs: vscode.InputBoxOptions[]; warnings: string[] }> {
    const input = stubInputBox(answer);
    const warning = stubWarningMessage(warningAnswer);
    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.renameBranch", node);
    } finally {
      input.restore();
      warning.restore();
      dispose();
    }
    assert.deepStrictEqual(errors, []);
    return { inputs: input.calls, warnings: warning.calls };
  }

  it("renames an unpushed branch without warning", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");

    const { inputs, warnings } = await rename(await branchNode("feature"), "renamed");

    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(inputs[0].value, "feature");
    assert.deepStrictEqual(branchNames(), ["renamed"]);
  });

  it("warns before renaming a pushed branch", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    push("feature");

    const { warnings } = await rename(await branchNode("feature"), "renamed", "Rename Branch");

    assert.deepStrictEqual(warnings, ['Branch "feature" has already been pushed']);
    assert.deepStrictEqual(branchNames(), ["renamed"]);
    assert.match(repo().git("ls-remote", "--heads", "origin"), /refs\/heads\/feature\n/);
  });

  it("does nothing if the warning is cancelled", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    push("feature");

    const { inputs } = await rename(await branchNode("feature"), "renamed", undefined);

    assert.deepStrictEqual(inputs, []);
    assert.deepStrictEqual(branchNames(), ["feature"]);
  });

  it("does nothing if the input box is cancelled", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");

    await rename(await branchNode("feature"), undefined);

    assert.deepStrictEqual(branchNames(), ["feature"]);
  });

  // Regression: renaming a branch named "zz" failed with "Ambiguous target 'zz', matches multiple
  // items", because `but reword` doesn't always read its target as a branch name.
  it("renames a branch whose name `but` can't resolve", async () => {
    repo().commit("a.txt", "a\n", "First", "zz");

    await rename(await branchNode("zz"), "renamed");

    assert.deepStrictEqual(branchNames(), ["renamed"]);
  });

  // The Rename Branch menu items are shown for branches using this.
  it("gives branches in the Stacks view a context value", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    const repository = await repo().repository();
    const stacks = new StacksProvider(() => [repository]);

    assert.strictEqual(stacks.getTreeItem(stacks.getChildren()[0]).contextValue, "branch");
  });
});
