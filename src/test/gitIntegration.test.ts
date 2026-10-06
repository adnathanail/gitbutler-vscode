import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  DISABLE_GIT,
  DONT_ASK_AGAIN,
  isGitDisabledByExtension,
  KEEP_DISABLED,
  REENABLE_GIT,
  suggestDisablingGit,
  suggestReenablingGit,
} from "../gitIntegration";
import { activate, MemoryMemento, stubInformationMessage } from "./helpers";

describe("Git integration suggestions", () => {
  let folder: vscode.WorkspaceFolder;
  let stub: ReturnType<typeof stubInformationMessage> | undefined;

  const gitEnabled = () => vscode.workspace.getConfiguration("git", folder.uri).get<boolean>("enabled");
  const setGitEnabled = (value: boolean | undefined) =>
    vscode.workspace.getConfiguration("git").update("enabled", value, vscode.ConfigurationTarget.Workspace);

  /** Accepts the suggestion to disable Git, returning the state that records it. */
  const disableGit = async () => {
    const state = new MemoryMemento();
    const accept = stubInformationMessage(DISABLE_GIT);
    try {
      await suggestDisablingGit(folder, folder.uri, state);
    } finally {
      accept.restore();
    }
    assert.strictEqual(gitEnabled(), false);
    return state;
  };

  before(async () => {
    await activate();
    folder = vscode.workspace.workspaceFolders![0];
  });

  afterEach(async () => {
    stub?.restore();
    stub = undefined;
    await setGitEnabled(undefined);
    await vscode.workspace
      .getConfiguration("gitbutlerVscode")
      .update("suggestDisablingGit", undefined, vscode.ConfigurationTarget.Workspace);
  });

  it("disables Git for the workspace when accepted", async () => {
    stub = stubInformationMessage(DISABLE_GIT);
    await suggestDisablingGit(folder, folder.uri, new MemoryMemento());

    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(gitEnabled(), false);
  });

  it("changes nothing when dismissed", async () => {
    stub = stubInformationMessage(undefined);
    const state = new MemoryMemento();
    await suggestDisablingGit(folder, folder.uri, state);
    await suggestDisablingGit(folder, folder.uri, state);

    assert.strictEqual(stub.calls.length, 2, "dismissing should ask again next time");
    assert.strictEqual(gitEnabled(), true);
  });

  it("doesn't ask again after Don't Ask Again", async () => {
    stub = stubInformationMessage(DONT_ASK_AGAIN);
    const state = new MemoryMemento();
    await suggestDisablingGit(folder, folder.uri, state);
    await suggestDisablingGit(folder, folder.uri, state);

    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(gitEnabled(), true);
  });

  it("doesn't ask when Git is already disabled", async () => {
    await setGitEnabled(false);
    stub = stubInformationMessage(DISABLE_GIT);
    await suggestDisablingGit(folder, folder.uri, new MemoryMemento());

    assert.deepStrictEqual(stub.calls, []);
  });

  it("doesn't ask when the suggestion is turned off", async () => {
    await vscode.workspace
      .getConfiguration("gitbutlerVscode")
      .update("suggestDisablingGit", false, vscode.ConfigurationTarget.Workspace);
    stub = stubInformationMessage(DISABLE_GIT);
    await suggestDisablingGit(folder, folder.uri, new MemoryMemento());

    assert.deepStrictEqual(stub.calls, []);
    assert.strictEqual(gitEnabled(), true);
  });

  it("re-enables Git it disabled when accepted, by removing the setting", async () => {
    const state = await disableGit();
    assert.ok(isGitDisabledByExtension(folder, state));

    stub = stubInformationMessage(REENABLE_GIT);
    await suggestReenablingGit(folder, state);

    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(gitEnabled(), true);
    assert.strictEqual(vscode.workspace.getConfiguration("git", folder.uri).inspect("enabled")?.workspaceValue, undefined);
    assert.ok(!isGitDisabledByExtension(folder, state));
  });

  it("doesn't offer to re-enable Git the extension didn't disable", async () => {
    await setGitEnabled(false);
    stub = stubInformationMessage(REENABLE_GIT);
    await suggestReenablingGit(folder, new MemoryMemento());

    assert.deepStrictEqual(stub.calls, []);
    assert.strictEqual(gitEnabled(), false);
  });

  it("stops offering to re-enable Git after Keep Disabled", async () => {
    const state = await disableGit();
    stub = stubInformationMessage(KEEP_DISABLED);
    await suggestReenablingGit(folder, state);
    await suggestReenablingGit(folder, state);

    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(gitEnabled(), false);
  });

  it("forgets about Git it disabled once the user changes the setting themselves", async () => {
    const state = await disableGit();
    await setGitEnabled(true);
    stub = stubInformationMessage(REENABLE_GIT);
    await suggestReenablingGit(folder, state);

    assert.deepStrictEqual(stub.calls, []);
    assert.ok(!isGitDisabledByExtension(folder, state));
  });
});
