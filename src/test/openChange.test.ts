import * as assert from "node:assert";
import * as vscode from "vscode";
import { RevisionContentProvider } from "../content";
import type { ExtensionApi } from "../extension";
import { StacksProvider } from "../stacksView";
import { activate, activeDiff, collectErrors, useTestRepo } from "./helpers";

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
      RevisionContentProvider.uri(repo().root, "new.txt", "HEAD"),
    );
    assert.strictEqual(document.getText(), "");
  });
});
