# GitButler Stacks (Unofficial)

An unofficial VS Code extension that shows GitButler stacks and commits changes by calling the `but` CLI. User-facing documentation is in `README.md`.

## Commands

```sh
npm run compile                           # build to out/
npm test                                  # compile, then run all tests in a downloaded VS Code
npx vscode-test --grep <pattern>          # run matching tests (compile first)
```

## Layout

| File | Purpose |
| --- | --- |
| `src/extension.ts` | Activation, repository discovery, commands, branch picking for commits. `activate` returns an `ExtensionApi` used by tests. |
| `src/but.ts` | Runs `but`, and types for its JSON output. Also exports `run`, the logged command runner. |
| `src/repository.ts` | One GitButler repository: its Source Control panel, staged changes, file watcher, refresh, and diff opening. |
| `src/stacksView.ts` | The GitButler Stacks tree view (stacks → branches → commits → files). |
| `src/decorations.ts` | `ChangeDecorationProvider`, which marks uncommitted files with A/M/D/R in the Source Control panel, Explorer and tabs. |
| `src/content.ts` | `RevisionFileSystemProvider`, a read-only file system serving file contents at a git revision for diffs and gutter markers. |
| `src/gitIntegration.ts` | Suggestions to disable VS Code's built-in Git integration in GitButler repositories, and to re-enable it afterwards. |
| `resources/` | Icons. `gitbutler-{light,dark}.svg` is a monochrome bowtie (⧓) standing in for the GitButler logo, in VS Code's toolbar icon colours. `gitbutler-icons.woff` has the same bowtie as the `gitbutler-vscode-logo` icon, for status bar text. |
| `scripts/build-icon-font.py` | Builds `gitbutler-icons.woff`: `uv run --with fonttools scripts/build-icon-font.py`. |
| `src/test/` | Integration tests (mocha, `describe`/`it`). `helpers.ts` has the shared fixtures. |
| `.vscode-test.mjs` | Test run configuration, including fixture setup. |

## How the extension uses `but`

Everything goes through `but … --json`:

| Action | Command |
| --- | --- |
| Status | `but status -f --json` |
| Commit | `but commit --json -m <msg> [--branch [<name>]] -- <paths>` |
| Discard | `but discard --json -- <paths>` |
| Open in GitButler | `but gui` |

The types in `src/but.ts` were written against `but` 0.22.3, the version CI pins. Behaviour of `but` the extension relies on:

- `but commit` accepts plain repo-relative paths as well as CLI IDs. Uncommitted-file CLI IDs change whenever the workspace changes, so the extension always passes paths and never caches CLI IDs.
- Flags must come before `--`, or they're treated as paths. `--` is needed so paths starting with `-` aren't read as flags.
- `but discard` also accepts plain paths, and errors on paths with no uncommitted changes. With no paths it discards every uncommitted change, so the extension never calls it without any. Discarding deletes new files, and is recorded in the oplog, so `but undo` restores everything, including deleted new files.
- `--branch` with no value creates a new branch with a generated name. A name that doesn't exist creates a new unstacked branch.
- With more than one stack applied, `but commit` fails unless `--branch` is given. With one stack it commits to the tip of that stack, and with none it creates a branch.
- The JSON returned by `but commit` includes `branch` only when the commit created a new branch.
- Errors are plain text on stderr with a non-zero exit code, even with `--json`. They often include useful hints, so the full text goes to the GitButler output channel.
- `but status` writes to `.git/gitbutler/` (a lock file), so the repository file watcher ignores `.git/` apart from `HEAD`, `packed-refs` and `refs/`. Otherwise every status call would trigger another refresh.
- `HEAD` is the GitButler workspace commit, a merge of every applied stack, so `HEAD:<path>` is the baseline for uncommitted changes.
- `renamed` changes don't report the previous path.
- A stack's `branches` include every local branch that points at one of its commits, not only branches created with GitButler.
- `stacks` are in the GitButler app's left-to-right order (`order` in `.git/gitbutler/virtual_branches.toml`). New stacks are added on the left.
- `but setup` registers the repository in a global GitButler project list (`~/Library/Application Support/com.gitbutler.app/projects.json` on macOS). It finds this through `HOME`.
- `but open` (0.22.3) fails to open links itself, with "Invalid path scheme: but". `but open --print --json [<branch or commit>]` prints a `but://app/project/<base64 .git path>/workspace[?stacks=...]` link, but the GitButler app of the same version only brings itself to the front for it, without switching project or selecting anything. `but gui`, and clonager's `but://open?path=<repo path>` links, do switch project. Checked by watching `set_project_active` in GitButler's log (`~/Library/Logs/com.gitbutler.app/`, times in UTC; project IDs are the base64 of the `.git` path).
- `vscode.env.openExternal` re-encodes a URL's query, turning `?stacks=branch:refs/heads/x` into `?stacks%3Dbranch%3Arefs%2Fheads%2Fx`, so it's unsuitable for `but:` links with queries.
- When `but` detects it's being run by a coding agent, its human-readable output may start with a notice asking the agent to install a GitButler skill. `--json` output doesn't include it.
- `but teardown` can't run unattended in a fresh repository: it needs a branch to check out (`--checkout-to`).

