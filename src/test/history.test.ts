import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { changesBetween } from "../history";
import { useTestRepo } from "./helpers";

describe("Commit changes", () => {
  const repo = useTestRepo();

  it("lists a commit's changes with both sides of each diff", async () => {
    repo().commit("keep.txt", "keep\n", "Add files", "stack-a");
    repo().commit("old.txt", "same content for the rename\n", "Add old", "stack-a");
    repo().commit("gone.txt", "gone\n", "Add gone", "stack-a");
    repo().write("keep.txt", "changed\n");
    repo().write("new.txt", "new\n");
    repo().remove("gone.txt");
    fs.renameSync(repo().path("old.txt"), repo().path("renamed.txt"));
    repo().but("commit", "--json", "-m", "Change files", "--branch", "stack-a");
    const { root } = await repo().repository();
    const commitId = repo().git("rev-parse", "stack-a").trim();
    const parent = repo().git("rev-parse", "stack-a^").trim();
    const log = vscode.window.createOutputChannel("test");

    const changes = await changesBetween(root, log, parent, commitId);

    log.dispose();
    const rel = (uri: vscode.Uri | undefined) =>
      uri && vscode.workspace.asRelativePath(uri.with({ scheme: "file", query: "" }), false);
    const summary = changes
      .map(([uri, left, right]) => [rel(uri), JSON.parse(uri.query).changeType, rel(left), rel(right)])
      .sort();
    const file = (p: string) => rel(vscode.Uri.file(`${root}/${p}`));
    assert.deepStrictEqual(summary, [
      [file("gone.txt"), "removed", file("gone.txt"), undefined],
      [file("keep.txt"), "modified", file("keep.txt"), file("keep.txt")],
      [file("new.txt"), "added", undefined, file("new.txt")],
      [file("renamed.txt"), "renamed", file("old.txt"), file("renamed.txt")],
    ]);
    const [, left, right] = changes.find(([uri]) => uri.path.endsWith("/keep.txt"))!;
    const read = async (uri: vscode.Uri) => Buffer.from(await vscode.workspace.fs.readFile(uri)).toString();
    assert.strictEqual(await read(left!), "keep\n");
    assert.strictEqual(await read(right!), "changed\n");
  });
});
