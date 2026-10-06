import * as assert from "node:assert";
import { useTestRepo } from "./helpers";

describe("status bar", () => {
  const repo = useTestRepo();

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
});