## Design decisions

- **The extension is presented as unofficial.** GitButler's licence gives no rights to its trademarks or product names, so the display name and description say "Unofficial", the README says it isn't affiliated with GitButler, Inc., and GitButler's logo shouldn't be used as the extension's own Marketplace icon. Using the name to describe compatibility, and the toolbar icon for opening the GitButler app, refer to GitButler rather than presenting the extension as theirs.
- **Command and setting IDs use the `gitbutlerVscode.` prefix.** `gitbutler.*` clashed with the GitButler for IDE extension (`BartInTheField.gitbutler-for-ide`), and VS Code refused to register the duplicate commands. The source control ID is `gitbutlerVscode` and the revision URI scheme is `gitbutler-vscode-rev` for the same reason. A manifest test enforces the prefix.
- **Staging is the extension's own state.** GitButler has no staging area, and `but` can't change which branch changes are assigned to (see Next steps). `Repository` keeps staged paths while the window is open, dropping a path once it has no uncommitted changes, and shows them in a *Staged Changes* group instead of their own group. Committing commits the staged changes, or every change when none are staged, and the message box placeholder says which. Staging was chosen over checkboxes in a separate tree view: the Source Control panel can't show checkboxes, and a tree view below it left a large gap under the message box, because the built-in view takes a share of the sidebar's height and extensions can't size it (`initialSize` is ignored for views in a container the extension doesn't own).
- **`gitbutlerVscode.openChange` takes a single object argument** (`OpenChangeTarget`). The Source Control panel appends a `preserveFocus` boolean to resource command arguments, which was once read as a commit ID.
- **Old file versions are served by a `FileSystemProvider`, not a `TextDocumentContentProvider`.** Non-text editors such as the image preview can only read through the file system API, and content providers caused "ModelService: Cannot add model because it already exists" errors. `git show` output is kept as raw bytes so binary files aren't corrupted.
- **Files at moving refs reload when the applied commits change.** `Repository.updateHead` compares the commit IDs from each refresh and, when they change, tells `RevisionFileSystemProvider` to report its `HEAD` URIs as changed. URIs at commit IDs never change.
- **The status bar entry is a `SourceControl.statusBarCommands` command**, not a separate status bar item, so VS Code shows it for the active repository as it does the Git extension's branch. Status bar text can only show icons from fonts, hence the icon font.
- **A/M/D/R letters on uncommitted files come from a `FileDecorationProvider`, only while VS Code's Git decorations are off.** Source control resources can't show a description, and the Git extension decorates the same file URIs, so with it on each letter would appear twice. The provider steps aside unless `git.enabled` or `git.decorations.enabled` is `false` for the repository root, or the Git extension isn't installed or enabled. Its colours are its own (`gitbutlerVscode.*ResourceForeground`, defaulting to Git's), since Git's colour IDs disappear when the Git extension is disabled. New files are `A`, not Git's `U` (untracked), because that's what `but` reports.
- **The Open File button on diffs mirrors the Git extension's.** In a diff, `resourceScheme` is the right-hand side's. Git shows its button on every diff whose right side is `file:` or `git:`, while its integration is on. This extension's button shows on `gitbutler-vscode-rev:` diffs (committed changes), and on `file:` diffs only while Git's button doesn't, so there's never two. It opens the working tree file, keeping the cursor position from the diff. Source Control rows have it inline and in their context menu, hidden for deleted files using the change type, which `Repository` sets as each resource's `contextValue` (`scmResourceState` in menus). Stage, Unstage and Discard tell staged rows apart by `scmResourceGroup == staged`; staged rows have no Discard button, as in Git.
- **Discarding asks first, in a modal dialog**, as the Git extension does. Stage, Unstage and Discard are each one command, used on both changes and group headers: commands on changes get every selected change, and commands on a group header get the group.
- **Error notifications don't block.** `showError` fires and forgets, so commands finish when their work does, and tests don't hang waiting for a notification to be dismissed. Errors are also emitted on `ExtensionApi.onDidShowError` for tests.
- **Discovery** runs on activation, when workspace folders change, and when any `.git/HEAD` changes (debounced), so `but setup`/`but teardown` in an open folder are noticed. Runs are serialised, and existing `Repository` objects are kept so their views don't reset.
- **Git integration suggestions** are shown once per change in whether a folder is managed by GitButler. Disabling writes `git.enabled: false` to workspace settings (folder settings in a multi-root workspace) and records the folder and settings level in workspace state. Re-enabling removes the setting rather than setting it to `true`. If the user changed the setting since, the record is dropped silently.

