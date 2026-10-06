import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * A read-only file system serving file contents at a git revision, for the sides of diffs and the
 * gutter change markers.
 *
 * URIs look like `gitbutler-vscode-rev:/abs/path/to/file?{"root":...,"ref":...}`. An empty ref, or a
 * path that doesn't exist at the ref, gives an empty file, which is what added and removed files
 * need on one side of their diff.
 *
 * It's a file system rather than a text document content provider so that non-text editors, such
 * as the image preview, can read it, and so contents are served as raw bytes.
 */
export class RevisionFileSystemProvider implements vscode.FileSystemProvider {
  static readonly scheme = "gitbutler-vscode-rev";

  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  /** URIs served with a ref that moves (e.g. HEAD), by repository root. */
  private readonly movingRefUris = new Map<string, Map<string, vscode.Uri>>();
  /** Bumped when a repository changes, so files at moving refs get a new modification time. */
  private readonly generations = new Map<string, number>();

  static uri(root: string, relativePath: string, ref: string): vscode.Uri {
    return vscode.Uri.file(path.join(root, relativePath)).with({
      scheme: RevisionFileSystemProvider.scheme,
      query: JSON.stringify({ root, ref }),
    });
  }

  /**
   * Tells editors showing files at moving refs in the repository to reload them, e.g. after a
   * commit changes what HEAD points to. Files at commit IDs never change.
   */
  repositoryChanged(root: string): void {
    this.generations.set(root, (this.generations.get(root) ?? 0) + 1);
    const uris = [...(this.movingRefUris.get(root)?.values() ?? [])];
    if (uris.length > 0) {
      this.onDidChangeFileEmitter.fire(uris.map((uri) => ({ type: vscode.FileChangeType.Changed, uri })));
    }
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { root, ref, relativePath } = parse(uri);
    let size = 0;
    if (ref) {
      try {
        size = Number((await git(root, ["cat-file", "-s", `${ref}:${relativePath}`])).toString().trim());
      } catch {
        // The file doesn't exist at this revision.
      }
    }
    const mtime = this.track(uri, root, ref);
    return { type: vscode.FileType.File, ctime: 0, mtime, size, permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { root, ref, relativePath } = parse(uri);
    this.track(uri, root, ref);
    if (!ref) {
      return new Uint8Array();
    }
    try {
      return await git(root, ["show", `${ref}:${relativePath}`]);
    } catch {
      // The file doesn't exist at this revision, e.g. it's newly added.
      return new Uint8Array();
    }
  }

  /** Records URIs at moving refs, and returns the modification time to report for the URI. */
  private track(uri: vscode.Uri, root: string, ref: string): number {
    if (!ref || /^[0-9a-f]{40}$/.test(ref) || /^[0-9a-f]{40}\^$/.test(ref)) {
      return 0;
    }
    let uris = this.movingRefUris.get(root);
    if (!uris) {
      uris = new Map();
      this.movingRefUris.set(root, uris);
    }
    uris.set(uri.toString(), uri);
    return this.generations.get(root) ?? 0;
  }

  watch(): vscode.Disposable {
    // Changes are reported through repositoryChanged instead.
    return new vscode.Disposable(() => {});
  }

  readDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  dispose(): void {
    this.onDidChangeFileEmitter.dispose();
  }
}

function parse(uri: vscode.Uri): { root: string; ref: string; relativePath: string } {
  const { root, ref } = JSON.parse(uri.query) as { root: string; ref: string };
  const relativePath = path.relative(root, uri.fsPath).split(path.sep).join("/");
  return { root, ref, relativePath };
}

/** Runs git, returning its raw output so binary files aren't corrupted by decoding. */
function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}
