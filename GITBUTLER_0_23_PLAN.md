# Plan: support GitButler 0.23

GitButler 0.23 only checks out `gitbutler/workspace` (with its merge commit) when two or more
stacks are applied. With one stack applied, or none, `HEAD` stays on an ordinary branch, and
`but setup` no longer does anything. The extension currently treats a folder as a GitButler
repository only when `gitbutler/workspace` is checked out, so it finds nothing in single-branch
repositories.

Each phase ends with `npm test` passing, and a pause for review and committing before the next one.

## Phase 1: pin GitButler 0.23.2 in CI

1. Get `<version>-<build>` for 0.23.2 from the update endpoint
   (`https://app.gitbutler.com/releases/release/darwin-aarch64/0.0.0`) or Homebrew's cask, and the
   archive's SHA-256 (from the cask, or by downloading the archive and running `shasum -a 256`).
2. Update `GITBUTLER_VERSION` and `GITBUTLER_SHA256` in `.github/actions/install-gitbutler/action.yml`.
3. Update the version in the README, and the example URL comment in
   `.github/workflows/update-gitbutler.yml`.
4. Run `npm test` locally against `but` 0.23.2, which is already installed, and record what fails.
   Discovery tests are expected to fail: `.vscode-test.mjs` runs `but setup`, which no longer
   checks out `gitbutler/workspace`. Fix only what the version bump breaks directly, such as JSON
   type changes in `src/but.ts`. Anything that depends on detection waits for phase 2.
   - This phase can't pass on its own. Either commit it together with phase 2, or commit it with
     the failing tests listed and phase 2 straight after. I suggest committing them together, with
     phase 1 as its own commit in the same branch.

### Phase 1 results

Done: pinned 0.23.2-3329 (checksum checked against the downloaded archive), and fixed what the
version bump broke directly:

- `but config target --json` reports `remote_url: null` for a local target branch.
  `src/but.ts` and `src/repository.ts` handle it.
- `but config target origin/main` needs a local branch tracking `origin/main`, so `setTarget` in
  `src/test/helpers.ts` sets `main`'s upstream first.
- `zz` is rejected as a target everywhere, so the rename regression test creates its `zz` branch
  with `but branch new` and commits to it by CLI ID.
- A file staged and then deleted is no longer reported as `removed`, so the git index test checks
  git's index instead.

Still failing, as expected: 6 discovery tests (phase 2), and 6 Source Control Graph and Target
Branch view tests (phase 3).

## Phase 2: detect GitButler repositories by their metadata

A repository is a GitButler repository when `.git/gitbutler/virtual_branches.toml` exists. Any
`but` command creates it, along with `gitbutler.project.*` keys in `.git/config` and an entry in
the global `projects.json`.

1. `findRepositories` in `src/extension.ts`: replace the branch check with a check for that file.
   Use the git directory from `git rev-parse --git-common-dir` rather than assuming `<root>/.git`,
   so worktrees and `.git` files work.
2. Edit mode: check whether 0.23 still checks out `gitbutler/edit`. If it does, keep treating it
   as "managed, but don't show". If it doesn't, remove `EDIT_BRANCH` and its test.
3. Watchers: as well as `**/.git/HEAD`, watch `**/.git/gitbutler/virtual_branches.toml` being
   created and deleted, so running `but` for the first time in an open folder is noticed.
4. Never run `but` in a folder that hasn't been detected. Every `but` call creates the metadata,
   so running one to probe a folder would adopt it as a GitButler project. Add a comment saying so
   where discovery happens.
5. Tests:
   - `.vscode-test.mjs`: the fixture workspace still needs to become a GitButler repository. Check
     that `but setup` still creates the metadata; if it doesn't, run `but status --json` instead.
     Update its comment.
   - `src/test/helpers.ts` (`useTestRepo`): the same check for test repositories.
   - `src/test/discovery.test.ts`: tests that check out `main` and then `gitbutler/workspace`
     become tests that remove `.git/gitbutler/` and recreate it (by running `but status`). Add
     tests that a repository is found with a single branch checked out, and that a plain git
     repository is not found.
6. Update CLAUDE.md: the "Discovery" design decision, how detection works, and the rule about
   never probing with `but`.

### Phase 2 results

Done. Discovery finds repositories by GitButler's metadata, with a watcher for it appearing.
101 tests pass; the 6 failures left are the Source Control Graph and Target Branch view (phase 3).

Differences from the plan above:

- The marker is the `.git/gitbutler/` directory rather than `virtual_branches.toml`. The 0.23
  binary also mentions `project_meta.toml` and keeps settings in git config
  (`gitbutler.project.portedmeta`), so individual files inside may move between releases. The
  watcher only watches the directory itself, since its contents change on every `but` command.
