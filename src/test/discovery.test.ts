import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { activate, waitFor } from "./helpers";

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

  // `but setup` and `but teardown` switch branches in a folder that's already open, without any
  // workspace event.
  it("notices the workspace folder switching off and back onto the GitButler branch", async () => {
    const api = await activate();
    const [original] = api.repositories();
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });

    try {
      git("checkout", "-q", "main");
      await waitFor(() => api.repositories().length === 0, "repository to be removed");
    } finally {
      git("checkout", "-q", "gitbutler/workspace");
    }
    await waitFor(() => api.repositories().length === 1, "repository to be found again");
    assert.notStrictEqual(api.repositories()[0], original);
  });
});
