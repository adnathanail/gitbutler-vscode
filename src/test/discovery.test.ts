import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { activate, stubInformationMessage, waitFor } from "./helpers";

describe("discovery", () => {
  it("finds the GitButler repository in the workspace and loads its status", async () => {
    const api = await activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test window has no workspace folder");
    const [repository] = api.repositories();
    assert.ok(repository, "no repository found");
    assert.strictEqual(
      fs.realpathSync(repository.root),
      fs.realpathSync(folder.uri.fsPath),
    );
    assert.strictEqual(repository.error, undefined);
    assert.deepStrictEqual(repository.status?.stacks, []);
  });

  // GitButler's metadata appears in a folder that's already open the first time `but` runs there,
  // without any workspace event.
  it("notices GitButler's metadata appearing in an open folder", async () => {
    const api = await activate();
    const [original] = api.repositories();
    const workspace = fixtureWorkspace(api);

    try {
      await workspace.stopUsingGitButler();
      assert.strictEqual(api.repositories().length, 0);
    } finally {
      await workspace.startUsingGitButler();
    }
    assert.notStrictEqual(api.repositories()[0], original);
  });

  it("offers to disable Git on becoming a GitButler repository, and to re-enable it on stopping", async () => {
    const api = await activate();
    const folder = vscode.workspace.workspaceFolders![0];
    const workspace = fixtureWorkspace(api);
    const gitEnabled = () => vscode.workspace.getConfiguration("git", folder.uri).get<boolean>("enabled");
    // Accept whatever is suggested.
    const stub = stubInformationMessage((_message, items) => items[0]);

    try {
      // The suggestion was already shown at activation, so stop and start again to get it again.
      await workspace.stopUsingGitButler();
      await workspace.startUsingGitButler();
      await waitFor(() => gitEnabled() === false, "Git to be disabled");

      await workspace.stopUsingGitButler();
      await waitFor(() => gitEnabled() === true, "Git to be re-enabled");
      assert.strictEqual(stub.calls.length, 2);
    } finally {
      stub.restore();
      await workspace.startUsingGitButler();
      await vscode.workspace.getConfiguration("git").update("enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  // A repository in edit mode isn't shown, but still counts as managed by GitButler, so entering
  // and leaving edit mode doesn't offer to re-enable Git.
  it("hides the repository while the GitButler app is editing a commit, without prompting about Git", async () => {
    const api = await activate();
    const workspace = fixtureWorkspace(api);
    const stub = stubInformationMessage((_message, items) => items[0]);

    try {
      // Disable Git as the extension would, so no longer being a GitButler repository would offer
      // to re-enable it.
      await workspace.stopUsingGitButler();
      await workspace.startUsingGitButler();
      await waitFor(() => stub.calls.length === 1, "the suggestion to disable Git");

      await workspace.enterEditMode();
      await workspace.leaveEditMode();
      await api.repositories()[0].refresh();
      assert.strictEqual(stub.calls.length, 1);
    } finally {
      stub.restore();
      await workspace.startUsingGitButler();
      await vscode.workspace.getConfiguration("git").update("enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});

/**
 * Changes to the GitButler repository the test window opens on. Each method waits for discovery
 * to notice.
 */
function fixtureWorkspace(api: ExtensionApi) {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  const metadata = path.join(root, ".git", "gitbutler");
  const hidden = path.join(root, ".git", "gitbutler-hidden");

  const enterEditMode = async () => {
    // Edit mode checks out gitbutler/edit at the commit being edited.
    git("checkout", "-q", "-b", "gitbutler/edit", "HEAD");
    await waitFor(() => api.repositories().length === 0, "repository to be removed");
  };
  const leaveEditMode = async () => {
    git("checkout", "-q", "main");
    git("branch", "-q", "-D", "gitbutler/edit");
    if (fs.existsSync(metadata)) {
      await waitFor(() => api.repositories().length === 1, "repository to be found again");
    }
  };

  return {
    enterEditMode,
    leaveEditMode,
    /**
     * Removes GitButler's metadata, as if `but` had never run in the repository. It's removed in
     * edit mode, while the extension has no repository refreshing it, since `but status`
     * recreates it.
     */
    async stopUsingGitButler() {
      await enterEditMode();
      fs.renameSync(metadata, hidden);
      await leaveEditMode();
      // Nothing changes that a test can wait for, so wait out discovery's debounce.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    },
    /** Puts GitButler's metadata back, if it was removed, as running `but` would create it. */
    async startUsingGitButler() {
      if (git("branch", "--show-current").toString().trim() === "gitbutler/edit") {
        await leaveEditMode();
      }
      if (fs.existsSync(hidden)) {
        fs.renameSync(hidden, metadata);
      }
      await waitFor(() => api.repositories().length === 1, "repository to be found");
    },
  };
}
