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
| `src/repository.ts` | One GitButler repository: its Source Control panel, file watcher, refresh, and diff opening. |
| `src/stacksView.ts` | The GitButler Stacks tree view (stacks → branches → commits → files). |
| `src/content.ts` | `RevisionFileSystemProvider`, a read-only file system serving file contents at a git revision for diffs and gutter markers. |
| `src/gitIntegration.ts` | Suggestions to disable VS Code's built-in Git integration in GitButler repositories, and to re-enable it afterwards. |
| `resources/` | Icons. `gitbutler-{light,dark}.svg` is a monochrome bowtie (⧓) standing in for the GitButler logo, in VS Code's toolbar icon colours. |
| `src/test/` | Integration tests (mocha, `describe`/`it`). `helpers.ts` has the shared fixtures. |
| `.vscode-test.mjs` | Test run configuration, including fixture setup. |

## How the extension uses `but`

Everything goes through `but … --json`:

| Action | Command |
| --- | --- |
| Status | `but status -f --json` |
| Commit | `but commit --json -m <msg> [--branch [<name>]] -- <paths>` |
| Open in GitButler | `but gui` |

The types in `src/but.ts` were written against `but` 0.22.3. Behaviour of `but` the extension relies on:

- `but commit` accepts plain repo-relative paths as well as CLI IDs. Uncommitted-file CLI IDs change whenever the workspace changes, so the extension always passes paths and never caches CLI IDs.
- Flags must come before `--`, or they're treated as paths. `--` is needed so paths starting with `-` aren't read as flags.
- `--branch` with no value creates a new branch with a generated name. A name that doesn't exist creates a new unstacked branch.
- With more than one stack applied, `but commit` fails unless `--branch` is given. With one stack it commits to the tip of that stack, and with none it creates a branch.
- The JSON returned by `but commit` includes `branch` only when the commit created a new branch.
- Errors are plain text on stderr with a non-zero exit code, even with `--json`. They often include useful hints, so the full text goes to the GitButler output channel.
- `but status` writes to `.git/gitbutler/` (a lock file), so the repository file watcher ignores `.git/` apart from `HEAD`, `packed-refs` and `refs/`. Otherwise every status call would trigger another refresh.
- `HEAD` is the GitButler workspace commit, a merge of every applied stack, so `HEAD:<path>` is the baseline for uncommitted changes.
- `renamed` changes don't report the previous path.
- `but setup` registers the repository in a global GitButler project list (`~/Library/Application Support/com.gitbutler.app/projects.json` on macOS). It finds this through `HOME`.
- `but open` (0.22.3) fails to open links itself, with "Invalid path scheme: but". `but open --print --json [<branch or commit>]` prints a `but://app/project/<base64 .git path>/workspace[?stacks=...]` link, but the GitButler app of the same version only brings itself to the front for it, without switching project or selecting anything. `but gui`, and clonager's `but://open?path=<repo path>` links, do switch project. Checked by watching `set_project_active` in GitButler's log (`~/Library/Logs/com.gitbutler.app/`, times in UTC; project IDs are the base64 of the `.git` path).
- `vscode.env.openExternal` re-encodes a URL's query, turning `?stacks=branch:refs/heads/x` into `?stacks%3Dbranch%3Arefs%2Fheads%2Fx`, so it's unsuitable for `but:` links with queries.
- When `but` detects it's being run by a coding agent, its human-readable output may start with a notice asking the agent to install a GitButler skill. `--json` output doesn't include it.
- `but teardown` can't run unattended in a fresh repository: it needs a branch to check out (`--checkout-to`).

## Design decisions

- **The extension is presented as unofficial.** GitButler's licence gives no rights to its trademarks or product names, so the display name and description say "Unofficial", the README says it isn't affiliated with GitButler, Inc., and GitButler's logo shouldn't be used as the extension's own Marketplace icon. Using the name to describe compatibility, and the toolbar icon for opening the GitButler app, refer to GitButler rather than presenting the extension as theirs.
- **Command and setting IDs use the `gitbutlerVscode.` prefix.** `gitbutler.*` clashed with the GitButler for IDE extension (`BartInTheField.gitbutler-for-ide`), and VS Code refused to register the duplicate commands. The source control ID is `gitbutlerVscode` and the revision URI scheme is `gitbutler-vscode-rev` for the same reason. A manifest test enforces the prefix.
- **`gitbutlerVscode.openChange` takes a single object argument** (`OpenChangeTarget`). The Source Control panel appends a `preserveFocus` boolean to resource command arguments, which was once read as a commit ID.
- **Old file versions are served by a `FileSystemProvider`, not a `TextDocumentContentProvider`.** Non-text editors such as the image preview can only read through the file system API, and content providers caused "ModelService: Cannot add model because it already exists" errors. `git show` output is kept as raw bytes so binary files aren't corrupted.
- **Files at moving refs reload when the applied commits change.** `Repository.updateHead` compares the commit IDs from each refresh and, when they change, tells `RevisionFileSystemProvider` to report its `HEAD` URIs as changed. URIs at commit IDs never change.
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

