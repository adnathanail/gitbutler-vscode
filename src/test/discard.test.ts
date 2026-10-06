import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { activate, collectErrors, stubWarningMessage, useTestRepo } from "./helpers";

describe("discarding", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  /** Runs a command with the confirmation answered, failing on any error notification. */
  async function run(answer: string | undefined, command: string, ...args: unknown[]): Promise<string[]> {
    const prompts = stubWarningMessage(answer);
    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand(command, ...args);
    } finally {
      prompts.restore();
      dispose();
    }
    assert.deepStrictEqual(errors, []);
    return prompts.calls;
  }

  it("discards only the selected changes", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    repo().write("a.txt", "changed\n");
    repo().write("b.txt", "b\n");
    repo().write("-c.txt", "c\n");
    const repository = await repo().repository();
    const selected = repository.unassignedGroup.resourceStates.filter((r) => !r.resourceUri.fsPath.endsWith("b.txt"));

    const prompts = await run("Discard Changes", "gitbutlerVscode.discard", ...selected);

    assert.deepStrictEqual(prompts, ["Discard changes in 2 files?"]);
    assert.strictEqual(fs.readFileSync(repo().path("a.txt"), "utf8"), "a\n");
    assert.ok(!fs.existsSync(repo().path("-c.txt")), "the new file wasn't deleted");
    assert.deepStrictEqual(
      repository.unassignedGroup.resourceStates.map((r) => r.resourceUri.fsPath),
      [repo().path("b.txt")],
    );
  });

  it("restores deleted files", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    repo().remove("a.txt");
    const repository = await repo().repository();

    await run("Discard Changes", "gitbutlerVscode.discard", ...repository.unassignedGroup.resourceStates);

    assert.strictEqual(fs.readFileSync(repo().path("a.txt"), "utf8"), "a\n");
  });

  it("discards every change in a group", async () => {
    repo().write("a.txt", "a\n");
    repo().write("b.txt", "b\n");
    const repository = await repo().repository();

    await run("Discard Changes", "gitbutlerVscode.discard", repository.unassignedGroup);

    assert.deepStrictEqual(repo().status().uncommittedChanges, []);
    assert.strictEqual(repository.sourceControl.count, 0);
  });

  it("does nothing if not confirmed", async () => {
    repo().write("a.txt", "a\n");
    const repository = await repo().repository();

    const prompts = await run(undefined, "gitbutlerVscode.discard", ...repository.unassignedGroup.resourceStates);

    assert.deepStrictEqual(prompts, ["Discard changes in a.txt?"]);
    assert.ok(fs.existsSync(repo().path("a.txt")));
  });

  it("doesn't discard everything when the group is empty", async () => {
    repo().write("a.txt", "a\n");
    const repository = await repo().repository();
    const empty = { resourceStates: [] };

    const prompts = await run("Discard Changes", "gitbutlerVscode.discard", empty);

    assert.deepStrictEqual(prompts, []);
    assert.ok(fs.existsSync(repo().path("a.txt")));
    assert.strictEqual(repository.sourceControl.count, 1);
  });
});
