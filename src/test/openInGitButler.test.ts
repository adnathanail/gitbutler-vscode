import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { externalOpener } from "../but";
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

const LINK = "but://app/project/eA/workspace?stacks=branch:refs/heads/feature";

describe("opening in GitButler", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;
  let fake: Awaited<ReturnType<typeof fakeBut>> | undefined;
  /** URLs passed to the operating system's opener, which is replaced so the app doesn't launch. */
  let opened: string[];
  let openFails = false;
  const originalOpen = externalOpener.open;

  before(async () => {
    api = await activate();
  });

  beforeEach(() => {
    opened = [];
    openFails = false;
    externalOpener.open = async (url) => {
      opened.push(url);
      if (openFails) {
        throw new Error("No application knows how to open but: URLs");
      }
      return "";
    };
  });

  afterEach(async () => {
    externalOpener.open = originalOpen;
    await fake?.restore();
    fake = undefined;
  });

  // Regression: `but open` fails to open links itself with "Invalid path scheme: but", so the
  // extension gets the link with --print and opens it unchanged.
  it("opens the workspace from the Source Control title bar", async () => {
    fake = await fakeBut({ url: LINK, opened: false });
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
    assert.deepStrictEqual(args, ["open", "--print", "--json"]);
    assert.deepStrictEqual(opened, [LINK]);
  });

  it("opens a branch or commit from the Stacks view with it selected", async () => {
    repo().commit("a.txt", "a\n", "Add a", "feature");
    const repository = await repo().repository();
    const provider = new StacksProvider(() => [repository]);
    const [branch] = provider.getChildren();
    const [commit] = provider.getChildren(branch);
    assert.strictEqual(provider.getTreeItem(branch).contextValue, "branch");
    assert.strictEqual(provider.getTreeItem(commit).contextValue, "commit");
    fake = await fakeBut({ url: LINK, opened: false });

    await vscode.commands.executeCommand("gitbutlerVscode.openInGitButler", branch);
    assert.deepStrictEqual(fake.invocation().args, ["open", "--print", "--json", "feature"]);

    await vscode.commands.executeCommand("gitbutlerVscode.openInGitButler", commit);
    const changeId = repository.status!.stacks[0].branches[0].commits[0].changeId!;
    assert.deepStrictEqual(fake.invocation().args, ["open", "--print", "--json", changeId]);
    assert.deepStrictEqual(opened, [LINK, LINK]);
  });

  it("shows an error when the link can't be opened", async () => {
    fake = await fakeBut({ url: LINK, opened: false });
    openFails = true;

    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand("gitbutlerVscode.openInGitButler", api.repositories()[0].sourceControl);
    } finally {
      dispose();
    }

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /No application knows how to open/);
  });
});
