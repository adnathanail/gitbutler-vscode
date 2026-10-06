import * as assert from "node:assert";
import * as vscode from "vscode";
import { DISABLE_GIT, DONT_ASK_AGAIN, suggestDisablingGit } from "../gitIntegration";
import { activate, MemoryMemento, stubInformationMessage } from "./helpers";

describe("suggesting disabling Git", () => {
  let folder: vscode.WorkspaceFolder;
  let stub: ReturnType<typeof stubInformationMessage> | undefined;

  const gitEnabled = () => vscode.workspace.getConfiguration("git", folder.uri).get<boolean>("enabled");

  before(async () => {
    await activate();
    folder = vscode.workspace.workspaceFolders![0];
  });

  afterEach(async () => {
    stub?.restore();
    stub = undefined;
    await vscode.workspace.getConfiguration("git").update("enabled", undefined, vscode.ConfigurationTarget.Workspace);
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
    await vscode.workspace.getConfiguration("git").update("enabled", false, vscode.ConfigurationTarget.Workspace);
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
});
