import * as vscode from "vscode";

/** Workspace state key: URIs of workspace folders the user said not to ask about again. */
const DISMISSED_KEY = "gitbutlerVscode.disableGitPromptDismissed";

export const DISABLE_GIT = "Disable Git Integration";
export const DONT_ASK_AGAIN = "Don't Ask Again";

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
    const target = multiRoot ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    await vscode.workspace.getConfiguration("git", folder.uri).update("enabled", false, target);
  } else if (choice === DONT_ASK_AGAIN) {
    await state.update(DISMISSED_KEY, [...dismissed, folder.uri.toString()]);
  }
}
