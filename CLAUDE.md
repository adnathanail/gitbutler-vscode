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
| `src/stacksView.ts` | The GitButler Stacks tree view (stacks → branches → commits → files), which accepts files dropped onto commits. |
| `src/decorations.ts` | `ChangeDecorationProvider`, which marks uncommitted files with A/M/D/R in the Source Control panel, Explorer and tabs. |
| `src/content.ts` | `RevisionFileSystemProvider`, a read-only file system serving file contents at a git revision for diffs and gutter markers. |
| `src/history.ts` | `HistoryProvider`, the Source Control Graph's history: applied stacks and the target branch, joined by the workspace commit. |
| `src/vscode.proposed.scmHistoryProvider.d.ts` | Types for the proposed `scmHistoryProvider` API, from VS Code's repository at the pinned version's tag (`src/vscode-dts/`). `src/vscode.iconPath.d.ts` declares `IconPath`, which they use but `@types/vscode` 1.90 lacks. |
| `src/github.ts` | GitHub web URLs from git remote URLs. |
| `src/gitIntegration.ts` | Suggestions to disable VS Code's built-in Git integration in GitButler repositories, and to re-enable it afterwards. |
| `resources/` | Icons. `gitbutler-{light,dark}.svg` is a monochrome bowtie (⧓) standing in for the GitButler logo, in VS Code's toolbar icon colours. `broom-{light,dark}.svg`, in the same colours, is the Unstage in git button. `gitbutler-icons.woff` has the same bowtie as the `gitbutler-vscode-logo` icon, for status bar text. |
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
| Add changes to a commit | `but amend --json --target <commit ID> -- <paths>` |
| Reword a commit | `but reword --json <commit ID> --message=<msg>` |
| New branch | `but branch new --json [--above <branch CLI ID>] [-- <name>]` |
| Pull request URL | `but branch show --json --review <branch CLI ID>` |
| Push remote | `but config push-remote --json` |
| Target branch and its remote URL | `but config target --json` |
| Rename a branch | `but reword --json <branch CLI ID> --message=<new name>` |
| Open in GitButler | `but gui` |

Git's index is read, reset and filled with git itself: `git diff --cached --name-only -z` on each refresh, `git restore --staged -- :/`, and `git add --all -- :/`. Remote URLs are read on each refresh with `git config --get-regexp`, and a branch's upstream with `git for-each-ref`. The Source Control Graph reads refs with `git for-each-ref` on each refresh, and history with `git log`, `git diff --name-status` and `git merge-base`.

The types in `src/but.ts` were written against `but` 0.22.3, the version CI pins. Behaviour of `but` the extension relies on:

