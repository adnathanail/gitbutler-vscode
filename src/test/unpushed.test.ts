import * as assert from "node:assert";
import * as vscode from "vscode";
import { StacksProvider } from "../stacksView";
import { useTestRepo } from "./helpers";

describe("unpushed commits", () => {
  const repo = useTestRepo();

  /** Each commit's subject and icon colour in the Stacks view, for the only branch. */
  async function commitIcons(): Promise<[string, string][]> {
    const repository = await repo().repository();
    const provider = new StacksProvider(() => [repository]);
    const [branch] = provider.getChildren();
    return provider.getChildren(branch).map((node) => {
      const item = provider.getTreeItem(node);
      const icon = item.iconPath as vscode.ThemeIcon;
      // `ThemeColor.id` isn't declared in `@types/vscode` 1.90.
      return [String(item.label), (icon.color as { id?: string } | undefined)?.id ?? "default"];
    });
  }

  it("marks every commit on a branch that hasn't been pushed", async () => {
    repo().setTarget();
    repo().commit("a.txt", "1\n", "A1", "feature");
    repo().commit("a.txt", "2\n", "A2", "feature");

    assert.deepStrictEqual(await commitIcons(), [
      ["A2", "disabledForeground"],
      ["A1", "disabledForeground"],
    ]);
  });

  it("marks only commits made since the branch was pushed to its upstream", async () => {
    repo().setTarget();
    repo().commit("a.txt", "1\n", "A1", "feature");
    repo().git("push", "-q", "-u", "origin", "feature");
    repo().commit("a.txt", "2\n", "A2", "feature");

    assert.deepStrictEqual(await commitIcons(), [
      ["A2", "disabledForeground"],
      ["A1", "default"],
    ]);
  });

  // GitButler also counts a branch as pushed when its push remote has a branch of the same name.
  it("compares with the push remote's branch when there's no upstream", async () => {
    repo().setTarget();
    repo().commit("a.txt", "1\n", "A1", "feature");
    repo().git("push", "-q", "origin", "feature");
    repo().but("config", "push-remote", "origin");
    repo().commit("a.txt", "2\n", "A2", "feature");

    assert.deepStrictEqual(await commitIcons(), [
      ["A2", "disabledForeground"],
      ["A1", "default"],
    ]);
  });

  it("marks nothing on a pushed branch", async () => {
    repo().setTarget();
    repo().commit("a.txt", "1\n", "A1", "feature");
    repo().git("push", "-q", "-u", "origin", "feature");

    assert.deepStrictEqual(await commitIcons(), [["A1", "default"]]);
  });
});
