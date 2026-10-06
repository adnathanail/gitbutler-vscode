# GitButler for VS Code

View GitButler stacks and commit changes from VS Code, using the [`but` CLI](https://docs.gitbutler.com/cli-overview).

## Features

- **Source Control panel**: uncommitted changes, grouped by the stack they're assigned to. Click a file to diff it against the workspace.
- **Commit all**: type a message and press ⌘Enter (or the ✓ in the panel title).
- **Commit selected**: right-click one or more changes → *Commit Selected Changes*.
- **GitButler Stacks view** (in the Source Control sidebar): stacks → branches → commits → files. Click a file to see what that commit changed.

When several stacks are applied, committing asks which branch to commit to, or offers to create a new one. Changes that are all assigned to one stack go to the top of that stack without asking.

## Requirements

- `but` on your `PATH`, or set `gitbutlerVscode.butPath`.
- A repository on the `gitbutler/workspace` branch (run `but setup` first).

The built-in Git extension still shows the repository too. To hide it for GitButler repositories, set `"git.enabled": false` in the workspace settings.

## Development

```sh
npm install
npm run compile
```

Press F5 to launch an Extension Development Host. Commands run by the extension are logged to the **GitButler** output channel.

## How it works

Everything goes through `but … --json`:

| Action  | Command                                              |
| ------- | ---------------------------------------------------- |
| Status  | `but status -f --json`                               |
| Commit  | `but commit --json -m <msg> [--branch [<name>]] -- <paths>` |

Some behaviour of `but` (as of 0.22.3) the extension relies on:

- `but commit` accepts plain repo-relative paths as well as CLI IDs. Uncommitted-file CLI IDs change as the workspace changes, so the extension always passes paths.
- Flags must come before `--`, or they're treated as paths.
- `--branch` with no value creates a new branch with a generated name. A name that doesn't exist creates a new unstacked branch.
- With more than one stack applied, `but commit` requires `--branch`.
- Errors are plain text on stderr with a non-zero exit code, even with `--json`.
- `but status` writes to `.git/gitbutler/`, so the file watcher ignores `.git/` apart from `HEAD` and refs, to avoid refresh loops.
- `HEAD` is the GitButler workspace merge commit, so `git show HEAD:<path>` is the baseline for diffs of uncommitted changes.
- `renamed` changes don't report the previous path, so a rename's diff shows the new file against whatever existed at that path before.
