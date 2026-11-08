import { defineConfig } from "@vscode/test-cli";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Every test run gets a fresh HOME, so `but` registers test repositories in a throwaway GitButler
// project list instead of the real one, and git commits use a fixed identity.
// The newest VS Code version the extension is tested on, raised by hand after trying a new release.
const MAX_VSCODE_VERSION = "1.139.1";
// The oldest, from `engines.vscode` (e.g. "^1.98.0").
const MIN_VSCODE_VERSION = JSON.parse(fs.readFileSync("package.json", "utf8")).engines.vscode.replace(/^\^/, "");

const fixtures = path.resolve(".vscode-test/fixtures");
const home = path.join(fixtures, "home");
const workspace = path.join(fixtures, "workspace");
fs.rmSync(fixtures, { recursive: true, force: true });
// Workspace state (e.g. folders the extension disabled Git for) would otherwise carry over between
// runs, because the fixture workspace has the same path each time.
fs.rmSync(path.resolve(".vscode-test/user-data/User/workspaceStorage"), { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const env = { ...process.env, HOME: home };
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: workspace, env, stdio: "pipe" });
sh("git", ["config", "--global", "user.name", "Test"]);
sh("git", ["config", "--global", "user.email", "test@example.com"]);
sh("git", ["config", "--global", "init.defaultBranch", "main"]);

// The window opens on a GitButler repository so the extension discovers it on activation. Running
// any `but` command makes a repository a GitButler repository.
sh("git", ["init", "-q"]);
sh("git", ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
sh("but", ["status", "--json"]);

export default defineConfig({
  files: "out/test/**/*.test.js",
  // VSCODE_VERSION is "min", "max" (the default) or an exact version.
  version:
    { min: MIN_VSCODE_VERSION, max: MAX_VSCODE_VERSION }[process.env.VSCODE_VERSION ?? "max"] ??
    process.env.VSCODE_VERSION,
  workspaceFolder: workspace,
  // With HOME replaced, macOS has no keychain to offer and blocks the window with a prompt, so use
  // Chromium's mock keychain. VS Code doesn't know that flag and would read the workspace folder
  // (appended to these arguments) as its value, so a flag VS Code does know must come last.
  launchArgs: ["--use-mock-keychain", "--disable-extensions"],
  env: {
    HOME: home,
    GITBUTLER_TEST_FIXTURES: fixtures,
    // `but` and git are resolved from this PATH, in case VS Code doesn't load the login shell's.
    PATH: process.env.PATH,
  },
  mocha: {
    ui: "bdd",
    timeout: 20000,
  },
});
