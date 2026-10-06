import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { activate, collectErrors } from "./helpers";

/**
 * Points `gitbutlerVscode.butPath` at a script that records its arguments and working directory,
 * then exits with `exitCode`, so tests don't open the real GitButler app.
 */
async function fakeBut(
  exitCode = 0,
): Promise<{ invocation(): { cwd: string; args: string[] }; restore(): Promise<void> }> {
  const script = path.join(process.env.GITBUTLER_TEST_FIXTURES!, `fake-but-${Date.now()}`);
  const record = `${script}.log`;
  fs.writeFileSync(
    script,
    `#!/bin/sh\npwd > '${record}'\nprintf '%s\\n' "$@" >> '${record}'\n` +
      (exitCode ? `echo 'Error: GitButler is not installed' >&2\nexit ${exitCode}\n` : ""),
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
  let api: ExtensionApi;
  let fake: Awaited<ReturnType<typeof fakeBut>> | undefined;

  before(async () => {
    api = await activate();
  });

  afterEach(async () => {
    await fake?.restore();
    fake = undefined;
  });

  // Regression: `but open` links (`but://app/project/...`) brought GitButler to the front without
  // switching to the project. `but gui` switches to it.
  it("runs `but gui` in the repository", async () => {
    fake = await fakeBut();
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
    assert.deepStrictEqual(args, ["gui"]);
  });

  it("shows an error when GitButler can't be opened", async () => {
    fake = await fakeBut(1);

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.openInGitButler", api.repositories()[0].sourceControl);
    } finally {
      dispose();
    }

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /GitButler is not installed/);
  });
});
