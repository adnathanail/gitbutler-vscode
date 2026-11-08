import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { TESTED_BUT_VERSION } from "./but";

/** Global state key: release lines (see {@link releaseLine}) of newer `but` versions already reported. */
const REPORTED_KEY = "gitbutlerVscode.reportedButVersions";

export const OPEN_SETTINGS = "Open Settings";

/** The version in `but --version` output, such as "but 0.23.2", as [major, minor, patch]. */
export function parseButVersion(output: string): [number, number, number] | undefined {
  const match = /^but (\d+)\.(\d+)\.(\d+)\b/.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * The part of a version that changes when `but` may break compatibility: the major and minor
 * versions. Patch releases are assumed compatible.
 */
export function releaseLine([major, minor]: [number, number, number]): number[] {
  return [major, minor];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * Runs `<butPath> --version` and tells the user if it isn't the release line the extension was
 * tested against. An older one gets a warning every time, since `but`'s commands and JSON output
 * change between releases. A newer one gets an information message once per release line, since
 * the GitButler app updates itself, and so `but`, ahead of the extension. `but` not being found is
 * an error with a button for the `gitbutlerVscode.butPath` setting.
 */
export async function checkButVersion(butPath: string, log: vscode.OutputChannel, state: vscode.Memento): Promise<void> {
  log.appendLine(`> ${butPath} --version`);
  let output: string;
  try {
    output = await new Promise<string>((resolve, reject) =>
      execFile(butPath, ["--version"], (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout))),
    );
  } catch (err) {
    const { code, message, stderr } = err as NodeJS.ErrnoException & { stderr: string };
    log.appendLine(stderr.trim() || message);
    if (code === "ENOENT") {
      const choice = await vscode.window.showErrorMessage(
        `GitButler's \`but\` CLI wasn't found at \`${butPath}\`. Install GitButler, or set gitbutlerVscode.butPath.`,
        OPEN_SETTINGS,
      );
      if (choice === OPEN_SETTINGS) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "gitbutlerVscode.butPath");
      }
    }
    return;
  }
  log.appendLine(output.trim());

  const version = parseButVersion(output);
  if (!version) {
    log.appendLine(`Couldn't read the \`but\` version, so it wasn't checked against ${TESTED_BUT_VERSION}.`);
    return;
  }
  const installed = releaseLine(version);
  const tested = releaseLine(parseButVersion(`but ${TESTED_BUT_VERSION}`)!);
  const comparison = compare(installed, tested);
  const name = version.join(".");
  if (comparison < 0) {
    await vscode.window.showWarningMessage(
      `GitButler's \`but\` CLI is version ${name}, older than the ${TESTED_BUT_VERSION} this extension was tested with. ` +
        "Some features may not work until GitButler is updated.",
    );
  } else if (comparison > 0) {
    const key = installed.join(".");
    const reported = state.get<string[]>(REPORTED_KEY, []);
    if (reported.includes(key)) {
      return;
    }
    await state.update(REPORTED_KEY, [...reported, key]);
    await vscode.window.showInformationMessage(
      `GitButler's \`but\` CLI is version ${name}, newer than the ${TESTED_BUT_VERSION} this extension was tested with. ` +
        "If something doesn't work, check for an update to the extension.",
    );
  }
}