## Tests

Tests run inside a separate copy of VS Code (downloaded to `.vscode-test/`) using real `but` and git. `.vscode-test.mjs` sets up each run:

- **`HOME` points at `.vscode-test/fixtures/home`**, so `but setup` registers test repositories in a throwaway project list, never the developer's real one. It also gives git a fixed identity.
- **`--use-mock-keychain` is passed** because, with `HOME` replaced, macOS can't find a keychain and blocks the window with a "Keychain Not Found" prompt.
- **`--use-mock-keychain` must come before a flag VS Code knows** (`--disable-extensions`). VS Code parses its arguments with minimist, which reads an unknown flag followed by a bare value as `--flag value`, and test-cli appends the workspace folder right after `launchArgs`. With the order reversed, the window opens with no folder.
- **The window opens on a fresh GitButler repository** in `.vscode-test/fixtures/workspace`, for discovery tests.
- **Stored workspace state is cleared** before each run, because the fixture workspace has the same path every time.

Versions are pinned, because this is a personal project used with one setup: VS Code in `.vscode-test.mjs` (`version`), and GitButler in `.github/actions/install-gitbutler/action.yml` (used by CI and releases), which downloads the app from GitButler's release URL, checks its SHA-256 and links `but` from it, as Homebrew does (Homebrew only installs the latest version). The URL format and checksums are in Homebrew's cask (`Casks/g/gitbutler.rb`). When upgrading, update both, the versions named in the README, and the version in "How the extension uses `but`". The setup is macOS-specific (the mock keychain flag, and `but` from the app), so there's no Linux job.

Helpers in `src/test/helpers.ts`:

- `useTestRepo()` gives each test its own fresh GitButler repository, separate from the workspace folder.
- `resource(group, path)` finds a change in a Source Control group, and `paths(group)` lists a group's paths.
- `collectErrors(api)` records error notifications, so tests can assert none appeared.
- `stubInformationMessage(answer)` and `stubWarningMessage(answer)` replace `vscode.window.showInformationMessage` and `showWarningMessage` to answer prompts, including modal ones.
- `fakeBut(exitCode)` in `openInGitButler.test.ts` points `gitbutlerVscode.butPath` at a script that records its arguments, so tests of `but gui` don't launch the GitButler app.
- `waitFor(condition, message)` polls for asynchronous effects such as rediscovery.

