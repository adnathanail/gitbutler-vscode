# GitButler Stacks (Unofficial)

> **Personal project.** I built this for my own use, on macOS with GitButler 0.22.3 and VS Code 1.139.1, which are the versions the tests run against. Other versions and platforms may work, but haven't been tried.

View GitButler stacks and commit changes from VS Code, using the [`but` CLI](https://docs.gitbutler.com/cli-overview).

This is an unofficial extension. It isn't affiliated with or endorsed by GitButler, Inc. The GitButler name and logo belong to GitButler, Inc.

## Features

- **Source Control panel**: uncommitted changes, grouped by the stack they're assigned to. Click a file to diff it against the workspace.
- **Commit all**: type a message and press ⌘Enter (or the ✓ in the panel title).
- **Commit selected**: right-click one or more changes → *Commit Selected Changes*.
- **GitButler Stacks view** (in the Source Control sidebar): stacks → branches → commits → files. Click a file to see what that commit changed.
- **Open File**: opens the file from the working tree. It's a button in a diff's title bar, and on each change in the Source Control panel (also in its right-click menu, for several selected changes).
- **File status letters**: uncommitted files are marked A (added), M (modified), D (deleted) or R (renamed) in the Source Control panel, Explorer and editor tabs. These appear while VS Code's Git integration is disabled. While it's enabled, Git shows its own letters.
- **Status bar**: the applied branches, shown bottom left like the Git extension's current branch. Stacks are listed left to right as in the GitButler app, separated by `|`, with each stack's branches from top to bottom. Click it to open the repository in GitButler.
- **Open in GitButler**: the GitButler button in the Source Control or Stacks view title bar opens the repository in the GitButler app.

When several stacks are applied, committing asks which branch to commit to, or offers to create a new one. Changes that are all assigned to one stack go to the top of that stack without asking.

## Installation

Download the `.vsix` file from the latest [release](https://github.com/adnathanail/gitbutler-vscode/releases), then run **Extensions: Install from VSIX…** in VS Code, or:

```sh
code --install-extension gitbutler-vscode-vX.Y.Z.vsix
```

VS Code doesn't update extensions installed this way, so install new releases the same way.

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

## License

[MIT](LICENSE)
