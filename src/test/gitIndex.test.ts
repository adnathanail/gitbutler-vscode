import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { activate, collectErrors, paths, useTestRepo } from "./helpers";

describe("git's index", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  it("finds changes staged in git's index", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    repo().write("a.txt", "staged\n");
    repo().write("b.txt", "b\n");
    repo().git("add", "a.txt", "b.txt");
    const repository = await repo().repository();

    assert.deepStrictEqual(repository.gitStagedPaths, ["a.txt", "b.txt"]);
  });

  // GitButler reads the index for new files: b.txt, staged and then deleted, appears as a removed
  // file although it was never committed.
  it("unstages everything in git's index without changing the working tree", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    repo().write("a.txt", "staged\n");
    repo().write("b.txt", "b\n");
    repo().git("add", "a.txt", "b.txt");
    repo().remove("b.txt");
    const repository = await repo().repository();
    assert.deepStrictEqual(paths(repository.unassignedGroup), ["a.txt", "b.txt"]);

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.unstageGit", repository);
    } finally {
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    assert.strictEqual(repo().git("diff", "--cached", "--name-only"), "");
    assert.deepStrictEqual(repository.gitStagedPaths, []);
    assert.strictEqual(fs.readFileSync(repo().path("a.txt"), "utf8"), "staged\n");
    assert.ok(!fs.existsSync(repo().path("b.txt")));
    assert.deepStrictEqual(paths(repository.unassignedGroup), ["a.txt"]);
  });

  it("stages every change in git's index, including new and deleted files", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    repo().commit("b.txt", "b\n", "Add b", "feature");
    repo().write("a.txt", "changed\n");
    repo().remove("b.txt");
    repo().write("dir/c.txt", "c\n");
    const repository = await repo().repository();

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.stageGit", repository);
    } finally {
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(repository.gitStagedPaths, ["a.txt", "b.txt", "dir/c.txt"]);
    assert.strictEqual(repo().git("diff", "--name-only"), "");
    assert.strictEqual(fs.readFileSync(repo().path("a.txt"), "utf8"), "changed\n");
  });

  it("finds nothing staged in a clean repository", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    const repository = await repo().repository();

    assert.deepStrictEqual(repository.gitStagedPaths, []);
  });
});
