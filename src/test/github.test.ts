import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { githubBranchUrl, githubRepoUrl } from "../github";
import { StacksNode, StacksProvider } from "../stacksView";
import { activate, collectErrors, useTestRepo } from "./helpers";

describe("GitHub URLs", () => {
  it("reads HTTPS, SCP-style and SSH remote URLs", () => {
    for (const url of [
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo",
      "https://user@github.com/owner/repo.git",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "ssh://git@github.com:22/owner/repo",
    ]) {
      assert.strictEqual(githubRepoUrl(url), "https://github.com/owner/repo", url);
    }
  });

  it("accepts GitHub Enterprise hosts as GitButler does", () => {
    assert.strictEqual(githubRepoUrl("git@github.example.com:owner/repo.git"), "https://github.example.com/owner/repo");
  });

  it("rejects other remotes", () => {
    assert.strictEqual(githubRepoUrl("git@gitlab.com:owner/repo.git"), undefined);
    assert.strictEqual(githubRepoUrl("/path/to/repo.git"), undefined);
  });

  it("keeps slashes in branch names, encoding everything else", () => {
    assert.strictEqual(
      githubBranchUrl("https://github.com/o/r", "feature/a#b"),
      "https://github.com/o/r/tree/feature/a%23b",
    );
  });
});

describe("opening branches and pull requests", () => {
  const repo = useTestRepo();
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
  });

  /** Pushes `branch` to a new bare repository as its upstream, then points `origin` at `url`. */
  function push(branch: string, url: string): void {
    const remote = `${repo().root}-origin.git`;
    repo().git("init", "-q", "--bare", remote);
    repo().git("remote", "add", "origin", remote);
    repo().git("push", "-q", "-u", "origin", branch);
    repo().git("remote", "set-url", "origin", url);
  }

  /** The Stacks view node and tree item for the only branch. */
  async function branchNode(): Promise<{ node: StacksNode; item: vscode.TreeItem }> {
    const repository = await repo().repository();
    const stacks = new StacksProvider(() => [repository]);
    const [node] = stacks.getChildren();
    assert.strictEqual(node.kind, "branch");
    return { node, item: stacks.getTreeItem(node) };
  }

  /** Runs `command` on `node` as the Stacks view does, returning the URLs opened. */
  async function open(command: string, node: StacksNode): Promise<string[]> {
    const env = vscode.env as { openExternal: unknown };
    const original = env.openExternal;
    const opened: string[] = [];
    env.openExternal = async (uri: vscode.Uri) => {
      opened.push(uri.toString(true));
      return true;
    };
    const { errors, dispose } = collectErrors(api);
    try {
      await vscode.commands.executeCommand(command, node);
    } finally {
      env.openExternal = original;
      dispose();
    }
    assert.deepStrictEqual(errors, []);
    return opened;
  }

  it("opens a branch pushed to GitHub", async () => {
    repo().commit("a.txt", "a\n", "First", "feature/a");
    push("feature/a", "git@github.com:owner/repo.git");
    const { node, item } = await branchNode();

    assert.strictEqual(item.contextValue, "branch github");
    assert.deepStrictEqual(await open("gitbutlerVscode.openBranchOnGitHub", node), [
      "https://github.com/owner/repo/tree/feature/a",
    ]);
  });

  // GitButler also counts a branch as pushed when its push remote has a branch of the same name.
  it("opens a branch pushed to GitButler's push remote without an upstream", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    const remote = `${repo().root}-origin.git`;
    repo().git("init", "-q", "--bare", remote);
    repo().git("remote", "add", "origin", remote);
    repo().git("push", "-q", "origin", "feature");
    repo().git("remote", "set-url", "origin", "https://github.com/owner/repo.git");
    repo().but("config", "push-remote", "origin");
    const { node, item } = await branchNode();

    assert.strictEqual(item.contextValue, "branch github");
    assert.deepStrictEqual(await open("gitbutlerVscode.openBranchOnGitHub", node), [
      "https://github.com/owner/repo/tree/feature",
    ]);
  });

  it("doesn't offer unpushed branches, or branches without a GitHub remote", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    assert.strictEqual((await branchNode()).item.contextValue, "branch");

    push("feature", "git@gitlab.com:owner/repo.git");
    assert.strictEqual((await branchNode()).item.contextValue, "branch");
  });

  it("opens a branch's pull request", async () => {
    repo().commit("a.txt", "a\n", "First", "feature");
    const restore = await butWithReview(7, "https://github.com/owner/repo/pull/7");
    try {
      const { node, item } = await branchNode();

      assert.strictEqual(item.contextValue, "branch review");
      assert.match(String(item.description), /#7$/);
      assert.deepStrictEqual(await open("gitbutlerVscode.openPullRequest", node), [
        "https://github.com/owner/repo/pull/7",
      ]);
    } finally {
      await restore();
    }
  });
});

/**
 * Points `gitbutlerVscode.butPath` at a script that runs the real `but`, except that `but status`
 * reports pull request `number` for every branch, and `but branch show` returns it with `url`.
 * Pull requests come from GitButler's cache, which only a forge account can fill.
 */
async function butWithReview(number: number, url: string): Promise<() => Promise<void>> {
  const realBut = execFileSync("sh", ["-c", "command -v but"], { encoding: "utf8" }).trim();
  const script = path.join(process.env.GITBUTLER_TEST_FIXTURES!, `review-but-${Date.now()}`);
  const show = JSON.stringify({
    branch: "feature",
    commitsAhead: 1,
    uncommittedFiles: [],
    reviews: [
      { number: 3, url: "https://github.com/owner/repo/pull/3", unitSymbol: "#", title: "Old", body: null, draft: false },
      { number, url, unitSymbol: "#", title: "Feature", body: null, draft: false },
    ],
  });
  fs.writeFileSync(
    script,
    `#!/bin/sh
if [ "$1" = status ]; then
  '${realBut}' "$@" | sed 's/"reviewId": null/"reviewId": "(#${number})"/'
elif [ "$1 $2" = "branch show" ]; then
  printf '%s\\n' '${show}'
else
  exec '${realBut}' "$@"
fi
`,
    { mode: 0o755 },
  );
  const config = vscode.workspace.getConfiguration("gitbutlerVscode");
  await config.update("butPath", script, vscode.ConfigurationTarget.Workspace);
  return () => Promise.resolve(config.update("butPath", undefined, vscode.ConfigurationTarget.Workspace));
}
