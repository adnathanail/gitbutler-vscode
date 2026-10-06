import { execFile } from "node:child_process";
import * as vscode from "vscode";

// Types for the JSON emitted by `but status -f --json` (checked against but 0.22.3).

export type ChangeType = "added" | "modified" | "removed" | "renamed";

export interface FileChange {
  /** Short ID used by `but`. Changes whenever the workspace changes, so never cache it. */
  cliId: string;
  /** Path relative to the repository root. Renames only report the new path. */
  filePath: string;
  changeType: ChangeType;
}

export interface Commit {
  cliId: string;
  /** Stable across rewrites (rebases, moves), unlike commitId. Absent on the merge base. */
  changeId?: string;
  commitId: string;
  createdAt: string;
  message: string;
  authorName: string;
  authorEmail: string;
  conflicted: boolean | null;
  reviewId: unknown;
  /** Only populated when status is run with `-f`. */
  changes: FileChange[] | null;
}

export interface Branch {
  cliId: string;
  name: string;
  /** Newest first. */
  commits: Commit[];
  upstreamCommits: Commit[];
  /** e.g. "completelyUnpushed". */
  branchStatus: string;
  reviewId: unknown;
  ci: unknown;
}

export interface Stack {
  cliId: string;
  /** Uncommitted changes assigned to this stack. */
  assignedChanges: FileChange[];
  /** Top of the stack first. */
  branches: Branch[];
}

export interface Status {
  /** Uncommitted changes not assigned to any stack. */
  uncommittedChanges: FileChange[];
  stacks: Stack[];
  mergeBase: Commit;
  upstreamState: {
    behind: number;
    latestCommit: Commit;
    lastFetched: string | null;
  };
}

export class CommandError extends Error {}

export function run(
  command: string,
  args: string[],
  cwd: string,
  log: vscode.OutputChannel,
  { logErrors = true } = {},
): Promise<string> {
  log.appendLine(`> ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr.trim() || err.message;
        if (logErrors) {
          log.appendLine(message);
        }
        reject(new CommandError(message));
      } else {
        resolve(stdout);
      }
    });
  });
}

export class But {
  constructor(
    private readonly root: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  private run(args: string[]): Promise<string> {
    const butPath = vscode.workspace.getConfiguration("gitbutlerVscode").get<string>("butPath") || "but";
    return run(butPath, args, this.root, this.log);
  }

  async status(): Promise<Status> {
    return JSON.parse(await this.run(["status", "-f", "--json"]));
  }

  /**
   * Commits the given repo-relative paths.
   *
   * Without a branch, `but` commits to the tip of the only applied stack, or creates a new branch
   * if none are applied. It errors if several stacks are applied.
   *
   * An empty branch name creates a new unstacked branch with a generated name.
   */
  async commit(message: string, paths: string[], branch?: string): Promise<void> {
    const args = ["commit", "--json", "-m", message];
    if (branch !== undefined) {
      args.push(...(branch ? ["--branch", branch] : ["--branch"]));
    }
    // Flags must come before `--`, which stops paths starting with `-` being read as flags.
    args.push("--", ...paths);
    await this.run(args);
  }
}
