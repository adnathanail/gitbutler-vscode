import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { TESTED_BUT_VERSION } from "../but";
import { checkButVersion, OPEN_SETTINGS, parseButVersion } from "../version";
import { MemoryMemento, stubInformationMessage, stubWarningMessage } from "./helpers";

const log = vscode.window.createOutputChannel("GitButler Version Tests");

let scriptCount = 0;

/** A script that prints `output` and exits, standing in for `but --version`. */
function butPrinting(output: string, exitCode = 0): string {
  const script = path.join(process.env.GITBUTLER_TEST_FIXTURES!, `version-but-${Date.now()}-${scriptCount++}`);
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`, { mode: 0o755 });
  return script;
}

/** `TESTED_BUT_VERSION` with `change` applied to its [major, minor, patch]. */
function testedWith(change: (version: [number, number, number]) => void): string {
  const version = parseButVersion(`but ${TESTED_BUT_VERSION}`)!;
  change(version);
  return `but ${version.join(".")}`;
}

describe("`but` version check", () => {
  const stubs: { restore(): void }[] = [];
  let info: { calls: string[] };
  let warning: { calls: string[] };
  let errorCalls: string[];
  let errorButtons: string[][];

  beforeEach(() => {
    const infoStub = stubInformationMessage();
    const warningStub = stubWarningMessage();
    info = infoStub;
    warning = warningStub;
    errorCalls = [];
    errorButtons = [];
    const window = vscode.window as { showErrorMessage: unknown };
    const original = window.showErrorMessage;
    window.showErrorMessage = async (message: string, ...items: string[]) => {
      errorCalls.push(message);
      errorButtons.push(items);
      return undefined;
    };
    stubs.push(infoStub, warningStub, { restore: () => (window.showErrorMessage = original) });
  });

  afterEach(() => {
    stubs.splice(0).forEach((s) => s.restore());
  });

  it("matches the GitButler version CI installs", () => {
    const action = fs.readFileSync(path.join(__dirname, "../../.github/actions/install-gitbutler/action.yml"), "utf8");
    const pinned = /GITBUTLER_VERSION: *([^\s-]+)-/.exec(action)?.[1];
    assert.strictEqual(TESTED_BUT_VERSION, pinned);
  });

  it("says nothing about the tested version, or another patch release of it", async () => {
    await checkButVersion(butPrinting(`but ${TESTED_BUT_VERSION}`), log, new MemoryMemento());
    await checkButVersion(butPrinting(testedWith((v) => (v[2] += 1))), log, new MemoryMemento());
    if (parseButVersion(`but ${TESTED_BUT_VERSION}`)![2] > 0) {
      await checkButVersion(butPrinting(testedWith((v) => (v[2] = 0))), log, new MemoryMemento());
    }
    assert.deepStrictEqual([...info.calls, ...warning.calls, ...errorCalls], []);
  });

  it("warns about an older minor version every time", async () => {
    const older = butPrinting(testedWith((v) => ((v[1] -= 1), (v[2] = 9))));
    const state = new MemoryMemento();
    await checkButVersion(older, log, state);
    await checkButVersion(older, log, state);
    assert.strictEqual(warning.calls.length, 2);
    assert.match(warning.calls[0], /older than/);
    assert.deepStrictEqual(info.calls, []);
  });

  it("mentions a newer minor version once", async () => {
    const state = new MemoryMemento();
    await checkButVersion(butPrinting(testedWith((v) => ((v[1] += 1), (v[2] = 0)))), log, state);
    await checkButVersion(butPrinting(testedWith((v) => ((v[1] += 1), (v[2] = 1)))), log, state);
    assert.strictEqual(info.calls.length, 1);
    assert.match(info.calls[0], /newer than/);

    await checkButVersion(butPrinting(testedWith((v) => ((v[1] += 2), (v[2] = 0)))), log, state);
    assert.strictEqual(info.calls.length, 2);
    assert.deepStrictEqual(warning.calls, []);
  });

  it("mentions a newer major version, and each minor version within it", async () => {
    const state = new MemoryMemento();
    await checkButVersion(butPrinting(testedWith((v) => ((v[0] += 1), (v[1] = 0), (v[2] = 0)))), log, state);
    await checkButVersion(butPrinting(testedWith((v) => ((v[0] += 1), (v[1] = 1), (v[2] = 0)))), log, state);
    assert.strictEqual(info.calls.length, 2);
  });

  it("says nothing when the version can't be read or `but` fails", async () => {
    await checkButVersion(butPrinting("but nightly"), log, new MemoryMemento());
    await checkButVersion(butPrinting("Error: something went wrong", 1), log, new MemoryMemento());
    assert.deepStrictEqual([...info.calls, ...warning.calls, ...errorCalls], []);
  });

  it("offers the setting when `but` isn't found", async () => {
    const missing = path.join(process.env.GITBUTLER_TEST_FIXTURES!, "no-such-but");
    await checkButVersion(missing, log, new MemoryMemento());
    assert.strictEqual(errorCalls.length, 1);
    assert.ok(errorCalls[0].includes(missing), errorCalls[0]);
    assert.deepStrictEqual(errorButtons, [[OPEN_SETTINGS]]);
  });
});
