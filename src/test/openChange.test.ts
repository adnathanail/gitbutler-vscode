import * as assert from "node:assert";
import * as vscode from "vscode";
import { RevisionFileSystemProvider } from "../content";
import type { ExtensionApi } from "../extension";
import { StacksProvider } from "../stacksView";
import { activate, activeDiff, collectErrors, useTestRepo, waitFor } from "./helpers";

describe("opening changes", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  // Regression: the Source Control panel appends a `preserveFocus` boolean to resource command
  // arguments, which was read as a commit ID ("commitId.slice is not a function").
  it("opens an uncommitted change from the Source Control panel", async () => {
    repo().write("todo.md", "hello\n");
    const repository = await repo().repository();
    const [resource] = repository.unassignedGroup.resourceStates;
    assert.ok(resource?.command, "the change has no command");

    const { errors, dispose } = collectErrors(api);
    try {
      // Called the same way the Source Control panel calls it.
      await vscode.commands.executeCommand(resource.command.command, ...resource.command.arguments!, true);
    } finally {
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    const diff = activeDiff();
    assert.ok(diff, "no diff editor opened");
    assert.strictEqual(diff.modified.fsPath, repo().path("todo.md"));
  });

  it("opens a committed change from the Stacks view", async () => {
    repo().commit("a.txt", "one\n", "Add a", "feature");
    const repository = await repo().repository();

    const provider = new StacksProvider(() => [repository]);
    const [branch] = provider.getChildren();
    const [commit] = provider.getChildren(branch);
    const [file] = provider.getChildren(commit);
    const command = provider.getTreeItem(file).command!;

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand(command.command, ...command.arguments!);
    } finally {
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    const diff = activeDiff();
    assert.ok(diff, "no diff editor opened");
    const right = await vscode.workspace.openTextDocument(diff.modified);
    assert.strictEqual(right.getText(), "one\n");
  });

  it("shows new files as empty at HEAD instead of failing", async () => {
    repo().write("new.txt", "content\n");
    const document = await vscode.workspace.openTextDocument(
      RevisionFileSystemProvider.uri(repo().root, "new.txt", "HEAD"),
    );
    assert.strictEqual(document.getText(), "");
  });

  // Regression: diffs of images failed with "ENOPRO: No file system provider found", because
  // revisions were served by a text document content provider, which the image preview can't read.
  it("serves binary files at a revision byte for byte", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe, 0x80]);
    repo().commit("image.png", bytes, "Add image", "feature");
    const commitId = repo().status().stacks[0].branches[0].commits[0].commitId;
    const uri = RevisionFileSystemProvider.uri(repo().root, "image.png", commitId);

    assert.deepStrictEqual([...(await vscode.workspace.fs.readFile(uri))], [...bytes]);
    assert.strictEqual((await vscode.workspace.fs.stat(uri)).size, bytes.length);
  });

  it("serves an empty file for the missing side of a diff", async () => {
    const uri = RevisionFileSystemProvider.uri(repo().root, "missing.png", "");
    assert.strictEqual((await vscode.workspace.fs.readFile(uri)).length, 0);
    assert.strictEqual((await vscode.workspace.fs.stat(uri)).size, 0);
  });

  it("reloads files shown at HEAD after a commit", async () => {
    repo().commit("a.txt", "one\n", "Add a", "feature");
    const repository = await repo().repository();
    const document = await vscode.workspace.openTextDocument(RevisionFileSystemProvider.uri(repo().root, "a.txt", "HEAD"));
    assert.strictEqual(document.getText(), "one\n");

    repo().commit("a.txt", "two\n", "Change a", "feature");
    await repository.refresh();
    await waitFor(() => document.getText() === "two\n", "the document to show the new HEAD contents");
  });
});
