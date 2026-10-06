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

The extension picks up GitButler repositories when it starts, when workspace folders are added or removed, and when you run `but setup` or `but teardown` in an open folder.

## VS Code's Git integration

VS Code's built-in Git integration also shows GitButler repositories, and committing with it on the `gitbutler/workspace` branch bypasses GitButler. When the extension finds a GitButler repository with Git integration enabled, it offers to disable it by setting `"git.enabled": false` in the workspace settings (or the folder's settings, in a multi-root workspace).

If a folder the extension disabled Git for stops being a GitButler repository, for example after `but teardown`, it offers to re-enable Git by removing that setting. If you've changed the setting yourself since, it leaves it alone.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitbutlerVscode.butPath` | `but` | Path to the `but` CLI. |
| `gitbutlerVscode.suggestDisablingGit` | `true` | Suggest disabling VS Code's Git integration in GitButler repositories. |

## Known limitations

- Commits include whole files; individual hunks can't be selected yet.
- When only one stack is applied, commits go to the top of that stack without asking.
- Diffs of renamed files compare against whatever was at the new path before, because `but` doesn't report the old path.

## Development

```sh
npm install
npm run compile
npm test
```

Press F5 to launch an Extension Development Host with the debugger attached. Commands the extension runs are logged to the **GitButler** output channel.

See `CLAUDE.md` for how the extension works, the test setup, and debugging notes.
