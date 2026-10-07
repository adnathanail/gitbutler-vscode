import * as path from "node:path";
import * as vscode from "vscode";
import { ChangeType, FileChange } from "./but";
import { changeLetter, Repository } from "./repository";

const COLORS: Record<ChangeType, string> = {
  added: "gitbutlerVscode.addedResourceForeground",
  modified: "gitbutlerVscode.modifiedResourceForeground",
  removed: "gitbutlerVscode.deletedResourceForeground",
  renamed: "gitbutlerVscode.renamedResourceForeground",
};

/** Scheme of the URIs of files shown under commits in the Stacks view. */
const COMMITTED_CHANGE_SCHEME = "gitbutler-vscode-change";

/**
 * A URI for a file changed by a commit, for its item in the Stacks view. It gives the item the
 * file's icon, and a decoration for the commit's change rather than the working tree file's.
 */
export function committedChangeUri(root: string, commitId: string, change: FileChange): vscode.Uri {
  return vscode.Uri.file(path.join(root, change.filePath)).with({
    scheme: COMMITTED_CHANGE_SCHEME,
    query: JSON.stringify({ commitId, changeType: change.changeType }),
  });
}

/**
 * Shows the change type of uncommitted files (A/M/D/R, coloured) in the Source Control panel,
 * Explorer and editor tabs.
 *
 * VS Code's Git extension decorates the same files, so decorations are only provided where it
 * doesn't: when Git integration or its decorations are disabled, or the Git extension isn't present.
 *
 * Also shows the change type of files under commits in the Stacks view (`committedChangeUri`),
 * which the Git extension never decorates.
 */
export class ChangeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.onDidChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [this.onDidChangeEmitter];

  constructor(private readonly getRepositories: () => Repository[]) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("git.enabled") || e.affectsConfiguration("git.decorations.enabled")) {
          this.refresh();
        }
      }),
      vscode.extensions.onDidChange(() => this.refresh()),
    );
  }

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === COMMITTED_CHANGE_SCHEME) {
      const { changeType } = JSON.parse(uri.query) as { changeType: ChangeType };
      return decoration(changeType);
    }
    if (uri.scheme !== "file") {
      return undefined;
    }
    for (const repository of this.getRepositories()) {
      const relative = path.relative(repository.root, uri.fsPath);
      if (relative.startsWith("..") || path.isAbsolute(relative) || gitDecorates(repository.root)) {
        continue;
      }
      const filePath = relative.split(path.sep).join("/");
      const status = repository.status;
      const change = [...(status?.uncommittedChanges ?? []), ...(status?.stacks.flatMap((s) => s.assignedChanges) ?? [])]
        .find((c) => c.filePath === filePath);
      if (change) {
        // Deleted files aren't in the Explorer, so their folders aren't marked either, as in Git.
        return { ...decoration(change.changeType), propagate: change.changeType !== "removed" };
      }
    }
    return undefined;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function decoration(type: ChangeType): vscode.FileDecoration {
  return { badge: changeLetter(type), tooltip: humanise(type), color: new vscode.ThemeColor(COLORS[type]) };
}

/** Whether VS Code's Git extension shows its own decorations for files in the repository. */
function gitDecorates(root: string): boolean {
  if (!vscode.extensions.getExtension("vscode.git")) {
    return false;
  }
  // The Git extension reads these settings for the repository root.
  const config = vscode.workspace.getConfiguration("git", vscode.Uri.file(root));
  return config.get<boolean>("enabled") !== false && config.get<boolean>("decorations.enabled") !== false;
}

function humanise(type: ChangeType): string {
  return { added: "Added", modified: "Modified", removed: "Deleted", renamed: "Renamed" }[type];
}
