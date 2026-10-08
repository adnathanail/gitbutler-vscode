import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { HistoryProvider } from "../history";
import { useTestRepo } from "./helpers";

describe("Source Control Graph", () => {
  const repo = useTestRepo();
  const token = new vscode.CancellationTokenSource().token;

  /** History as the graph asks for it by default: from the current, remote and base refs. */
  async function history(provider: HistoryProvider, options: vscode.SourceControlHistoryOptions = {}) {
    const refs = [provider.currentHistoryItemRef, provider.currentHistoryItemRemoteRef, provider.currentHistoryItemBaseRef]
      .filter((ref) => ref !== undefined)
      .map((ref) => ref.revision ?? ref.id);
    return provider.provideHistoryItems({ historyItemRefs: refs, ...options }, token);
  }

  /** Commits a file to `main` on `origin` from another clone, then fetches it. */
  function pushToMain(file: string, message: string): void {
    const clone = `${repo().root}-clone`;
    execFileSync("git", ["clone", "-q", repo().origin, clone]);
    fs.writeFileSync(`${clone}/${file}`, `${file}\n`);
    execFileSync("git", ["add", file], { cwd: clone });
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: clone });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: clone });
    repo().git("fetch", "-q", "origin");
  }

  it("is the Source Control panel's history provider", async () => {
    const repository = await repo().repository();

    assert.strictEqual(repository.sourceControl.historyProvider, repository.history);
  });

  it("shows the applied stacks and the target, without the workspace commit", async () => {
    repo().setTarget();
    repo().commit("a.txt", "a\n", "A1", "stack-a");
    repo().commit("a2.txt", "a\n", "A2", "stack-a");
    repo().commit("b.txt", "b\n", "B1", "stack-b");
    const { history: provider } = await repo().repository();

    const items = await history(provider);

    const subjects = items.map((item) => item.subject);
    assert.ok(!subjects.includes("GitButler Workspace Commit"), subjects.join(", "));
    assert.deepStrictEqual([...subjects].sort(), ["A1", "A2", "B1", "Initial commit"]);
    const byId = new Map(items.map((item) => [item.subject, item]));
    const initial = byId.get("Initial commit")!;
    assert.deepStrictEqual(byId.get("A1")!.parentIds, [initial.id]);
    assert.deepStrictEqual(byId.get("B1")!.parentIds, [initial.id]);
    assert.deepStrictEqual(byId.get("A2")!.parentIds, [byId.get("A1")!.id]);
    assert.deepStrictEqual(byId.get("A2")!.references?.map((r) => r.name), ["stack-a"]);
    assert.deepStrictEqual(initial.references?.map((r) => r.name), ["origin/main"]);
    assert.strictEqual(provider.currentHistoryItemRemoteRef?.name, "origin/main");
  });

  it("shows commits on the target that aren't applied yet, and where they branch off", async () => {
    repo().setTarget();
    repo().commit("a.txt", "a\n", "A1", "stack-a");
    const base = repo().git("rev-parse", "origin/main").trim();
    pushToMain("upstream.txt", "Upstream");
    const { history: provider } = await repo().repository();

    const subjects = (await history(provider)).map((item) => item.subject);

    assert.ok(subjects.includes("Upstream"), subjects.join(", "));
    assert.ok(subjects.includes("A1"), subjects.join(", "));
    const current = provider.currentHistoryItemRef!;
    assert.strictEqual(await provider.resolveHistoryItemRefsCommonAncestor([current.name]), base);
    assert.strictEqual(
      await provider.resolveHistoryItemRefsCommonAncestor([current.name, provider.currentHistoryItemRemoteRef!.name]),
      base,
    );
  });

  it("pages through history", async () => {
    repo().commit("a.txt", "a\n", "A1", "stack-a");
    repo().commit("a2.txt", "a\n", "A2", "stack-a");
    repo().commit("a3.txt", "a\n", "A3", "stack-a");
    const { history: provider } = await repo().repository();

    const first = await history(provider, { limit: 2 });
    const rest = await history(provider, { limit: 2, skip: 2 });

    assert.deepStrictEqual(first.map((item) => item.subject), ["A3", "A2"]);
    assert.deepStrictEqual(rest.map((item) => item.subject), ["A1", "Initial commit"]);
  });

  it("finds commits by message", async () => {
    repo().commit("a.txt", "a\n", "Add apples", "stack-a");
    repo().commit("b.txt", "b\n", "Add bananas", "stack-a");
    const { history: provider } = await repo().repository();

    const items = await history(provider, { filterText: "BANANAS" });

    assert.deepStrictEqual(items.map((item) => item.subject), ["Add bananas"]);
  });

  it("lists a commit's changes with both sides of each diff", async () => {
    repo().commit("keep.txt", "keep\n", "Add files", "stack-a");
    repo().commit("old.txt", "same content for the rename\n", "Add old", "stack-a");
    repo().commit("gone.txt", "gone\n", "Add gone", "stack-a");
    repo().write("keep.txt", "changed\n");
    repo().write("new.txt", "new\n");
    repo().remove("gone.txt");
    fs.renameSync(repo().path("old.txt"), repo().path("renamed.txt"));
    repo().but("commit", "--json", "-m", "Change files", "--branch", "stack-a");
    const { history: provider, root } = await repo().repository();
    const [commit] = await history(provider, { limit: 1 });
    assert.strictEqual(commit.subject, "Change files");

    const changes = await provider.provideHistoryItemChanges(commit.id, commit.parentIds[0]);

    const summary = changes
      .map((c) => [
        vscode.workspace.asRelativePath(c.uri.with({ scheme: "file", query: "" }), false),
        JSON.parse(c.uri.query).changeType,
        c.originalUri && vscode.workspace.asRelativePath(c.originalUri.with({ scheme: "file", query: "" }), false),
        c.modifiedUri && vscode.workspace.asRelativePath(c.modifiedUri.with({ scheme: "file", query: "" }), false),
      ])
      .sort();
    const rel = (p: string) => vscode.workspace.asRelativePath(vscode.Uri.file(`${root}/${p}`), false);
    assert.deepStrictEqual(summary, [
      [rel("gone.txt"), "removed", rel("gone.txt"), undefined],
      [rel("keep.txt"), "modified", rel("keep.txt"), rel("keep.txt")],
      [rel("new.txt"), "added", undefined, rel("new.txt")],
      [rel("renamed.txt"), "renamed", rel("old.txt"), rel("renamed.txt")],
    ]);
    const keep = changes.find((c) => c.uri.path.endsWith("/keep.txt"))!;
    const read = async (uri: vscode.Uri) => Buffer.from(await vscode.workspace.fs.readFile(uri)).toString();
    assert.strictEqual(await read(keep.originalUri!), "keep\n");
    assert.strictEqual(await read(keep.modifiedUri!), "changed\n");
  });

  it("tells the graph when branches move", async () => {
    repo().commit("a.txt", "a\n", "A1", "stack-a");
    const repository = await repo().repository();
    const events: vscode.SourceControlHistoryItemRefsChangeEvent[] = [];
    let currentChanges = 0;
    const subscriptions = [
      repository.history.onDidChangeHistoryItemRefs((e) => events.push(e)),
      repository.history.onDidChangeCurrentHistoryItemRefs(() => currentChanges++),
    ];
    try {
      repo().commit("a2.txt", "a\n", "A2", "stack-a");
      await repository.refresh();
    } finally {
      subscriptions.forEach((s) => s.dispose());
    }

    assert.ok(currentChanges > 0);
    assert.ok(events.some((e) => e.modified.some((ref) => ref.name === "stack-a")));
  });
});
