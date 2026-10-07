import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { StacksProvider } from "../stacksView";
import { activate, collectErrors, stubInformationMessage, TestRepo, useTestRepo } from "./helpers";

describe("dropping changes onto a commit", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  /** A branch "feature" with commits "First" (a.txt) and "Second" (b.txt), and the Stacks view. */
  async function setUp(): Promise<StacksProvider> {
    repo().commit("a.txt", "a\n", "First", "feature");
    repo().commit("b.txt", "b\n", "Second", "feature");
    const repository = await repo().repository();
    return new StacksProvider(() => [repository]);
  }

  /** The Stacks view node for the commit with this message. */
  function commitNode(provider: StacksProvider, message: string) {
    const [branch] = provider.getChildren();
    const node = provider.getChildren(branch).find((n) => n.kind === "commit" && n.commit.message === message);
    assert.ok(node, `no commit "${message}"`);
    return node;
  }

  /** Drops files as the Source Control panel and Explorer do, failing on any error notification. */
  async function drop(provider: StacksProvider, target: Parameters<StacksProvider["handleDrop"]>[0], ...files: string[]): Promise<string[]> {
    const dataTransfer = new vscode.DataTransfer();
    const uriList = files.map((f) => vscode.Uri.file(repo().path(f)).toString()).join("\r\n");
    dataTransfer.set("text/uri-list", new vscode.DataTransferItem(uriList));
    const { errors, dispose } = collectErrors(api);
    try {
      await provider.handleDrop(target, dataTransfer);
    } finally {
      dispose();
    }
    return errors;
  }

  function commitFiles(r: TestRepo, message: string): string[] | undefined {
    const commits = r.status().stacks[0].branches[0].commits;
    return commits.find((c) => c.message === message)?.changes?.map((c) => c.filePath).sort();
  }

  it("adds the dropped files' changes to the commit", async () => {
    const provider = await setUp();
    repo().write("a.txt", "a changed\n");
    repo().write("-new.txt", "new\n");
    repo().write("c.txt", "c\n");

    const errors = await drop(provider, commitNode(provider, "First"), "a.txt", "-new.txt");

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(commitFiles(repo(), "First"), ["-new.txt", "a.txt"]);
    assert.deepStrictEqual(commitFiles(repo(), "Second"), ["b.txt"]);
    assert.deepStrictEqual(repo().status().uncommittedChanges.map((c) => c.filePath), ["c.txt"]);
    assert.strictEqual(repo().git("show", "HEAD:a.txt"), "a changed\n");
  });

  it("adds them to the commit of the file they're dropped onto", async () => {
    const provider = await setUp();
    repo().write("c.txt", "c\n");
    const [file] = provider.getChildren(commitNode(provider, "Second"));

    const errors = await drop(provider, file, "c.txt");

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(commitFiles(repo(), "Second"), ["b.txt", "c.txt"]);
  });

  it("shows an error when none of the dropped files have uncommitted changes", async () => {
    const provider = await setUp();

    const errors = await drop(provider, commitNode(provider, "First"), "b.txt");

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Only files with uncommitted changes/);
    assert.deepStrictEqual(commitFiles(repo(), "First"), ["a.txt"]);
  });

  it("explains where to drop when dropped onto a branch", async () => {
    const provider = await setUp();
    repo().write("c.txt", "c\n");
    const [branch] = provider.getChildren();

    const messages = stubInformationMessage();
    try {
      await drop(provider, branch, "c.txt");
    } finally {
      messages.restore();
    }

    assert.deepStrictEqual(messages.calls, ["Drop changes onto a commit to add them to it."]);
    assert.deepStrictEqual(repo().status().uncommittedChanges.map((c) => c.filePath), ["c.txt"]);
  });
});
