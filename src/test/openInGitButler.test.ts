import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { StacksProvider } from "../stacksView";
import { activate, collectErrors, useTestRepo } from "./helpers";

/**
 * Points `gitbutlerVscode.butPath` at a script that records its arguments and working directory,
 * and prints `output`, so tests don't open the real GitButler app.
 */
async function fakeBut(output: object): Promise<{ invocation(): { cwd: string; args: string[] }; restore(): Promise<void> }> {
  const script = path.join(process.env.GITBUTLER_TEST_FIXTURES!, `fake-but-${Date.now()}`);
  const record = `${script}.log`;
  fs.writeFileSync(
    script,
    `#!/bin/sh\npwd > '${record}'\nprintf '%s\\n' "$@" >> '${record}'\necho '${JSON.stringify(output)}'\n`,
    { mode: 0o755 },
  );
  const config = vscode.workspace.getConfiguration("gitbutlerVscode");
  await config.update("butPath", script, vscode.ConfigurationTarget.Workspace);
  return {
    invocation: () => {
      const [cwd, ...args] = fs.readFileSync(record, "utf8").trimEnd().split("\n");
      return { cwd, args };
    },
    restore: () => Promise.resolve(config.update("butPath", undefined, vscode.ConfigurationTarget.Workspace)),
  };
}

describe("opening in GitButler", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;
  let fake: Awaited<ReturnType<typeof fakeBut>> | undefined;

  before(async () => {
    api = await activate();
  });

  afterEach(async () => {
    await fake?.restore();
    fake = undefined;
  });

  it("opens the workspace from the Source Control title bar", async () => {
    fake = await fakeBut({ url: "but://app/project/x/workspace", opened: true });
    const [repository] = api.repositories();

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.openInGitButler", repository.sourceControl);
    } finally {
      dispose();
    }

    assert.deepStrictEqual(errors, []);
    const { cwd, args } = fake.invocation();
    assert.strictEqual(fs.realpathSync(cwd), fs.realpathSync(repository.root));
    assert.deepStrictEqual(args, ["open", "--json"]);
  });

  it("opens a branch or commit from the Stacks view with it selected", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    const repository = await repo().repository();
    const provider = new StacksProvider(() => [repository]);
    const [branch] = provider.getChildren();
    const [commit] = provider.getChildren(branch);
    assert.strictEqual(provider.getTreeItem(branch).contextValue, "branch");
    assert.strictEqual(provider.getTreeItem(commit).contextValue, "commit");
    fake = await fakeBut({ url: "but://app/project/x/workspace", opened: true });

    await vscode.commands.executeCommand("gitbutlerVscode.openInGitButler", branch);
    assert.deepStrictEqual(fake.invocation().args, ["open", "--json", "feature"]);

    await vscode.commands.executeCommand("gitbutlerVscode.openInGitButler", commit);
    const changeId = repository.status!.stacks[0].branches[0].commits[0].changeId!;
    assert.deepStrictEqual(fake.invocation().args, ["open", "--json", changeId]);
  });

  it("shows an error when GitButler doesn't open", async () => {
    fake = await fakeBut({ url: "but://app/project/x/workspace", opened: false });

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.openInGitButler", api.repositories()[0].sourceControl);
    } finally {
      dispose();
    }

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /didn't open/);
  });
});
