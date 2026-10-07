import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { StacksNode, StacksProvider } from "../stacksView";
import { activate, collectErrors, stubInputBox, useTestRepo } from "./helpers";

describe("rewording commits", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  /** Messages on the "feature" branch, newest first. */
  function messages(): string[] {
    return repo().status().stacks[0].branches[0].commits.map((c) => c.message);
  }

  /** The Stacks view node for the commit with this message. */
  async function commitNode(message: string): Promise<StacksNode> {
    const repository = await repo().repository();
    const stacks = new StacksProvider(() => [repository]);
    const [branch] = stacks.getChildren();
    const node = stacks.getChildren(branch).find((n) => n.kind === "commit" && n.commit.message === message);
    assert.ok(node, `no commit "${message}"`);
    return node;
  }

  /** Runs Reword as the Stacks view does, answering the input box with `answer`. */
  async function reword(node: StacksNode, answer?: string): Promise<vscode.InputBoxOptions[]> {
    const input = stubInputBox(answer);
    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.reword", node);
    } finally {
      input.restore();
      dispose();
    }
    assert.deepStrictEqual(errors, []);
    return input.calls;
  }

  it("changes the message of a commit below the top of the branch", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    repo().commit("b.txt", "b\n", "Second", "feature");

    const [options] = await reword(await commitNode("First"), "-First, reworded");

    assert.strictEqual(options.value, "First");
    assert.deepStrictEqual(messages(), ["Second", "-First, reworded"]);
  });

  it("keeps the body of a multi-line message", async () => {
    repo().write("a.txt", "a\n");
    repo().but("commit", "--json", "-m", "Subject\n\nBody line", "--branch", "feature", "--", "a.txt");

    const [options] = await reword(await commitNode("Subject\n\nBody line"), "New subject");

    assert.strictEqual(options.value, "Subject");
    assert.match(options.prompt ?? "", /rest of the message is kept/);
    assert.deepStrictEqual(messages(), ["New subject\n\nBody line"]);
  });

  it("does nothing if cancelled", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    const before = repo().status().stacks[0].branches[0].commits[0].commitId;

    await reword(await commitNode("First"), undefined);

    assert.strictEqual(repo().status().stacks[0].branches[0].commits[0].commitId, before);
  });

  // The Reword menu items are shown for commits using this.
  it("gives commits in the Stacks view a context value", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    const repository = await repo().repository();
    const stacks = new StacksProvider(() => [repository]);
    const [commit] = stacks.getChildren(stacks.getChildren()[0]);

    assert.strictEqual(stacks.getTreeItem(commit).contextValue, "commit");
  });
});