- It uses `git rev-parse --git-dir`, not `--git-common-dir`, so linked worktrees (including
  GitButler 0.23's own, in `~/.gitbutler-worktrees/`) aren't found, as before. Whether the
  extension works in them is untested.
- `but setup` creates nothing in 0.23, so the test fixtures run `but status --json` instead.
- Edit mode still exists in 0.23 (`refs/heads/gitbutler/edit` and "Entered edit mode" are in the
  binary, and `but resolve` enters it for conflicts), so its handling stays.

Found along the way:

- A repository open in the extension can't stop being a GitButler repository: the extension's
  own `but status` recreates `.git/gitbutler/` straight away. Discovery tests remove it in edit
  mode, when the extension has no repository refreshing it.
- So the "re-enable Git" suggestion is now only reachable on activation, or after edit mode in a
  repository whose metadata was deleted. This feeds into the Git integration decision in phase 3.
- Without remotes, `but config push-remote` fails, and there's no `gb-local` remote any more.
  The extension already handles the error.

## Phase 3: remove other assumptions about `gitbutler/workspace`

1. **Source Control Graph** (`src/history.ts`): the current ref is hardcoded to
   `refs/heads/gitbutler/workspace`. Use whatever `HEAD` points at: `gitbutler/workspace` with two
   or more stacks, otherwise the checked-out branch, or the commit itself if `HEAD` is detached.
   Update `history.test.ts`, which expects the `gitbutler/workspace` badge, to cover both cases.
   The target can now be a local branch (e.g. `main`), but the Graph looks it up as
   `refs/remotes/<target>`. Look it up under `refs/heads/` as well. Several Graph tests also
   expect "GitButler Workspace Commit" in history with a single stack.
   **Done.** The current ref is read with `git symbolic-ref HEAD` (falling back to `HEAD` itself
   when detached), and the target is looked up under `refs/remotes/`, then `refs/heads/`. The
   current ref is left out of the applied branches and the target so commits aren't badged twice.
   New tests cover one stack applied, none applied, a local target, and a detached `HEAD`. All
   111 tests pass, including the Target Branch view's.
2. **Target Branch view** (`src/targetView.ts`): uses the current ref's revision as "the
   workspace" when working out which target commits are upstream. This follows from step 1, but
   needs a test with a single branch.
   **Done.** No logic change was needed: the current ref from 3.1 is the right baseline in every
   case. Renamed `workspace` to `current` in `src/targetView.ts`, and added tests with two stacks
   applied, with none applied (fetched commits are upstream), and with a local target.
3. **Comments and docs** that describe `HEAD` as the workspace commit, in `src/repository.ts`
   and `src/history.ts`, and in CLAUDE.md ("HEAD is the GitButler workspace commit", the
   Source Control Graph design decisions). `HEAD:<path>` is still the right baseline for
   uncommitted changes, since `HEAD` is the branch tip or the workspace commit.
   **Done.** Updated comments in `src/repository.ts`, the README's Requirements, discovery and
   Git graph text, and CLAUDE.md's `HEAD` baseline note, `src/history.ts` row and Target Branch
   view command. `updateHead` needed no change: it compares the merge base and applied commits,
   which determine HEAD's contents whether or not it's a workspace commit. The Git integration
   wording in `src/gitIntegration.ts` and the README is left for step 4.
4. **Git integration suggestion** (`src/gitIntegration.ts`): its message says committing with Git
   "on the gitbutler/workspace branch bypasses GitButler". Check what happens when committing with
   Git while a single branch is checked out under 0.23. Then either reword the message for both
   cases, or only suggest disabling Git while `gitbutler/workspace` is checked out. This is a
   decision for you once the behaviour is known.
5. **`but teardown`** only works on `gitbutler/workspace` in 0.23 and isn't needed otherwise.
   Update mentions in CLAUDE.md and test comments.
6. **New `but` behaviour to record in CLAUDE.md**, checked against 0.23.2:
   - Committing with no stacks applied while the target branch (`main`) is checked out. Check
     where the commit goes and what `HEAD` becomes, since the extension relies on "with none it
     creates a branch".
   - The uncommitted area's CLI ID is now `@` instead of `zz`. The extension passes paths, so this
     is probably only a note, but check the `zz` ambiguity note under `but reword <branch>`.
   - Update every "0.22.3" in CLAUDE.md and `src/but.ts` once its behaviour has been rechecked.

## Out of scope

- New 0.23 features: `but split`, stable hunk IDs in `but diff` (relevant to the "Commit
  individual hunks" next step), worktrees and `.worktreeinclude`, `but init`. Add them to Next
  steps in CLAUDE.md if any look worth doing.
