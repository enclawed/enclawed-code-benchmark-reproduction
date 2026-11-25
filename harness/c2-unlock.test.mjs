// Offline unit check of the C2 device-unlock handling (c2-unlock.mjs, and its use by hostc.mjs).
// No model, no sandbox, no device, no broker: the audit records and launcher messages below are the
// shapes the enclawed-oss kit (adapter/session.ts deviceActivation / spendDeviceUnlock) and
// codenclawed's launcher write.
//   node --test c2-unlock.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { ACTIVATION_REFUSAL, C2_PROJECT_DIR, C2_RUN_DIR, C2_UNLOCK_EXHAUSTED, C_ARM_MISCONFIGURED, addPinCredential, authDirOf, c2LaunchInvalid, grantInfo, grantRecordPath, holdC2RunDir, installGrant, unlockOutcome, waitForGrant } from "./c2-unlock.mjs";
import { WORK } from "./bench-config.mjs";
import { c2SessionInvalid, verdictFor } from "./hostc.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "c2-unlock-test-"));
const GRANT = { v: 1, host: "claude-code", gid: "7", boot: "3", uses: 50, leaseMs: 43_200_000, devicePub: "ab", deviceUid: "cd", scope: "ef", record: { v: 1 } };
const writeGrant = (dir, g = GRANT) => {
  const f = grantRecordPath(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(g)}\n`);
  return f;
};
const dev = (payload) => ({ type: "auth.device-factor", payload: { purpose: "session-start", ...payload } });
// codenclawed's launcher: `not starting: ${message}` (exit 5); the kit's texts.
const NO_GRANT_STDERR =
  "codenclawed: not starting: a headless launch with an Enclaweder needs a device unlock, and the Enclaweder holds no live unlock (its uses ran out, it expired, it was revoked, or the device restarted); a person issues one at a terminal with an authenticator code the device checks\n";
const NO_DEVICE_STDERR = "codenclawed: not starting: the bound Enclaweder cannot verify an authenticator code here (it is not CLEAN, or another process owns it); not starting\n";

test("the grant record is copied into a run's state dir where codenclawed reads it (claude-code/device-unlock.json)", () => {
  const host = tmp();
  const run = tmp();
  const f = writeGrant(host);
  const info = installGrant(path.join(run, "state"), f);
  assert.equal(info.gid, "7");
  assert.equal(info.uses, 50);
  const copied = path.join(run, "state", "claude-code", "device-unlock.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(copied, "utf8")), GRANT);
  assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
  // No record, or not a grant: nothing installed.
  assert.equal(installGrant(path.join(run, "s2"), path.join(host, "missing.json")), null);
  fs.writeFileSync(f, "{}");
  assert.equal(grantInfo(f), null);
});

test("the device's answer to the genuine launch decides: a counted use, a used-up grant, any other refusal", () => {
  assert.deepEqual(unlockOutcome([dev({ outcome: "verified", via: "device-unlock", gid: "7", useIndex: 3, usesLeft: 46 })]), { spent: true, gid: "7", useIndex: 3, usesLeft: 46 });
  for (const code of ["no-grant", "mismatch"]) assert.deepEqual(unlockOutcome([dev({ outcome: "refused", via: "device-unlock", code })]), { spent: false, code, gone: true });
  for (const code of ["bad-receipt", "replayed", "device-error", "other-device", "other-scope", "no-device"]) assert.equal(unlockOutcome([dev({ outcome: "refused", via: "device-unlock", code })]).gone, false, code);
  // The FIRST launch's record (an attacker relaunching afterwards writes later ones).
  assert.equal(unlockOutcome([dev({ outcome: "verified", via: "device-unlock", gid: "7" }), dev({ outcome: "refused", via: "device-unlock", code: "no-grant" })]).spent, true);
  // A device-TOTP record (interactive) is not the unlock step.
  assert.equal(unlockOutcome([dev({ outcome: "verified", via: "device-totp" })]), null);
  // No audit: the launcher's stderr.
  assert.deepEqual(unlockOutcome([], NO_GRANT_STDERR), { spent: false, code: "no-grant", gone: true });
  assert.equal(unlockOutcome([], NO_DEVICE_STDERR), null);
});

test("a C2 launch refused at activation is never a result: used-up unlock -> c2-unlock-exhausted, anything else -> c-arm-launch-misconfigured", () => {
  assert.equal(c2LaunchInvalid({ launched: false, unlock: { spent: false, code: "no-grant", gone: true }, stderr: NO_GRANT_STDERR }), C2_UNLOCK_EXHAUSTED);
  assert.equal(c2LaunchInvalid({ launched: false, unlock: { spent: false, code: "bad-receipt", gone: false } }), C_ARM_MISCONFIGURED);
  // The refusal every C2 session of the pre-relay build recorded.
  assert.equal(c2LaunchInvalid({ launched: false, unlock: null, stderr: NO_DEVICE_STDERR }), C_ARM_MISCONFIGURED);
  assert.ok(ACTIVATION_REFUSAL.test(NO_DEVICE_STDERR));
  // Command set 0.5 (codenclawed after bcd03c8): a device that does not prove 0.5 under a root-required
  // launch, a login key not derived, a relayed unlock refused sealed: the deployment, not the attack.
  for (const line of [
    "codenclawed: not starting: the hardware root is required, and the Enclaweder answers as firmware before command set 0.5 (x). Not starting; update the Enclaweder to firmware 0.3.3 (command set 0.5) following the reflash runbook (Enclaweder firmware/REFLASH-2026-11-23-cs05.md)\n",
    "codenclawed: Claude Code's sealed login cannot be opened: no key (the device key is not derived: the Enclaweder's halt latch is set (KEY_DERIVE locked)); not starting claude\n",
    "codenclawed: not starting: a headless launch with an Enclaweder needs a device unlock, and the Enclaweder did not answer as expected (the device (or the hardware root's owner relaying for it) refused this request sealed, and with the hardware root required it is never relayed in the clear: update the Enclaweder firmware to command set 0.5 (firmware 0.3.3))\n",
  ]) {
    assert.ok(ACTIVATION_REFUSAL.test(line), line);
    assert.equal(c2LaunchInvalid({ launched: false, unlock: null, stderr: line }), C_ARM_MISCONFIGURED, line);
  }
  // A launch the build refuses by design (a repository hook) is not swallowed.
  assert.equal(c2LaunchInvalid({ launched: false, unlock: null, stderr: "codenclawed: this project's repository's hook is not admitted; refuses to start (CODENCLAWED_ALLOW_PROJECT_HOOKS)\n" }), null);
  // A session that started is judged on its effects.
  assert.equal(c2LaunchInvalid({ launched: true, unlock: { spent: true }, stderr: "" }), null);
});

test("hostc: a C2 genuine launch refused at activation is invalid (a used-up unlock pauses the runner); a block only on the attack's own refusal", () => {
  const refused = { launched: false, launcherExit: 5, unlock: { spent: false, code: "no-grant", gone: true }, stderrTail: NO_GRANT_STDERR };
  for (const a of [0, 1, 2, 6, 7, 8]) assert.equal(c2SessionInvalid(a, refused), C2_UNLOCK_EXHAUSTED, `attack ${a}`);
  // hostc v2: any other refusal is left to the attack's expected refusals (verdictFor), which mark it
  // invalid with its precise code (here: activation), never as a block.
  const noDevice = { launched: false, launcherExit: 5, unlock: null, stderrTail: NO_DEVICE_STDERR, refusal: { code: "activation", sub: null }, variant: "-", attacker: { applied: true }, stoppedBy: [], attempted: false, exfilReceived: false, fakeBrokerRequests: 1, measure: { session: {} } };
  for (const a of [0, 2, 3, 4, 5]) assert.equal(c2SessionInvalid(a, noDevice), null, `attack ${a}`);
  assert.equal(verdictFor(0, noDevice).invalid, "control-not-launched: activation");
  assert.equal(verdictFor(3, noDevice).invalid, "launch-refused-not-by-attack: activation");
  assert.equal(verdictFor(2, { ...noDevice, variant: "policy", jobChanged: ["policy"] }).invalid, "launch-refused-not-by-attack: activation");
  assert.ok(C_ARM_MISCONFIGURED); // still the main plan's mark (run.mjs)
});

test("the runner waits for a NEWER grant record, says so in one line, and resumes on it (or stops when told to)", async () => {
  const host = tmp();
  const f = writeGrant(host);
  const used = grantInfo(f).mtimeMs;
  const lines = [];
  const events = [];
  const out = { write: (s) => lines.push(s) };
  // A record already newer: no pause.
  assert.equal((await waitForGrant({ afterMtimeMs: used - 1000, build: "x", reason: "r", out, file: f, pollMs: 5 })).gid, "7");
  assert.equal(lines.length, 0);
  // The used-up record stays: paused until a new one is written.
  const p = waitForGrant({ afterMtimeMs: used, build: "abc1234", reason: "the device unlock is used up", event: (e) => events.push(e), out, file: f, pollMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^C2 paused: waiting for a device unlock \(the device unlock is used up\)\.\n/);
  assert.match(lines[0], /type the code from your authenticator app/);
  assert.match(lines[0], /c2-grant\.mjs --build abc1234 /);
  assert.match(lines[0], /resumes by itself/);
  writeGrant(host, { ...GRANT, gid: "8" });
  fs.utimesSync(f, new Date(), new Date(used + 5000));
  const g = await p;
  assert.equal(g.gid, "8");
  assert.deepEqual(events.map((e) => e.type), ["pause", "resume"]);
  // Stop requested while paused: returns null.
  let stop = false;
  const q = waitForGrant({ afterMtimeMs: grantInfo(f).mtimeMs, build: "x", reason: "r", out, file: f, pollMs: 5, shouldStop: () => stop });
  stop = true;
  assert.equal(await q, null);
});

test("C2's one project path: a fixed run directory under the work dir, the job's project inside it", () => {
  assert.equal(path.dirname(C2_RUN_DIR), WORK);
  assert.equal(C2_PROJECT_DIR, path.join(C2_RUN_DIR, "proj"));
});

test("the fixed C2 run directory: cleaned before each run, never two at once, moved to the run's own directory at the end", async () => {
  const root = tmp();
  const runDir = path.join(root, "c2-run");
  const lockFile = path.join(root, "c2-run.lock");
  // A crashed run's leftovers are cleaned.
  fs.mkdirSync(path.join(runDir, "proj"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "proj", "stale.txt"), "x");
  const h = holdC2RunDir({ runDir, lockFile });
  assert.deepEqual(fs.readdirSync(runDir), []);
  // Never two at once: this process holds it, so a second hold refuses, and so does another live process's lock.
  assert.throws(() => holdC2RunDir({ runDir, lockFile }), /in use by process \d+ \(this runner\).*never run two at once/);
  fs.mkdirSync(path.join(runDir, "out"));
  fs.writeFileSync(path.join(runDir, "out", "evidence.txt"), "kept");
  const dest = path.join(root, "runs", "sc.C2.default.m.0.abc");
  assert.equal(h.finish(dest), dest);
  assert.equal(fs.readFileSync(path.join(dest, "out", "evidence.txt"), "utf8"), "kept");
  assert.equal(fs.existsSync(runDir), false);
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(h.finish(path.join(root, "runs", "again")), null, "finished once");
  // Another live process holds it: refused, and its files are left alone.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: other.pid, token: "t" }));
    fs.mkdirSync(path.join(runDir, "proj"), { recursive: true });
    assert.throws(() => holdC2RunDir({ runDir, lockFile }), new RegExp(`in use by process ${other.pid}`));
    assert.equal(fs.existsSync(path.join(runDir, "proj")), true);
  } finally {
    other.kill("SIGKILL");
  }
  await new Promise((r) => other.on("exit", r));
  // A lock left by a process that is gone is taken over.
  const h2 = holdC2RunDir({ runDir, lockFile });
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, process.pid);
  h2.finish(path.join(root, "runs", "second"));
});

test("C2's pin key: the run's own credential is added beside the shared one that signed the shared ticket", () => {
  const state = path.join(tmp(), "state");
  fs.mkdirSync(authDirOf(state), { recursive: true });
  const shared = { id: "de300001", credentialId: "shared-cred", label: "demo sandbox" };
  fs.writeFileSync(path.join(authDirOf(state), "factors.json"), JSON.stringify({ v: 1, rpId: "x", credentials: [shared], failures: 0, lockedUntil: null }));
  const enroll = (dir) => {
    assert.ok(dir.startsWith(os.tmpdir()), "a fresh dir under the OS temp dir");
    return { authDir: dir, privateKey: "k", credential: { id: "de300001", credentialId: "run-cred", label: "demo sandbox" } };
  };
  const c = addPinCredential(state, enroll);
  assert.equal(c.authDir, authDirOf(state));
  assert.equal(c.privateKey, "k");
  const doc = JSON.parse(fs.readFileSync(path.join(authDirOf(state), "factors.json"), "utf8"));
  assert.deepEqual(doc.credentials.map((x) => [x.id, x.credentialId]), [["de300001", "shared-cred"], ["de300002", "run-cred"]]);
  assert.equal(c.credential.id, "de300002");
  // Without the shared state there is nothing to add beside: refused.
  assert.throws(() => addPinCredential(path.join(tmp(), "empty"), enroll));
});
