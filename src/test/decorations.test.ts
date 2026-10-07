import * as assert from "node:assert";
import * as vscode from "vscode";
import { RevisionFileSystemProvider } from "../content";
import { ChangeDecorationProvider } from "../decorations";
import { Repository } from "../repository";
import { StacksProvider } from "../stacksView";
import { useTestRepo } from "./helpers";

describe("file decorations", () => {
  const repo = useTestRepo();
  let repository: Repository;
  let provider: ChangeDecorationProvider;
  const git = () => vscode.workspace.getConfiguration("git");

  beforeEach(async () => {
    repo().commit("modified.txt", "a\n", "Add files", "branch");
    repo().commit("removed.txt", "removed\n", "Add more files", "branch");
    repo().write("modified.txt", "b\n");
    repo().remove("removed.txt");
    repo().write("dir/added.txt", "added\n");
    repository = await repo().repository();
    provider = new ChangeDecorationProvider(() => [repository]);
  });

  afterEach(async () => {
    provider.dispose();
    await git().update("enabled", undefined, vscode.ConfigurationTarget.Workspace);
  });

  const badge = (relative: string) => provider.provideFileDecoration(vscode.Uri.file(repo().path(relative)))?.badge;

  it("shows each uncommitted file's change type when Git integration is disabled", async () => {
    await git().update("enabled", false, vscode.ConfigurationTarget.Workspace);

    assert.strictEqual(badge("dir/added.txt"), "A");
    assert.strictEqual(badge("modified.txt"), "M");
    assert.strictEqual(badge("removed.txt"), "D");
    assert.strictEqual(badge("unchanged.txt"), undefined);
  });

  // Regression: a file added by a commit and since deleted in the working tree was shown as
  // deleted (a red D) under that commit in the Stacks view, because the item used the working tree
  // file's URI, which has the uncommitted change's decoration.
  it("doesn't decorate files in the Stacks view with their uncommitted changes", async () => {
    await git().update("enabled", false, vscode.ConfigurationTarget.Workspace);
    const stacks = new StacksProvider(() => [repository]);
    const [branch] = stacks.getChildren();
    const commit = stacks.getChildren(branch).find((n) => n.kind === "commit" && n.commit.message === "Add more files")!;
    const [file] = stacks.getChildren(commit);
    const { resourceUri, description } = stacks.getTreeItem(file);

    assert.strictEqual(resourceUri?.scheme, RevisionFileSystemProvider.scheme);
    assert.strictEqual(provider.provideFileDecoration(resourceUri), undefined);
    assert.strictEqual(description, "A");
  });

  // The Git extension decorates the same files, which would show each letter twice.
  it("leaves decorations to Git when Git integration is enabled", () => {
    assert.strictEqual(git().get("enabled"), true);
    assert.strictEqual(badge("modified.txt"), undefined);
  });
});
