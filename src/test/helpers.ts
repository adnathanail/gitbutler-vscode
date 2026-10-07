import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Status } from "../but";
import type { ExtensionApi } from "../extension";
import { ChangeResource, Repository } from "../repository";

const EXTENSION_ID = "adnathanail.gitbutler-vscode";

/** Set by `.vscode-test.mjs`. HOME points inside it, so `but` never touches the real GitButler data. */
const fixtures = process.env.GITBUTLER_TEST_FIXTURES!;

const log = vscode.window.createOutputChannel("GitButler Tests");

/** Activates the extension and waits for it to load the repositories in the workspace. */
export async function activate(): Promise<ExtensionApi> {
  const api = await vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.activate();
  await api.ready;
  return api;
}

let repoCount = 0;

/** A fresh GitButler repository, separate from the workspace folder, for tests that change state. */
export class TestRepo {
  readonly root: string;
  private readonly repositories: Repository[] = [];

  constructor() {
    this.root = path.join(fixtures, `repo-${process.pid}-${repoCount++}`);
    fs.mkdirSync(this.root, { recursive: true });
    this.git("init", "-q");
    this.git("commit", "-q", "--allow-empty", "-m", "Initial commit");
    this.but("setup", "--json");
  }

  path(relative: string): string {
    return path.join(this.root, relative);
  }

  write(relative: string, content: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(this.path(relative)), { recursive: true });
    fs.writeFileSync(this.path(relative), content);
  }

  remove(relative: string): void {
    fs.rmSync(this.path(relative));
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8" });
  }

  but(...args: string[]): string {
    return execFileSync("but", args, { cwd: this.root, encoding: "utf8" });
  }

  status(): Status {
    return JSON.parse(this.but("status", "-f", "--json"));
  }

  /** Writes a file and commits it with `but`, on the given branch (created if needed). */
  commit(relative: string, content: string | Uint8Array, message: string, branch: string): void {
    this.write(relative, content);
    this.but("commit", "--json", "-m", message, "--branch", branch, "--", relative);
  }

  /** A loaded extension Repository for this repo. Disposed by `dispose()`. */
  async repository(): Promise<Repository> {
    const { revisions } = await activate();
    const repository = new Repository(this.root, log, revisions);
    this.repositories.push(repository);
    await repository.refresh();
    return repository;
  }

  dispose(): void {
    this.repositories.forEach((r) => r.dispose());
  }
}

/**
 * Creates a TestRepo per test and disposes it afterwards, closing any editors the test opened.
 * Call inside a `describe` block.
 */
export function useTestRepo(): () => TestRepo {
  let repo: TestRepo | undefined;
  beforeEach(() => {
    repo = new TestRepo();
  });
  afterEach(async () => {
    repo?.dispose();
    repo = undefined;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
  return () => repo!;
}

/** The change at a repo-relative path in a Source Control panel group. */
export function resource(group: vscode.SourceControlResourceGroup, filePath: string): ChangeResource {
  const found = (group.resourceStates as ChangeResource[]).find((r) => r.change.filePath === filePath);
  assert.ok(found, `${filePath} isn't in ${group.label}`);
  return found;
}

/** Repo-relative paths of the changes in a Source Control panel group. */
export function paths(group: vscode.SourceControlResourceGroup): string[] {
  return (group.resourceStates as ChangeResource[]).map((r) => r.change.filePath);
}

/** Collects errors the extension shows to the user while the test runs. */
export function collectErrors(api: ExtensionApi): { errors: string[]; dispose(): void } {
  const errors: string[] = [];
  const subscription = api.onDidShowError((message) => errors.push(message));
  return { errors, dispose: () => subscription.dispose() };
}

export function activeDiff(): vscode.TabInputTextDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input : undefined;
}

/**
 * Replaces `vscode.window.showInformationMessage` with one that records messages and answers with
 * `answer`, or with what `answer` returns given the message and its buttons.
 */
export function stubInformationMessage(answer?: MessageAnswer): { calls: string[]; restore(): void } {
  return stubMessage("showInformationMessage", answer);
}

/** As `stubInformationMessage`, for `vscode.window.showWarningMessage`. */
export function stubWarningMessage(answer?: MessageAnswer): { calls: string[]; restore(): void } {
  return stubMessage("showWarningMessage", answer);
}

type MessageAnswer = string | ((message: string, items: string[]) => string | undefined);

function stubMessage(
  name: "showInformationMessage" | "showWarningMessage",
  answer?: MessageAnswer,
): { calls: string[]; restore(): void } {
  const window = vscode.window as Record<typeof name, unknown>;
  const original = window[name];
  const calls: string[] = [];
  window[name] = async (message: string, ...rest: unknown[]) => {
    calls.push(message);
    // Modal messages pass an options object before the buttons.
    const items = rest.filter((item): item is string => typeof item === "string");
    return typeof answer === "function" ? answer(message, items) : answer;
  };
  return { calls, restore: () => (window[name] = original) };
}

/**
 * Replaces `vscode.window.showInputBox` with one that records the options it's shown with and
 * answers with `answer`, or `undefined` to cancel.
 */
export function stubInputBox(answer?: string): { calls: vscode.InputBoxOptions[]; restore(): void } {
  const window = vscode.window as { showInputBox: unknown };
  const original = window.showInputBox;
  const calls: vscode.InputBoxOptions[] = [];
  window.showInputBox = async (options: vscode.InputBoxOptions = {}) => {
    calls.push(options);
    return answer;
  };
  return { calls, restore: () => (window.showInputBox = original) };
}

/** An in-memory stand-in for `ExtensionContext.workspaceState`. */
export class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

/** Polls until `condition` is true, failing with `message` after `timeout` ms. */
export async function waitFor(condition: () => boolean, message: string, timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
