import * as vscode from "vscode";

/** Workspace state key: URIs of workspace folders the user said not to ask about again. */
const DISMISSED_KEY = "gitbutlerVscode.disableGitPromptDismissed";

/** Workspace state key: folders where this extension disabled Git, as {@link DisabledRecord}s. */
const DISABLED_KEY = "gitbutlerVscode.gitDisabledFolders";

interface DisabledRecord {
  folder: string;
  /** The settings level `git.enabled` was set at. */
  target: "workspace" | "workspaceFolder";
}

export const DISABLE_GIT = "Disable Git Integration";
export const DONT_ASK_AGAIN = "Don't Ask Again";
export const REENABLE_GIT = "Re-enable Git Integration";
export const KEEP_DISABLED = "Keep Disabled";

/**
 * Suggests turning off VS Code's built-in Git integration for a workspace folder whose repository
 * is managed by GitButler, because committing with it on the `gitbutler/workspace` branch bypasses
 * GitButler.
 *
 * Does nothing if Git is already disabled for the repository, the user previously chose "Don't Ask
 * Again" for the folder, or `gitbutlerVscode.suggestDisablingGit` is off.
 */
export async function suggestDisablingGit(
  folder: vscode.WorkspaceFolder,
  repositoryRoot: vscode.Uri,
  state: vscode.Memento,
): Promise<void> {
  if (!vscode.workspace.getConfiguration("gitbutlerVscode").get<boolean>("suggestDisablingGit", true)) {
    return;
  }
  // The Git extension reads this setting for the repository root, which may be above the folder.
  if (vscode.workspace.getConfiguration("git", repositoryRoot).get<boolean>("enabled") !== true) {
    return;
  }
  const dismissed = state.get<string[]>(DISMISSED_KEY, []);
  if (dismissed.includes(folder.uri.toString())) {
    return;
  }

  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const choice = await vscode.window.showInformationMessage(
    `${folder.name} is managed by GitButler. Committing with VS Code's Git integration on the ` +
      `gitbutler/workspace branch bypasses GitButler. Disable Git integration for this ` +
      `${multiRoot ? "folder" : "workspace"}?`,
    DISABLE_GIT,
    DONT_ASK_AGAIN,
  );

  if (choice === DISABLE_GIT) {
    // In a single-folder window the workspace settings are the folder's .vscode/settings.json.
    const target = multiRoot ? "workspaceFolder" : "workspace";
    await vscode.workspace.getConfiguration("git", folder.uri).update("enabled", false, configurationTarget(target));
    await forgetDisabled(folder, state);
    await state.update(DISABLED_KEY, [
      ...state.get<DisabledRecord[]>(DISABLED_KEY, []),
      { folder: folder.uri.toString(), target },
    ]);
  } else if (choice === DONT_ASK_AGAIN) {
    await state.update(DISMISSED_KEY, [...state.get<string[]>(DISMISSED_KEY, []), folder.uri.toString()]);
  }
}

/** Whether this extension disabled Git for the folder and hasn't re-enabled it since. */
export function isGitDisabledByExtension(folder: vscode.WorkspaceFolder, state: vscode.Memento): boolean {
  return state.get<DisabledRecord[]>(DISABLED_KEY, []).some((r) => r.folder === folder.uri.toString());
}

/**
 * Offers to re-enable Git integration for a folder that's no longer managed by GitButler, if this
 * extension disabled it. Re-enabling removes the setting rather than setting it to true, so the
 * folder goes back to whatever it would otherwise inherit.
 *
 * If the setting has been changed since, the user is managing it themselves, so the folder is
 * forgotten without asking.
 */
export async function suggestReenablingGit(folder: vscode.WorkspaceFolder, state: vscode.Memento): Promise<void> {
  const record = state.get<DisabledRecord[]>(DISABLED_KEY, []).find((r) => r.folder === folder.uri.toString());
  if (!record) {
    return;
  }
  const target = configurationTarget(record.target);
  const config = vscode.workspace.getConfiguration("git", folder.uri);
  const inspected = config.inspect<boolean>("enabled");
  const value = record.target === "workspace" ? inspected?.workspaceValue : inspected?.workspaceFolderValue;
  if (value !== false) {
    await forgetDisabled(folder, state);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `${folder.name} is no longer managed by GitButler. Re-enable VS Code's Git integration, which ` +
      `the GitButler extension disabled?`,
    REENABLE_GIT,
    KEEP_DISABLED,
  );

  if (choice === REENABLE_GIT) {
    await config.update("enabled", undefined, target);
    await forgetDisabled(folder, state);
  } else if (choice === KEEP_DISABLED) {
    await forgetDisabled(folder, state);
  }
}

async function forgetDisabled(folder: vscode.WorkspaceFolder, state: vscode.Memento): Promise<void> {
  const records = state.get<DisabledRecord[]>(DISABLED_KEY, []);
  await state.update(
    DISABLED_KEY,
    records.filter((r) => r.folder !== folder.uri.toString()),
  );
}

function configurationTarget(target: DisabledRecord["target"]): vscode.ConfigurationTarget {
  return target === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.WorkspaceFolder;
}
