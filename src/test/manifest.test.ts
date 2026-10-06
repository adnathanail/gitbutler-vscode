import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate } from "./helpers";

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));

describe("manifest", () => {
  // Regression: commands named `gitbutler.*` clashed with the GitButler for IDE extension
  // (BartInTheField.gitbutler-for-ide), so VS Code refused to register them.
  it("uses the gitbutlerVscode prefix for every contributed ID", () => {
    const ids = [
      ...manifest.contributes.commands.map((c: { command: string }) => c.command),
      ...manifest.contributes.views.scm.map((v: { id: string }) => v.id),
      ...Object.keys(manifest.contributes.configuration.properties),
    ];
    for (const id of ids) {
      assert.ok(id.startsWith("gitbutlerVscode."), `${id} should start with gitbutlerVscode.`);
    }
  });

  it("registers every contributed command", async () => {
    await activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const { command } of manifest.contributes.commands) {
      assert.ok(registered.has(command), `${command} is not registered`);
    }
  });
});
