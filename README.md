# GitButler Stacks (Unofficial)

> **Personal project.** I built this for my own use, on macOS with GitButler 0.22.3 and VS Code 1.139.1, which are the versions the tests run against. Other versions and platforms may work, but haven't been tried.

View GitButler stacks and commit changes from VS Code, using the [`but` CLI](https://docs.gitbutler.com/cli-overview).

This is an unofficial extension. It isn't affiliated with or endorsed by GitButler, Inc. The GitButler name and logo belong to GitButler, Inc.

## Features

- **Source Control panel**: uncommitted changes, grouped by the stack they're assigned to. Click a file to diff it against the workspace.
- **Staging**: the + button on a change (or right-click several selected changes → *Stage Changes*) moves it to *Staged Changes*, and − moves it back. The same buttons on a group's header stage or unstage everything in it. Staging is kept by the extension while the window is open: GitButler has no staging area, so the GitButler app and `but` don't see it.
- **Commit**: type a message and press ⌘Enter (or the ✓ in the panel title). Commits the staged changes, or every change if none are staged.
- **Discard changes**: the ↶ button on a change (or right-click several selected changes → *Discard Changes*) reverts them, deleting new files. The same button on a group's header discards everything in it. Asks first, and can be undone with `but undo`.
- **GitButler Stacks view** (in the Source Control sidebar): stacks → branches → commits → files. Click a file to see what that commit changed.
- **Reword a commit**: the speech bubble button on a commit in the Stacks view (or right-click → *Reword Commit…*) edits its message. For a message with more than one line, only the first line is edited and the rest is kept. Commits above it are rebased.
- **New branch**: the + button in the Stacks view's title bar. Asks for a name (leave it empty for a generated one), then whether it's an *Independent* branch (a new stack) or a *Dependent* one, stacked on top of a stack you choose.
- **Open on GitHub**: branches pushed to GitHub have a GitHub button in the Stacks view that opens the branch's page, and branches with a pull request show its number and have a button that opens it (also in the right-click menu). Pull requests come from GitButler's GitHub integration: they appear once the GitButler app (or `but pr`) knows about them.
- **Rename a branch**: the rename button on a branch in the Stacks view (or right-click → *Rename Branch…*). As in the GitButler app, renaming a branch that has already been pushed warns first: the branch on the remote keeps its old name, and the renamed branch is pushed as a new one.
- **Add changes to a commit**: drag changed files from the Source Control panel (or the Explorer, or editor tabs) onto a commit in the Stacks view to add their uncommitted changes to that commit. Commits above it are rebased. Asks first, and can be undone with `but undo`.
- **Open File**: opens the file from the working tree. It's a button in a diff's title bar, and on each change in the Source Control panel (also in its right-click menu, for several selected changes).
- **File status letters**: uncommitted files are marked A (added), M (modified), D (deleted) or R (renamed) in the Source Control panel, Explorer and editor tabs. These appear while VS Code's Git integration is disabled. While it's enabled, Git shows its own letters. Files under commits in the Stacks view are marked with what the commit did to them.
- **Status bar**: the applied branches, shown bottom left like the Git extension's current branch. Stacks are listed left to right as in the GitButler app, separated by `|`, with each stack's branches from top to bottom. Click it to open the repository in GitButler.
- **Unstage in git**: committing with GitButler sometimes leaves changes staged in git's index, with the reverse change unstaged, and GitButler can then show changes that aren't there. While anything is staged in git, a broom button appears in the Source Control title bar. It unstages everything in git (`git restore --staged`), leaving your files and GitButler's state as they are.
- **Stage all files in git**: in the Source Control title bar's *…* menu. Stages every change in git's index (`git add --all`), for tools that only see files git tracks, such as Nix flakes. GitButler doesn't use git's index, so this doesn't affect what gets committed. The *Unstage in git* button then appears, and undoes it.
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

With Git integration disabled, other extensions that use VS Code's Git integration may not work in that workspace. For example, GitHub Actions (`github.vscode-github-actions`) fails to activate with "Git model not found". To use them, leave Git integration enabled, and set `gitbutlerVscode.suggestDisablingGit` to `false` to stop the suggestion.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitbutlerVscode.butPath` | `but` | Path to the `but` CLI. |
| `gitbutlerVscode.suggestDisablingGit` | `true` | Suggest disabling VS Code's Git integration in GitButler repositories. |

## Known limitations

- Commits include whole files; individual hunks can't be selected yet.
- When only one stack is applied, commits go to the top of that stack without asking.
- Disabling VS Code's Git integration, as the extension suggests, can stop other extensions that need it from working (see [VS Code's Git integration](#vs-codes-git-integration)).
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
