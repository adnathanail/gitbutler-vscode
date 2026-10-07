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
  /** e.g. "completelyUnpushed", meaning it has no remote tracking branch. */
  branchStatus: string;
  /** The branch's pull request from GitButler's cache, e.g. "(#10)". */
  reviewId: string | null;
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

/** A pull request (or merge request), from `but branch show --review --json`. */
export interface Review {
  number: number;
  url: string;
  /** "#" for GitHub pull requests. */
  unitSymbol: string;
  title: string;
  draft: boolean;
}

export class CommandError extends Error {}

export function run(
  command: string,
  args: string[],
  cwd: string,
  log: vscode.OutputChannel,
): Promise<string> {
  log.appendLine(`> ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr.trim() || err.message;
        log.appendLine(message);
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

  /**
   * Adds the uncommitted changes at the given repo-relative paths to a commit. Commits above it
   * are rebased onto the amended commit.
   */
  async amend(commitId: string, paths: string[]): Promise<void> {
    // Without paths, `but amend` amends every uncommitted change.
    if (paths.length === 0) {
      return;
    }
    await this.run(["amend", "--json", "--target", commitId, "--", ...paths]);
  }

  /** Changes a commit's message. Commits above it are rebased onto the new commit. */
  async reword(commitId: string, message: string): Promise<void> {
    // In `--message=` form, a message starting with `-` isn't read as a flag.
    await this.run(["reword", "--json", commitId, `--message=${message}`]);
  }

  /**
   * Renames an applied branch. If it was pushed, the remote branch keeps its old name, and the
   * renamed branch no longer tracks it.
   */
  async renameBranch(name: string, newName: string): Promise<void> {
    await this.run(["reword", "--json", await this.branchCliId(name), `--message=${newName}`]);
  }

  /**
   * Creates an empty branch, stacked on top of the applied branch `above`, or as a new stack
   * without it. An empty name gets a generated one.
   */
  async newBranch(name: string, above?: string): Promise<void> {
    const args = ["branch", "new", "--json"];
    if (above !== undefined) {
      args.push("--above", await this.branchCliId(above));
    }
    if (name) {
      // `--` stops a name starting with `-` being read as a flag.
      args.push("--", name);
    }
    await this.run(args);
  }

  /** The remote GitButler pushes branches to, unless a branch has an upstream set in git. */
  async pushRemote(): Promise<string> {
    const output: { push_remote: string } = JSON.parse(await this.run(["config", "push-remote", "--json"]));
    return output.push_remote;
  }

  /**
   * The pull requests of an applied branch, from GitButler's cache, as `but status` reports them.
   * The cache is filled by the GitButler app, `but pr` and `but status --refresh-prs`.
   */
  async reviews(branch: string): Promise<Review[]> {
    const args = ["branch", "show", "--json", "--review", await this.branchCliId(branch)];
    const output: { reviews: Review[] } = JSON.parse(await this.run(args));
    return output.reviews;
  }

  /**
   * The CLI ID of an applied branch. `but` doesn't always resolve a branch name given as a target
   * (a branch named "zz" is "ambiguous"), so branches are passed by CLI ID, looked up just
   * beforehand since CLI IDs change.
   */
  private async branchCliId(name: string): Promise<string> {
    const branch = (await this.status()).stacks.flatMap((s) => s.branches).find((b) => b.name === name);
    if (!branch) {
      throw new CommandError(`Branch '${name}' isn't applied.`);
    }
    return branch.cliId;
  }

  /**
   * Discards uncommitted changes to the given repo-relative paths, deleting new files. Recorded in
   * GitButler's oplog, so `but undo` restores them.
   */
  async discard(paths: string[]): Promise<void> {
    // Without paths, `but discard` discards every uncommitted change.
    if (paths.length === 0) {
      return;
    }
    await this.run(["discard", "--json", "--", ...paths]);
  }

  /**
   * Opens the GitButler app on this repository.
   *
   * `but open` (as of 0.22.3) produces `but://app/project/...` links, which the GitButler app of
   * the same version brings itself to the front for but doesn't navigate with. `but gui` switches
   * the app to the project.
   */
  async gui(): Promise<void> {
    await this.run(["gui"]);
  }
}
