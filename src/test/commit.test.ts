import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { activate, collectErrors, paths, resource, useTestRepo } from "./helpers";

describe("committing", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  async function run(command: string, ...args: unknown[]): Promise<void> {
    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand(command, ...args);
    } finally {
      dispose();
    }
    assert.deepStrictEqual(errors, []);
  }

  it("commits only the staged changes", async () => {
    repo().write("a.txt", "a\n");
    repo().write("b.txt", "b\n");
    const repository = await repo().repository();
    // As the Source Control panel calls it, with the selected changes.
    await run("gitbutlerVscode.stage", resource(repository.unassignedGroup, "a.txt"));
    assert.strictEqual(repository.sourceControl.inputBox.placeholder, "Message (⌘Enter to commit staged changes)");
    repository.sourceControl.inputBox.value = "Add a";

    // As the input box calls it.
    await run("gitbutlerVscode.commit", repository);

    const status = repo().status();
    assert.deepStrictEqual(
      status.uncommittedChanges.map((c) => c.filePath),
      ["b.txt"],
    );
    const [added] = status.stacks[0].branches[0].commits;
    assert.strictEqual(added.message, "Add a");
    assert.deepStrictEqual(added.changes?.map((c) => c.filePath), ["a.txt"]);
    assert.strictEqual(repository.sourceControl.inputBox.value, "", "the message wasn't cleared");
    assert.deepStrictEqual(repository.stagedPaths, []);
    assert.strictEqual(repository.sourceControl.inputBox.placeholder, "Message (⌘Enter to commit all changes)");
  });

  it("commits every change when none are staged", async () => {
    repo().write("a.txt", "a\n");
    repo().write("b.txt", "b\n");
    const repository = await repo().repository();
    repository.sourceControl.inputBox.value = "Add files";

    await run("gitbutlerVscode.commit", repository);

    assert.deepStrictEqual(repo().status().uncommittedChanges, []);
  });

  it("moves staged changes from their group to Staged Changes, and back when unstaged", async () => {
    repo().write("a.txt", "a\n");
    repo().write("b.txt", "b\n");
    repo().write("c.txt", "c\n");
    const repository = await repo().repository();
    const { stagedGroup, unassignedGroup } = repository;

    await run("gitbutlerVscode.stage", resource(unassignedGroup, "a.txt"), resource(unassignedGroup, "b.txt"));
    assert.deepStrictEqual(paths(stagedGroup), ["a.txt", "b.txt"]);
    assert.deepStrictEqual(paths(unassignedGroup), ["c.txt"]);

    await run("gitbutlerVscode.unstage", resource(stagedGroup, "a.txt"));
    assert.deepStrictEqual(paths(stagedGroup), ["b.txt"]);
    assert.deepStrictEqual(paths(unassignedGroup), ["a.txt", "c.txt"]);
  });

  it("stages and unstages every change in a group", async () => {
    repo().write("a.txt", "a\n");
    repo().write("b.txt", "b\n");
    const repository = await repo().repository();

    // As a group header's buttons call them, with the group.
    await run("gitbutlerVscode.stage", repository.unassignedGroup);
    assert.deepStrictEqual(repository.stagedPaths, ["a.txt", "b.txt"]);
    assert.deepStrictEqual(paths(repository.unassignedGroup), []);

    await run("gitbutlerVscode.unstage", repository.stagedGroup);
    assert.deepStrictEqual(repository.stagedPaths, []);
  });

  it("forgets staged changes that no longer exist", async () => {
    repo().write("a.txt", "a\n");
    const repository = await repo().repository();
    await run("gitbutlerVscode.stage", resource(repository.unassignedGroup, "a.txt"));

    repo().remove("a.txt");
    await repository.refresh();
    repo().write("a.txt", "a\n");
    await repository.refresh();

    assert.deepStrictEqual(repository.stagedPaths, []);
    assert.deepStrictEqual(paths(repository.unassignedGroup), ["a.txt"]);
  });

  it("commits files whose names start with a dash", async () => {
    repo().write("-x.txt", "x\n");
    const repository = await repo().repository();
    repository.sourceControl.inputBox.value = "Add -x";

    await run("gitbutlerVscode.commit", repository);

    assert.deepStrictEqual(repo().status().uncommittedChanges, []);
  });
});
