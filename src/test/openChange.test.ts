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

  it("opens the file from an uncommitted change's diff, keeping the cursor", async () => {
    repo().write("a.txt", "one\ntwo\nthree\n");
    const repository = await repo().repository();
    await repository.openUncommittedChange({ cliId: "", filePath: "a.txt", changeType: "added" });
    const diffEditor = vscode.window.activeTextEditor!;
    diffEditor.selection = new vscode.Selection(2, 1, 2, 1);

    // Called the same way the diff editor's title bar calls it.
    await vscode.commands.executeCommand("gitbutlerVscode.openFile", activeDiff()!.modified);

    assert.strictEqual(activeDiff(), undefined, "still showing a diff");
    const editor = vscode.window.activeTextEditor;
    assert.strictEqual(editor?.document.uri.toString(), vscode.Uri.file(repo().path("a.txt")).toString());
    assert.deepStrictEqual(editor.selection.active, new vscode.Position(2, 1));
  });

  it("opens the working tree file from a committed change's diff", async () => {
    repo().commit("a.txt", "one\n", "Add a", "feature");
    repo().write("a.txt", "changed since\n");
    const repository = await repo().repository();
    const commitId = repo().status().stacks[0].branches[0].commits[0].commitId;
    await repository.openCommittedChange(commitId, { cliId: "", filePath: "a.txt", changeType: "added" });

    // From the command palette, which passes no arguments.
    await vscode.commands.executeCommand("gitbutlerVscode.openFile");

    const editor = vscode.window.activeTextEditor;
    assert.strictEqual(editor?.document.uri.toString(), vscode.Uri.file(repo().path("a.txt")).toString());
    assert.strictEqual(editor.document.getText(), "changed since\n");
  });

  it("shows an error when opening a file that has since been deleted", async () => {
    repo().commit("a.txt", "one\n", "Add a", "feature");
    repo().remove("a.txt");
    const repository = await repo().repository();
    const commitId = repo().status().stacks[0].branches[0].commits[0].commitId;
    await repository.openCommittedChange(commitId, { cliId: "", filePath: "a.txt", changeType: "added" });

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.openFile", activeDiff()!.modified);
    } finally {
      dispose();
    }

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /a\.txt doesn't exist/);
  });

  it("opens the selected changes' files from the Source Control panel", async () => {
    repo().write("a.txt", "a\n");
    repo().write("b.txt", "b\n");
    const repository = await repo().repository();
    const resources = repository.unassignedGroup.resourceStates;

    const { errors, dispose } = collectErrors(api);
    try {
      // Called the same way the Source Control panel calls it, with every selected change.
      await vscode.commands.executeCommand("gitbutlerVscode.openFile", ...resources);
    } finally {
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    const open = vscode.window.tabGroups.activeTabGroup.tabs
      .map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri.fsPath : undefined))
      .sort();
    assert.deepStrictEqual(open, [repo().path("a.txt"), repo().path("b.txt")]);
  });

  // The Open File menu items are hidden for deleted files using this.
  it("gives Source Control resources their change type as context value", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    repo().remove("a.txt");
    const repository = await repo().repository();

    assert.deepStrictEqual(repository.unassignedGroup.resourceStates.map((r) => r.contextValue), ["removed"]);
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
