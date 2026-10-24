import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Repository } from "../repository";
import { PAGE_SIZE, TargetNode, TargetProvider } from "../targetView";
import { activeDiff, useTestRepo } from "./helpers";

describe("Target Branch view", () => {
  const repo = useTestRepo();
  const log = vscode.window.createOutputChannel("GitButler Tests");

  /** Commits files to `main` on `origin` from another clone, then fetches them. */
  function pushToMain(...commits: { file: string; message: string }[]): void {
    const clone = `${repo().root}-clone`;
    execFileSync("git", ["clone", "-q", repo().origin, clone]);
    for (const { file, message } of commits) {
      fs.writeFileSync(`${clone}/${file}`, `${message}\n`);
      execFileSync("git", ["add", file], { cwd: clone });
      execFileSync("git", ["commit", "-q", "-m", message], { cwd: clone });
    }
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: clone });
    repo().git("fetch", "-q", "origin");
  }

  async function children(repository: Repository, node?: TargetNode) {
    const provider = new TargetProvider(() => [repository], log);
    return { provider, nodes: await provider.getChildren(node) };
  }

  function labels(provider: TargetProvider, nodes: TargetNode[]): string[] {
    return nodes.map((node) => String(provider.getTreeItem(node).label));
  }

  it("lists the target's commits newest first, marking ones not in the workspace yet", async () => {
    repo().setTarget();
    repo().commit("a.txt", "a\n", "A1", "stack-a");
    pushToMain({ file: "one.txt", message: "Upstream 1" }, { file: "two.txt", message: "Upstream 2" });
    const repository = await repo().repository();

    const { provider, nodes } = await children(repository);

    // Commits on applied branches aren't on the target.
    assert.deepStrictEqual(labels(provider, nodes), ["Upstream 2", "Upstream 1", "Initial commit"]);
    const upstream = nodes.map((node) => node.kind === "commit" && node.commit.upstream);
    assert.deepStrictEqual(upstream, [true, true, false]);
    assert.strictEqual((provider.getTreeItem(nodes[0]).iconPath as vscode.ThemeIcon).id, "cloud-download");
    assert.strictEqual((provider.getTreeItem(nodes[2]).iconPath as vscode.ThemeIcon).id, "git-commit");
  });

  it("lists a commit's files, which open the commit's diff", async () => {
    repo().setTarget();
    pushToMain({ file: "one.txt", message: "Upstream 1" });
    const repository = await repo().repository();
    const { provider, nodes } = await children(repository);

    const files = await provider.getChildren(nodes[0]);

    assert.deepStrictEqual(labels(provider, files), ["one.txt"]);
    const command = provider.getTreeItem(files[0]).command!;
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    const diff = activeDiff();
    assert.ok(diff, "a diff should be open");
    assert.strictEqual(new TextDecoder().decode(await vscode.workspace.fs.readFile(diff.modified)), "Upstream 1\n");
  });

  it("shows more commits on Load More", async () => {
    repo().setTarget();
    pushToMain(...Array.from({ length: PAGE_SIZE }, (_, i) => ({ file: `${i}.txt`, message: `Upstream ${i}` })));
    const repository = await repo().repository();
    const { provider, nodes } = await children(repository);

    assert.strictEqual(nodes.length, PAGE_SIZE + 1);
    const more = nodes[PAGE_SIZE];
    assert.strictEqual(more.kind, "more");
    const command = provider.getTreeItem(more).command!;
    provider.loadMore(command.arguments![0]);

    const after = await provider.getChildren();
    // Every commit, including the initial one, and no Load More.
    assert.strictEqual(after.length, PAGE_SIZE + 1);
    assert.ok(after.every((node) => node.kind === "commit"));
    assert.strictEqual(String(provider.getTreeItem(after[PAGE_SIZE]).label), "Initial commit");
  });

  it("shows new commits on the target after a refresh", async () => {
    repo().setTarget();
    const repository = await repo().repository();
    const { provider } = await children(repository);
    assert.deepStrictEqual(labels(provider, await provider.getChildren()), ["Initial commit"]);

    pushToMain({ file: "one.txt", message: "Upstream 1" });
    await repository.refresh();

    assert.deepStrictEqual(labels(provider, await provider.getChildren()), ["Upstream 1", "Initial commit"]);
  });
});