- `but commit` accepts plain repo-relative paths as well as CLI IDs. Uncommitted-file CLI IDs change whenever the workspace changes, so the extension always passes paths and never caches CLI IDs.
- Flags must come before `--`, or they're treated as paths. `--` is needed so paths starting with `-` aren't read as flags.
- `but discard` also accepts plain paths, and errors on paths with no uncommitted changes. With no paths it discards every uncommitted change, so the extension never calls it without any. Discarding deletes new files, and is recorded in the oplog, so `but undo` restores everything, including deleted new files.
- `but amend` also accepts plain paths and full commit IDs, works on commits below the top of a branch (rebasing those above), and errors on paths with no uncommitted changes. With no paths it amends every uncommitted change, so the extension never calls it without any.
- `but reword` accepts full commit IDs and multi-line messages, and rebases the commits above. The message is passed as `--message=<msg>` so one starting with `-` isn't read as a flag.
- `but reword <branch>` renames an applied branch, validating the new name ("Invalid branch name", with a suggested name) and refusing one that's already applied. It doesn't always resolve a branch name as its target: a lone branch named `zz` is "ambiguous". The extension looks up the branch's CLI ID in a fresh `but status` and passes that. Renaming a pushed branch leaves the remote branch as it is, and the renamed branch no longer tracks it.
- `but branch new` creates an empty branch: a new stack, or with `--above <branch>`, stacked above that branch (on top of the stack when it's the top branch). Without a name it generates one. It validates names as `but reword` does. Its target is passed by CLI ID for the same reason.
- `branchStatus` is `completelyUnpushed` exactly when a branch has no remote tracking branch. The GitButler app's rename warning is shown when there is one. A branch is pushed if it has an upstream set in git, or if GitButler's push remote (`but config push-remote`) has a branch of the same name. In a repository without remotes, `but setup` makes the push remote `gb-local`, pointing at the repository itself.
- Pull requests come from a cache in `.git/gitbutler/but.sqlite`, filled by the GitButler app, `but pr` and `but status --refresh-prs`. `but status` only reads it, reporting one pull request per branch as `reviewId`, a display string such as `"(#10)"`. `but branch show --review --json` lists a branch's pull requests with their URLs, also from the cache.
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
- Committing with `but` sometimes leaves changes staged in git's index, with the reverse change unstaged. `but status` reads the index for new files: a file staged and then deleted is reported as `removed`, though it was never committed.
- `but teardown` can't run unattended in a fresh repository: it needs a branch to check out (`--checkout-to`).

## Design decisions

- **The extension is presented as unofficial.** GitButler's licence gives no rights to its trademarks or product names, so the display name and description say "Unofficial", the README says it isn't affiliated with GitButler, Inc., and GitButler's logo shouldn't be used as the extension's own Marketplace icon. Using the name to describe compatibility, and the toolbar icon for opening the GitButler app, refer to GitButler rather than presenting the extension as theirs.
- **Command and setting IDs use the `gitbutlerVscode.` prefix.** `gitbutler.*` clashed with the GitButler for IDE extension (`BartInTheField.gitbutler-for-ide`), and VS Code refused to register the duplicate commands. The source control ID is `gitbutlerVscode` and the revision URI scheme is `gitbutler-vscode-rev` for the same reason. A manifest test enforces the prefix.
- **Staging is the extension's own state.** GitButler has no staging area, and `but` can't change which branch changes are assigned to (see Next steps). `Repository` keeps staged paths while the window is open, dropping a path once it has no uncommitted changes, and shows them in a *Staged Changes* group instead of their own group. Committing commits the staged changes, or every change when none are staged, and the message box placeholder says which. Staging was chosen over checkboxes in a separate tree view: the Source Control panel can't show checkboxes, and a tree view below it left a large gap under the message box, because the built-in view takes a share of the sidebar's height and extensions can't size it (`initialSize` is ignored for views in a container the extension doesn't own).
- **`gitbutlerVscode.openChange` takes a single object argument** (`OpenChangeTarget`). The Source Control panel appends a `preserveFocus` boolean to resource command arguments, which was once read as a commit ID.
- **Old file versions are served by a `FileSystemProvider`, not a `TextDocumentContentProvider`.** Non-text editors such as the image preview can only read through the file system API, and content providers caused "ModelService: Cannot add model because it already exists" errors. `git show` output is kept as raw bytes so binary files aren't corrupted.
- **Files at moving refs reload when the applied commits change.** `Repository.updateHead` compares the commit IDs from each refresh and, when they change, tells `RevisionFileSystemProvider` to report its `HEAD` URIs as changed. URIs at commit IDs never change.
- **The status bar entry is a `SourceControl.statusBarCommands` command**, not a separate status bar item, so VS Code shows it for the active repository as it does the Git extension's branch. Status bar text can only show icons from fonts, hence the icon font. When the target branch's remote is on GitHub, a `$(github) <repo>` command comes first, which puts it on the left. That's the remote GitButler's GitHub integration uses (`remote_url` from `but config target`, the target remote's fetch URL), read on each refresh.
- **A/M/D/R letters on uncommitted files come from a `FileDecorationProvider`, only while VS Code's Git decorations are off.** Source control resources can't show a description, and the Git extension decorates the same file URIs, so with it on each letter would appear twice. The provider steps aside unless `git.enabled` or `git.decorations.enabled` is `false` for the repository root, or the Git extension isn't installed or enabled. Its colours are its own (`gitbutlerVscode.*ResourceForeground`, defaulting to Git's, apart from renamed files, which are purple), since Git's colour IDs disappear when the Git extension is disabled. New files are `A`, not Git's `U` (untracked), because that's what `but` reports.
- **Files under commits in the Stacks view have their own URI scheme**, `gitbutler-vscode-change:`, with the commit's change type in the query (`committedChangeUri`). `ChangeDecorationProvider` decorates these from the query, whether or not Git's decorations are on, since Git never decorates the scheme. With the working tree file's URI, a file deleted since would have looked deleted in the commit that added it. Decorations colour the label too outside the Source Control panel; there's no way to colour only the letter.
- **The Open File button on diffs mirrors the Git extension's.** In a diff, `resourceScheme` is the right-hand side's. Git shows its button on every diff whose right side is `file:` or `git:`, while its integration is on. This extension's button shows on `gitbutler-vscode-rev:` diffs (committed changes), and on `file:` diffs only while Git's button doesn't, so there's never two. It opens the working tree file, keeping the cursor position from the diff. Source Control rows have it inline and in their context menu, hidden for deleted files using the change type, which `Repository` sets as each resource's `contextValue` (`scmResourceState` in menus). Stage, Unstage and Discard tell staged rows apart by `scmResourceGroup == staged`; staged rows have no Discard button, as in Git.
- **Discarding asks first, in a modal dialog**, as the Git extension does. Stage, Unstage and Discard are each one command, used on both changes and group headers: commands on changes get every selected change, and commands on a group header get the group.
- **Dropping files onto a commit amends it.** The Stacks view accepts `text/uri-list`, which the Source Control panel, Explorer and editor tabs all set when dragging files. A drop onto a commit or one of its files runs the internal `gitbutlerVscode.amend` command, which shows errors like other commands, and asks first in a modal dialog, as discarding does. The dialog names the commit and how many commits above it will be rebased. Dropped files without uncommitted changes are ignored, and if none have any, it's an error. Tree views can't refuse a drop per item, so a drop onto anything else explains where to drop instead. Dropping onto the editor area opens the file, which is VS Code's own behaviour for dragged file URIs.
- **Rewording edits only the subject of a multi-line message**, keeping the body, because VS Code's input box is single-line. Commit tree items have the `contextValue` `commit` for the Reword menu items.
- **New Branch asks for a name, then Independent or Dependent, then for a dependent branch, the stack.** The terms are the GitButler app's. The stack picker is shown even when only one stack is applied, so it's clear where the branch goes. With no stacks applied, only Independent is offered. A dependent branch always goes on top of its stack.
- **GitHub buttons on branches.** Open Pull Request is shown for branches with a `reviewId`, and opens the matching review from `but branch show`, so it works for any forge GitButler supports. Open Branch on GitHub is shown for pushed branches while the repository has a GitHub remote (by GitButler's rule: a host containing `github.com` or starting with `github.`). Which remote the branch went to is only worked out when clicked, and if it's not on GitHub, that's an error. Branch tree items' `contextValue` is `branch`, followed by `github` and `review` when those apply, so menus match it with `=~`. Tests replace `vscode.env.openExternal`, and fake pull requests with a `but` wrapper, since filling GitButler's cache needs a forge account.
- **The Source Control Graph is a `SourceControl.historyProvider`**, a proposed API (`scmHistoryProvider`, declared in `enabledApiProposals`). VS Code allows it in the Extension Development Host, in tests through `--enable-proposed-api` in `.vscode-test.mjs`, and otherwise only with `"enable-proposed-api": ["adnathanail.gitbutler-vscode"]` in `~/.vscode/argv.json`. Without that, setting `historyProvider` throws, so it's in a `try`, and the rest of the extension works. `vsce package` accepts the proposal without extra flags (vsce 4.0.0). The Graph is VS Code's own view, so the extension can't rename it, and it comes above GitButler Stacks (VS Code orders it `2`, and extension views in its container have no order). Dragging the views reorders them, which VS Code remembers. A webview drawing the graph itself, which could be named and placed, was considered and not pursued.
- **The graph shows git's commit graph from the workspace commit and the target.** GitButler stores each stack as a chain of commits from the commit it's based on (usually the target, but a branch applied later keeps its older base), and `gitbutler/workspace` points at a commit merging the top of every stack, recreated on every change. The current ref is `gitbutler/workspace`, so the workspace commit is the graph's current commit, at the top. It was once left out, as GitButler's bookkeeping, but the Graph's Go to Current History Item button then loaded history looking for it and silently did nothing. The remote ref is the target branch, so the graph shows commits on it that aren't applied as incoming, using the merge base of the two. Commits are badged with `gitbutler/workspace`, applied branch names and the target. Changes in a commit use the Stacks view's `gitbutler-vscode-change:` URIs, so they get the same decorations, and `RevisionFileSystemProvider` URIs for the diff sides.
- **Renaming a pushed branch warns first**, in a modal dialog with the GitButler app's wording, before the input box. Branch tree items' `contextValue` starts with `branch` for the Rename Branch menu items. A stack of several branches is labelled with its top branch, but has no Rename button; its branches each do.
- **Unstage in git is shown only while git's index has staged changes** (the `gitbutlerVscode.hasGitStagedChanges` context key, true if any repository has some), so the button doubles as the indicator. Its icon is a broom (`resources/broom-{light,dark}.svg`), since codicons have none. It doesn't confirm, since it only resets the index to `HEAD`. `.git/index` isn't watched, so changes to the index made outside the extension are noticed on the next refresh, such as when the window regains focus.
- **Stage All Files in Git** (`git add --all -- :/`) is in the Source Control title bar's overflow menu, for tools such as Nix flakes that ignore files git doesn't track. Staging leaves git's index differing from `HEAD`, so the Unstage in git button appears afterwards, and is how to undo it.
- **Error notifications don't block.** `showError` fires and forgets, so commands finish when their work does, and tests don't hang waiting for a notification to be dismissed. Errors are also emitted on `ExtensionApi.onDidShowError` for tests.
- **Discovery** runs on activation, when workspace folders change, and when any `.git/HEAD` changes (debounced), so `but setup`/`but teardown` in an open folder are noticed. Runs are serialised, and existing `Repository` objects are kept so their views don't reset.
- **Git integration suggestions** are shown once per change in whether a folder is managed by GitButler. Disabling writes `git.enabled: false` to workspace settings (folder settings in a multi-root workspace) and records the folder and settings level in workspace state. Re-enabling removes the setting rather than setting it to `true`. If the user changed the setting since, the record is dropped silently.
- **Disabling Git breaks extensions that use its API**, which is documented rather than worked around. With `git.enabled: false`, the Git extension's `getAPI(1)` throws "Git model not found", and extensions such as GitHub Actions (`github.vscode-github-actions` 0.31.5) fail to activate. Extensions find Git by the ID `vscode.git`, so another extension can't stand in for it. Keeping Git enabled with `scm.repositories.selectionMode: "single"` to hide its view was considered and not pursued.

## Tests

Tests run inside a separate copy of VS Code (downloaded to `.vscode-test/`) using real `but` and git. `.vscode-test.mjs` sets up each run:

- **`HOME` points at `.vscode-test/fixtures/home`**, so `but setup` registers test repositories in a throwaway project list, never the developer's real one. It also gives git a fixed identity.
- **`--use-mock-keychain` is passed** because, with `HOME` replaced, macOS can't find a keychain and blocks the window with a "Keychain Not Found" prompt.
- **`--enable-proposed-api adnathanail.gitbutler-vscode` is passed** for the Source Control Graph's proposed API, which VS Code doesn't allow in the test window otherwise.
- **`--use-mock-keychain` must come before a flag VS Code knows** (`--disable-extensions`). VS Code parses its arguments with minimist, which reads an unknown flag followed by a bare value as `--flag value`, and test-cli appends the workspace folder right after `launchArgs`. With the order reversed, the window opens with no folder.
- **The window opens on a fresh GitButler repository** in `.vscode-test/fixtures/workspace`, for discovery tests.
- **Stored workspace state is cleared** before each run, because the fixture workspace has the same path every time.

Versions are pinned, because this is a personal project used with one setup: VS Code in `.vscode-test.mjs` (`version`), and GitButler in `.github/actions/install-gitbutler/action.yml` (used by CI and releases), which downloads the app from GitButler's release URL, checks its SHA-256 and links `but` from it, as Homebrew does (Homebrew only installs the latest version). The URL format and checksums are in Homebrew's cask (`Casks/g/gitbutler.rb`). When upgrading, update both, the versions named in the README, and the version in "How the extension uses `but`". When upgrading VS Code, also replace `src/vscode.proposed.scmHistoryProvider.d.ts` with the one at the new version's tag, since proposed APIs change. The setup is macOS-specific (the mock keychain flag, and `but` from the app), so there's no Linux job.

Helpers in `src/test/helpers.ts`:

- `useTestRepo()` gives each test its own fresh GitButler repository, separate from the workspace folder. `setTarget(url?)` on it gives it an `origin` (a bare repository) and makes `origin/main` the target, optionally pointing `origin` at another URL afterwards.
- `resource(group, path)` finds a change in a Source Control group, and `paths(group)` lists a group's paths.
- `collectErrors(api)` records error notifications, so tests can assert none appeared.
- `stubInputBox(answer)` replaces `vscode.window.showInputBox`, recording its options.
- `stubQuickPick(...answers)` replaces `vscode.window.showQuickPick`, picking items by label in turn and recording the labels shown.
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
- **Land branches.** `but land <branch>` (0.22.3) lands a branch onto the target branch without a pull request: it fetches the target's remote, fast-forwards the target to the branch when it can, and otherwise creates a merge commit. It refuses when the branch isn't the bottom of its stack (`--whole-stack` with the top branch lands the whole stack), when the commits to land include conflicted ones, when the target's fetch and push remotes differ, and when the merge would conflict. A push can also be rejected by branch protection, which can't be known in advance. The first three can be checked before offering Land. `upstreamState.behind` from `but status` (as of the last fetch) says whether landing will fast-forward (0) or create a merge commit that might conflict. Landing isn't undoable with `but undo`, since the target has moved on the remote, so it should ask first, as `but land` and the GitButler app do (pass `--yes` once the extension has asked). Undecided:
  - **Whether to offer Land or Create PR.** The GitButler app has a per-project "Land branches directly" setting, which replaces its Create PR button with Land on the bottom branch of a stack. It's a frontend-only preference in the app's WebKit local storage (`~/Library/WebKit/com.gitbutler.app/WebsiteData/Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3`, key `projectLandDirectly_<project ID>`, value `"true"` or `"false"`), and `but` doesn't know about it. Reading it would match the app, but it's not a public interface and could change in any GitButler release. The alternative is the extension's own setting. (`but agent`'s "push to main" option only writes instructions into files such as `AGENTS.md`, so there's nothing to read there.)
  - **Whether to land when the target has moved on**, creating a merge commit as `but land` does, or only when it would fast-forward.
- **A GitButler commit graph.** The git graph is VS Code's own *Graph* view, which shows what the history provider gives it, but VS Code decides the rest: the view's name and position (above GitButler Stacks), lane layout and colours, and which branch badges appear (only branches the graph's filter follows, unless `scm.graph.badges` is `"all"`). A webview view in the Source Control container could instead:
  - be named (e.g. "GitButler Commit Graph") and come below GitButler Stacks, since extension views keep their declared order
  - leave out the workspace commit, which only GitButler's bookkeeping needs (the built-in graph shows it, since its Go to Current History Item button looks for it)
  - lay out stacks as the GitButler app does, with every branch labelled
  - show unapplied branches too, in different colours
  - show uncommitted changes, which the built-in graph can't
  - work without a proposed API, so without the `argv.json` setting.

  It would have to draw the graph, handle selection, scrolling and opening diffs, and follow theme colours itself.
- **Small improvements to the git graph.** Commit statistics (files changed, insertions, deletions) in hovers, which `SourceControlHistoryItem.statistics` provides and the Git extension shows. Commands such as Reword and Rename Branch on the graph's commits and badges, through the `scm/historyItem/context` and `scm/historyItemRef/context` menus, which need two more proposals (`contribSourceControlHistoryItemMenu`, and `contribSourceControlHistoryTitleMenu` for its title bar).
- **Workspace folders inside a repository.** Discovery handles a workspace folder that's a subdirectory of the repository, but the `**/.git/HEAD` watcher only sees `.git` directories inside workspace folders, so `but setup`/`but teardown` there isn't noticed until a reload.
