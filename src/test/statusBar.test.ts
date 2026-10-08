import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { activate, collectErrors, useTestRepo } from "./helpers";

describe("status bar", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  it("lists applied branches, each stack's from top to bottom, then stacks left to right", async () => {
    repo().commit("a.txt", "a", "Add a", "first-bottom");
    repo().but("branch", "new", "--above", "first-bottom", "first-top", "--json");
    repo().commit("b.txt", "b", "Add b", "second");
    const repository = await repo().repository();

    // GitButler puts new stacks on the left.
    const [command] = repository.sourceControl.statusBarCommands ?? [];
    assert.strictEqual(command?.title, "$(gitbutler-vscode-logo) second | first-top, first-bottom");
    assert.strictEqual(command.command, "gitbutlerVscode.openInGitButler");
    assert.deepStrictEqual(command.arguments, [repository.sourceControl]);
  });

  it("says when no branches are applied", async () => {
    const repository = await repo().repository();

    assert.strictEqual(repository.sourceControl.statusBarCommands?.[0]?.title, "$(gitbutler-vscode-logo) No branches");
  });

  it("links to the repository on GitHub, left of the branches, when the target's remote is there", async () => {
    repo().setTarget("git@github.com:owner/repo.git");
    const repository = await repo().repository();

    const [github, branches] = repository.sourceControl.statusBarCommands ?? [];
    assert.strictEqual(github?.title, "$(github) repo");
    assert.strictEqual(github.command, "gitbutlerVscode.openRepositoryOnGitHub");
    assert.deepStrictEqual(github.arguments, [repository.sourceControl]);
    assert.strictEqual(branches?.command, "gitbutlerVscode.openInGitButler");

    const env = vscode.env as { openExternal: unknown };
    const original = env.openExternal;
    const opened: string[] = [];
    env.openExternal = async (uri: vscode.Uri) => {
      opened.push(uri.toString(true));
      return true;
    };
    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.openRepositoryOnGitHub", repository);
    } finally {
      env.openExternal = original;
      dispose();
    }
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(opened, ["https://github.com/owner/repo"]);
  });

  it("doesn't link to GitHub when the target's remote is elsewhere", async () => {
    repo().setTarget("git@gitlab.com:owner/repo.git");
    const repository = await repo().repository();

    assert.deepStrictEqual(
      repository.sourceControl.statusBarCommands?.map((c) => c.command),
      ["gitbutlerVscode.openInGitButler"],
    );
  });
});
