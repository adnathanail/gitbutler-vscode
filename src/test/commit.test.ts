import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { activate, collectErrors, useTestRepo } from "./helpers";

describe("committing", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  it("commits only the selected changes", async () => {
    repo().write("a.txt", "a\n");
    repo().write("b.txt", "b\n");
    const repository = await repo().repository();
    const selected = repository.unassignedGroup.resourceStates.filter((r) => r.resourceUri.fsPath.endsWith("a.txt"));
    repository.sourceControl.inputBox.value = "Add a";

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.commitSelected", ...selected);
    } finally {
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    const status = repo().status();
    assert.deepStrictEqual(
      status.uncommittedChanges.map((c) => c.filePath),
      ["b.txt"],
    );
    const [commit] = status.stacks[0].branches[0].commits;
    assert.strictEqual(commit.message, "Add a");
    assert.deepStrictEqual(commit.changes?.map((c) => c.filePath), ["a.txt"]);
    assert.strictEqual(repository.sourceControl.inputBox.value, "", "the message wasn't cleared");
  });

  it("commits files whose names start with a dash", async () => {
    repo().write("-x.txt", "x\n");
    const repository = await repo().repository();
    repository.sourceControl.inputBox.value = "Add -x";

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.commitAll", repository);
    } finally {
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(repo().status().uncommittedChanges, []);
  });
});
