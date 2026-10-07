import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { activate, collectErrors, stubInputBox, stubQuickPick, useTestRepo } from "./helpers";

describe("creating branches", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  /** Branch names of each applied stack, top first. */
  function stacks(): string[][] {
    return repo()
      .status()
      .stacks.map((s) => s.branches.map((b) => b.name));
  }

  /**
   * Runs New Branch as the Stacks view's title bar does, answering the input box with `name` and
   * the quick picks with `picks`. Returns the labels each quick pick showed.
   */
  async function newBranch(name: string | undefined, ...picks: string[]): Promise<string[][]> {
    const repository = await repo().repository();
    const input = stubInputBox(name);
    const quickPick = stubQuickPick(...picks);
    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.newBranch", repository);
    } finally {
      input.restore();
      quickPick.restore();
      dispose();
    }
    assert.deepStrictEqual(errors, []);
    return quickPick.calls;
  }

  it("creates an independent branch as a new stack", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");

    const calls = await newBranch("other", "Independent Branch");

    assert.deepStrictEqual(calls, [["Independent Branch", "Dependent Branch"]]);
    assert.deepStrictEqual(stacks().sort(), [["feature"], ["other"]]);
  });

  it("creates a dependent branch on top of a stack, asking which even when there's only one", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");

    const calls = await newBranch("dependent", "Dependent Branch", "feature");

    assert.deepStrictEqual(calls, [["Independent Branch", "Dependent Branch"], ["feature"]]);
    assert.deepStrictEqual(stacks(), [["dependent", "feature"]]);
  });

  it("adds a dependent branch to the top of the chosen stack of several branches", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    repo().but("branch", "new", "--json", "--above", "feature", "middle");
    repo().commit("b.txt", "b\n", "Other", "other");

    const calls = await newBranch("top", "Dependent Branch", "middle");

    assert.deepStrictEqual(calls[1].sort(), ["middle", "other"]);
    assert.deepStrictEqual(stacks().sort(), [["other"], ["top", "middle", "feature"]]);
  });

  it("only offers an independent branch when no stacks are applied", async () => {
    const calls = await newBranch("first", "Independent Branch");

    assert.deepStrictEqual(calls, [["Independent Branch"]]);
    assert.deepStrictEqual(stacks(), [["first"]]);
  });

  it("generates a name when none is given", async () => {
    await newBranch("", "Independent Branch");

    assert.strictEqual(stacks().length, 1);
    assert.ok(stacks()[0][0]);
  });

  it("does nothing if the name is cancelled", async () => {
    const calls = await newBranch(undefined);

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(stacks(), []);
  });

  it("does nothing if the branch type is cancelled", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");

    await newBranch("other");

    assert.deepStrictEqual(stacks(), [["feature"]]);
  });

  it("does nothing if the stack is cancelled", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");

    await newBranch("other", "Dependent Branch");

    assert.deepStrictEqual(stacks(), [["feature"]]);
  });
});
