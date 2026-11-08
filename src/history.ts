import * as vscode from "vscode";
import { FileChange, run } from "./but";
import { RevisionFileSystemProvider } from "./content";
import { committedChangeUri } from "./decorations";

/** git's empty tree, the parent side of a root commit's diff. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A commit's first parent, or the empty tree for a root commit. */
export async function firstParent(root: string, log: vscode.OutputChannel, commitId: string): Promise<string> {
  const parents = await run("git", ["rev-list", "--parents", "-n", "1", commitId], root, log);
  return parents.trim().split(" ")[1] ?? EMPTY_TREE;
}

/**
 * The files a commit changed, compared with `parent` (by default its first parent, or the empty tree
 * for a root commit). Renamed files also have the path they were renamed from.
 */
export async function commitChanges(
  root: string,
  log: vscode.OutputChannel,
  commitId: string,
  parent?: string,
): Promise<{ change: FileChange; oldPath: string }[]> {
  parent ??= await firstParent(root, log, commitId);
  const output = await run("git", ["diff", "--name-status", "-z", "-M", parent, commitId], root, log);
  const fields = output.split("\0");
  const changes: { change: FileChange; oldPath: string }[] = [];
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++];
    const oldPath = fields[i++];
    // Renames and copies list the old path, then the new one.
    const filePath = status.startsWith("R") || status.startsWith("C") ? fields[i++] : oldPath;
    const changeType = status.startsWith("A")
      ? "added"
      : status.startsWith("D")
        ? "removed"
        : status.startsWith("R")
          ? "renamed"
          : "modified";
    changes.push({ change: { cliId: "", filePath, changeType }, oldPath });
  }
  return changes;
}

/**
 * Every file changed between `parent` and `commitId`, as `vscode.changes` takes them: a URI
 * decorated with the change type, then the left and right sides of its diff (undefined for an
 * added file's left and a deleted file's right).
 */
export async function changesBetween(
  root: string,
  log: vscode.OutputChannel,
  parent: string,
  commitId: string,
): Promise<[vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][]> {
  const changes = await commitChanges(root, log, commitId, parent);
  return changes.map(({ change, oldPath }) => [
    committedChangeUri(root, commitId, change),
    change.changeType === "added" ? undefined : RevisionFileSystemProvider.uri(root, oldPath, parent),
    change.changeType === "removed" ? undefined : RevisionFileSystemProvider.uri(root, change.filePath, commitId),
  ]);
}
