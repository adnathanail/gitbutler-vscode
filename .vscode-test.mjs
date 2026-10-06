import { defineConfig } from "@vscode/test-cli";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Every test run gets a fresh HOME, so `but setup` registers test repositories in a throwaway
// GitButler project list instead of the real one, and git commits use a fixed identity.
const fixtures = path.resolve(".vscode-test/fixtures");
const home = path.join(fixtures, "home");
const workspace = path.join(fixtures, "workspace");
fs.rmSync(fixtures, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const env = { ...process.env, HOME: home };
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: workspace, env, stdio: "pipe" });
sh("git", ["config", "--global", "user.name", "Test"]);
sh("git", ["config", "--global", "user.email", "test@example.com"]);
sh("git", ["config", "--global", "init.defaultBranch", "main"]);

// The window opens on a GitButler repository so the extension discovers it on activation.
sh("git", ["init", "-q"]);
sh("git", ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
sh("but", ["setup", "--json"]);

export default defineConfig({
  files: "out/test/**/*.test.js",
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
