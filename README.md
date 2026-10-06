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

VS Code's built-in Git integration also shows the repository, and committing with it on the `gitbutler/workspace` branch bypasses GitButler. When the extension finds a GitButler repository with Git integration enabled, it offers to disable it by setting `"git.enabled": false` in the workspace settings (or the folder's settings, in a multi-root workspace). To stop this suggestion everywhere, set `gitbutlerVscode.suggestDisablingGit` to `false`.

The extension looks for GitButler repositories when it starts, when workspace folders are added or removed, and when a repository's `.git/HEAD` changes, for example after `but setup` or `but teardown` in an open folder.

## Development

```sh
npm install
npm run compile
```

Press F5 to launch an Extension Development Host with the debugger attached, using the **Debug Extension (IPv4)** configuration. Close the window it opens before pressing F5 again, because only one can use its debug port at a time. Commands run by the extension are logged to the **GitButler** output channel.

The standard **Run Extension** configuration is also available. If it fails with "Extension host did not start in 10 seconds", the debugger is trying to connect over IPv6 (`::1`) while the extension host only listens on `127.0.0.1`. This is [a js-debug bug](https://github.com/microsoft/vscode-js-debug/issues/2416), fixed in VS Code 1.140.0. On older versions, use **Debug Extension (IPv4)** instead, or run without debugging (⌃F5).

## Tests

```sh
npm test
```

Tests run inside a separate copy of VS Code, downloaded to `.vscode-test/` on the first run, using real `but` and git. To run only some tests, pass `--grep`, e.g. `npx vscode-test --grep committing` (compile first with `npm run compile`).

`.vscode-test.mjs` sets up each run:

- `HOME` points at `.vscode-test/fixtures/home`, so `but setup` registers test repositories in a throwaway GitButler project list, never the real one.
- The window opens on a fresh GitButler repository in `.vscode-test/fixtures/workspace`, for testing discovery.

Tests that change repository state use `useTestRepo()` from `src/test/helpers.ts`, which gives each test its own fresh GitButler repository. `collectErrors(api)` captures error notifications the extension shows, so a test can assert that none appeared.

### Adding a regression test

1. Reproduce the bug in the relevant `src/test/*.test.ts` file (or a new one), calling commands the same way the UI does. For example, the Source Control panel appends a `preserveFocus` argument to resource commands.
2. Start the test's comment with `Regression:` and describe the symptom, so it can be searched for later.
3. Check the test fails without the fix, then passes with it.

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