CI (`.github/workflows/ci.yml`) runs the tests on a macOS runner, after installing the latest GitButler app with `brew install --cask gitbutler` to get `but`. The setup is macOS-specific (the mock keychain flag, and `but` from the app), so there's no Linux job.

Helpers in `src/test/helpers.ts`:

- `useTestRepo()` gives each test its own fresh GitButler repository, separate from the workspace folder.
- `collectErrors(api)` records error notifications, so tests can assert none appeared.
- `stubInformationMessage(answer)` replaces `vscode.window.showInformationMessage` to answer prompts.
- `fakeBut(exitCode)` in `openInGitButler.test.ts` points `gitbutlerVscode.butPath` at a script that records its arguments, so tests of `but gui` don't launch the GitButler app.
- `waitFor(condition, message)` polls for asynchronous effects such as rediscovery.

Tests of commands should call them the same way the UI does, including arguments VS Code adds. When fixing a bug, add a regression test whose comment starts with `Regression:` and describes the symptom, and check that it fails without the fix.

## Debugging

F5 uses **Debug Extension (IPv4)**, which launches the Extension Development Host with its inspector on `127.0.0.1:9333` and attaches there. It works around [vscode-js-debug#2416](https://github.com/microsoft/vscode-js-debug/issues/2416): in VS Code versions bundling js-debug older than 1.140.0, the standard **Run Extension** configuration fails with "Extension host did not start in 10 seconds", because the debugger tries `localhost` over IPv6 (`::1`) while the inspector only listens on IPv4.

Useful logs:

- The **GitButler** output channel in the development window lists every `but` and discovery `git` command and its errors.
- VS Code's own logs are in `~/Library/Application Support/Code/logs/<session>/window<N>/`. `exthost/exthost.log` and `renderer.log` have extension host and window errors; `exthost/output_logging_*/` has output channel contents.
- Test runs keep their logs in `.vscode-test/user-data/logs/`.

## Version control

This repository uses plain git on `main`, not GitButler.

## Next steps

Improvements discussed but not yet made:

- **Commit individual hunks.** `but diff --json` lists hunk IDs (`<file>:<hunk>`), which `but commit` accepts. Hunk IDs change as the workspace changes, so they'd need resolving just before committing.
- **Choose a branch when only one stack is applied.** Commits currently go to the tip of that stack without asking, which is `but`'s default. Offering the branch picker (including "New Branch…") there too would allow starting a new stack.
- **Show A/M/D letters in the Source Control panel.** Source control resources can't set a description, and a `FileDecorationProvider` on file URIs would duplicate the built-in Git extension's letters while it's enabled. The Stacks view already shows them.
- **Diffs for renames.** `but status` only reports the new path, so a rename's diff compares the new file with whatever existed at that path before. Getting the old path would need another source, such as `git diff --find-renames`.
- **Check the `but` version.** The JSON format may change between `but` releases. Checking `but --version` on startup and warning about untested versions would make breakages clearer.
- **Test the image preview itself.** Tests check binary reads through `RevisionFileSystemProvider`, but don't open an image diff.
- **Remove the IPv4 debug workaround** once on VS Code 1.140.0 or later (the version in nixpkgs was 1.139.1 at the time), and use **Run Extension** for F5 again.
- **Open GitButler on a branch or commit** from the Stacks view, once the GitButler app navigates to `but open` links (and `but open` can open them itself). Until then those links only bring the app to the front.
- **Workspace folders inside a repository.** Discovery handles a workspace folder that's a subdirectory of the repository, but the `**/.git/HEAD` watcher only sees `.git` directories inside workspace folders, so `but setup`/`but teardown` there isn't noticed until a reload.
