import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { activate } from "./helpers";

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
});