Tests of commands should call them the same way the UI does, including arguments VS Code adds. When fixing a bug, add a regression test whose comment starts with `Regression:` and describes the symptom, and check that it fails without the fix.

## Releasing

Run **Actions → Release → Run workflow** on `main`, choosing patch, minor or major. `.github/workflows/release.yml`, modelled on clonager's:

1. works out the version from the latest `vX.Y.Z` tag
2. makes a release commit on top of `main` that sets `version` in `package.json` (and `package-lock.json`), and tags it. `main` itself stays at version `0.0.0`; the release commit is only reachable from its tag
3. runs the tests against the pinned GitButler
4. packages the extension with `vsce package --no-dependencies`. The flag matters: the extension has no runtime dependencies, and when vsce's `npm list` dependency check fails it silently packages no files and then reports the entry point as missing
5. pushes the tag and creates a GitHub release with the `.vsix` attached and generated notes.

The extension isn't on the VS Code Marketplace or Open VSX. To check what would be packaged, run `npx vsce ls --no-dependencies`.

## Debugging

F5 uses **Debug Extension (IPv4)**, which launches the Extension Development Host with its inspector on `127.0.0.1:9333` and attaches there. It works around [vscode-js-debug#2416](https://github.com/microsoft/vscode-js-debug/issues/2416): in VS Code versions bundling js-debug older than 1.140.0, the standard **Run Extension** configuration fails with "Extension host did not start in 10 seconds", because the debugger tries `localhost` over IPv6 (`::1`) while the inspector only listens on IPv4.

Useful logs:

- The **GitButler** output channel in the development window lists every `but` and discovery `git` command and its errors.
- VS Code's own logs are in `~/Library/Application Support/Code/logs/<session>/window<N>/`. `exthost/exthost.log` and `renderer.log` have extension host and window errors; `exthost/output_logging_*/` has output channel contents.
- Test runs keep their logs in `.vscode-test/user-data/logs/`.

## Next steps

Improvements discussed but not yet made:

- **Commit individual hunks.** `but diff --json` lists hunk IDs (`<file>:<hunk>`), which `but commit` accepts. Hunk IDs change as the workspace changes, so they'd need resolving just before committing.
- **Assign changes to branches.** `but` 0.22.3 reports assignments (`assignedChanges`) but has no command to change them: `but rub` was retired, and `but move` only moves commits, committed files and branches. Once a `but` release can assign uncommitted files, an "Assign to…" action on Source Control rows would be possible, and assignment could replace the extension's own staging, which GitButler doesn't see.
- **Choose a branch when only one stack is applied.** Commits currently go to the tip of that stack without asking, which is `but`'s default. Offering the branch picker (including "New Branch…") there too would allow starting a new stack.
- **Diffs for renames.** `but status` only reports the new path, so a rename's diff compares the new file with whatever existed at that path before. Getting the old path would need another source, such as `git diff --find-renames`.
- **Check the `but` version.** The JSON format may change between `but` releases. Checking `but --version` on startup and warning about untested versions would make breakages clearer.
- **Test the image preview itself.** Tests check binary reads through `RevisionFileSystemProvider`, but don't open an image diff.
- **Remove the IPv4 debug workaround** once on VS Code 1.140.0 or later (the version in nixpkgs was 1.139.1 at the time), and use **Run Extension** for F5 again.
- **Open GitButler on a branch or commit** from the Stacks view, once the GitButler app navigates to `but open` links (and `but open` can open them itself). Until then those links only bring the app to the front.
- **Workspace folders inside a repository.** Discovery handles a workspace folder that's a subdirectory of the repository, but the `**/.git/HEAD` watcher only sees `.git` directories inside workspace folders, so `but setup`/`but teardown` there isn't noticed until a reload.
