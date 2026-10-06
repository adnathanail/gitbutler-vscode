import * as path from "node:path";
import * as vscode from "vscode";
import { run } from "./but";

/**
 * Serves file contents at a git revision, for the left (or right) side of diffs.
 *
 * URIs look like `gitbutler-vscode-rev:/abs/path/to/file?{"root":...,"ref":...}`. An empty ref, or a path
 * that doesn't exist at the ref, gives an empty document, which is what added and removed files
 * need on one side of their diff.
 */
export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "gitbutler-vscode-rev";

  constructor(private readonly log: vscode.OutputChannel) {}

  static uri(root: string, relativePath: string, ref: string): vscode.Uri {
    return vscode.Uri.file(path.join(root, relativePath)).with({
      scheme: RevisionContentProvider.scheme,
      query: JSON.stringify({ root, ref }),
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref } = JSON.parse(uri.query) as { root: string; ref: string };
    if (!ref) {
      return "";
    }
    const relativePath = path.relative(root, uri.fsPath).split(path.sep).join("/");
    try {
      return await run("git", ["show", `${ref}:${relativePath}`], root, this.log, { logErrors: false });
    } catch {
      // The file doesn't exist at this revision, e.g. it's newly added.
      return "";
    }
  }
}
