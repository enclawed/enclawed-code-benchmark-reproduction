// Offline check of the login guard (hostc/login-guard.mjs): no claude, no model, no device, no real
// login. Every credentials file here is a FAKE in a temp dir, filled with marker strings that must
// never come back out of the guard (results, events, printed lines, errors, CLI output).
//   node --test login-guard.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  KIT_REFRESH_RECORD,
  REFRESH_MARGIN_MS,
  SEALED_LOGIN_REL,
  SLACK_MS,
  WAIT_LINE,
  copyRefreshed,
  findExpiresAt,
  loginBindProblem,
  loginExpiry,
  loginRemainingMs,
  loginSealWiring,
  readExpiryNote,
  requiredLoginValidityMs,
  stopBatchForLoginRefresh,
  waitForLoginValidity,
  watchSealedLogin,
} from "./hostc/login-guard.mjs";
import { runBench } from "./sandbox-ext.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "login-guard-test-"));
const MARKERS = ["FAKE-ACCESS-TOKEN-7f3a", "FAKE-REFRESH-TOKEN-91bc", "fake-account-uuid-55aa", "fake.person@example.invalid", "FAKE-MCP-TOKEN-0d0d"];
const assertNoSecret = (what, x) => {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  for (const m of MARKERS) assert.ok(!s.includes(m), `${what} leaked ${m}`);
};
/** A Claude Code-shaped credentials file (fake values only). */
const fakeLogin = (expiresAt, extra = {}) => ({
  claudeAiOauth: { accessToken: MARKERS[0], refreshToken: MARKERS[1], expiresAt, scopes: ["user:inference"], subscriptionType: "max" },
  account: { uuid: MARKERS[2], email: MARKERS[3] },
  mcpOAuth: { "some-server|abc": { accessToken: MARKERS[4], expiresAt: 1 } },
  ...extra,
});
const writeLogin = (dir, doc) => {
  const f = path.join(dir, ".credentials.json");
  fs.writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc), { mode: 0o600 });
  return f;
};

test("findExpiresAt: the login's expiry (shallowest numeric expiresAt), never a deeper MCP one", () => {
  assert.equal(findExpiresAt(fakeLogin(1_800_000_000_000)), 1_800_000_000_000);
  assert.equal(findExpiresAt({ a: { b: { expiresAt: 5 } }, c: { expiresAt: 9 } }), 9);
  assert.equal(findExpiresAt({ x: { expiresAt: 7 }, y: { expiresAt: 3 } }), 3, "same depth: the earliest");
  assert.equal(findExpiresAt({ claudeAiOauth: { expiresAt: "1800000000000" } }), null, "a string is not taken");
  assert.equal(findExpiresAt({ claudeAiOauth: { accessToken: "x" } }), null);
  assert.equal(findExpiresAt(null), null);
  assert.equal(findExpiresAt([{ expiresAt: 4 }]), 4);
});

test("loginExpiry / loginRemainingMs: the expiry only; fixed codes; no other field ever returned", () => {
  const d = tmp();
  const f = writeLogin(d, fakeLogin(2_000_000));
  const e = loginExpiry(f);
  assert.deepEqual(e, { code: "ok", expiresAt: 2_000_000 });
  assert.deepEqual(loginRemainingMs(f, 500_000), { code: "ok", remainingMs: 1_500_000 });
  assert.deepEqual(loginRemainingMs(f, 3_000_000), { code: "ok", remainingMs: -1_000_000 });
  assertNoSecret("loginExpiry", e);
  // Not JSON: the parser's own message would quote the file; the guard returns a code only.
  const bad = writeLogin(d, `{"claudeAiOauth":{"accessToken":"${MARKERS[0]}","refreshToken":"${MARKERS[1]}"`);
  const b = loginExpiry(bad);
  assert.deepEqual(b, { code: "not-json", expiresAt: null });
  assertNoSecret("not-json", b);
  const noExp = writeLogin(d, { claudeAiOauth: { accessToken: MARKERS[0], refreshToken: MARKERS[1] } });
  assert.deepEqual(loginExpiry(noExp), { code: "no-expiry", expiresAt: null });
  assert.deepEqual(loginExpiry(path.join(d, "absent.json")), { code: "no-file", expiresAt: null });
  assert.deepEqual(loginExpiry(null), { code: "no-file", expiresAt: null });
  assert.deepEqual(loginExpiry(d), { code: "unreadable", expiresAt: null }, "a directory");
  fs.rmSync(d, { recursive: true, force: true });
});

test("the required validity: the run's time limit + the relay's 5 min refresh margin + 5 min slack", () => {
  assert.equal(REFRESH_MARGIN_MS, 5 * 60_000, "enclawed-oss auth-relay.ts REFRESH_MARGIN_MS");
  assert.equal(SLACK_MS, 5 * 60_000);
  assert.equal(requiredLoginValidityMs(420_000), 420_000 + 600_000);
  assert.equal(requiredLoginValidityMs(30 * 60_000), 40 * 60_000);
  assert.throws(() => requiredLoginValidityMs(0));
  assert.throws(() => requiredLoginValidityMs(Number.NaN));
});

test("the runners' time limits: C1/C2 and C1A 420 s (C1A's person ends at 400 s inside it), hostc sessions 30 min", async () => {
  const { RUN_TIMEOUT_MS, runTimeLimitMs } = await import("./run.mjs");
  assert.equal(RUN_TIMEOUT_MS, 420_000);
  for (const arm of ["C1", "C2", "C1A", "N0"]) assert.equal(runTimeLimitMs(arm), 420_000, arm);
  // hostc.mjs exports SESSION_TIMEOUT_MS; it is read from the source (importing hostc.mjs here is not needed).
  const hostc = fs.readFileSync(path.join(HERE, "hostc.mjs"), "utf8");
  assert.match(hostc, /export const SESSION_TIMEOUT_MS = 30 \* 60_000;/);
  assert.match(hostc, /timeoutMs: SESSION_TIMEOUT_MS,/);
  // Both runners gate their launches on the guard and watch every run.
  const run = fs.readFileSync(path.join(HERE, "run.mjs"), "utf8");
  for (const [name, src] of [["run.mjs", run], ["hostc.mjs", hostc]]) {
    assert.match(src, /gate: async \(\) => \{\n\s+if \(LOGIN_REFRESH_STOP\) return false;/, `${name}: a launch gate`);
    assert.match(src, /waitForLoginValidity\(\{/, `${name}: waits for the login`);
    assert.match(src, /watchSealedLogin\(\[state\]\)/, `${name}: watches the sealed login`);
    assert.match(src, /loginRefreshedInRun/, `${name}: records loginRefreshedInRun`);
  }
});

test("loginSealWiring: a snapshot seals the login when its src/login-seal.mjs or framework has the relay / seal", () => {
  const base = tmp();
  const snap = (files) => {
    const s = fs.mkdtempSync(path.join(base, "snap-"));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(s, rel)), { recursive: true });
      fs.writeFileSync(path.join(s, rel), text);
    }
    return s;
  };
  const none = snap({ "src/launcher.mjs": "export {}" });
  assert.deepEqual(loginSealWiring(none), { seals: false, evidence: [] });
  const app = snap({ "src/login-seal.mjs": "relay = await k.startAuthRelay({ socketPath });\nk.oauthRelayCredential({});" });
  assert.deepEqual(loginSealWiring(app), { seals: true, evidence: ["src/login-seal.mjs:startAuthRelay", "src/login-seal.mjs:oauthRelayCredential"] });
  const fw = snap({ ".enclawed-dev/framework/framework.js": "export { startAuthRelay, sealLoginFile };" });
  assert.deepEqual(loginSealWiring(fw), { seals: true, evidence: ["framework.js:startAuthRelay", "framework.js:sealLoginFile"] });
  const unrelated = snap({ "src/login-seal.mjs": "// nothing of the relay here", ".enclawed-dev/framework/framework.js": "export const x = 1;" });
  assert.equal(loginSealWiring(unrelated).seals, false);
  assert.equal(loginSealWiring(null).seals, false);
  // The real codenclawed source layout: src/login-seal.mjs starts the kit's relay.
  fs.rmSync(base, { recursive: true, force: true });
});

test("waitForLoginValidity: pauses with ONE line, polls every 30 s, resumes once the person's Claude Code refreshed the login", async () => {
  const d = tmp();
  let clock = 1_000_000_000;
  const need = requiredLoginValidityMs(420_000);
  const f = writeLogin(d, fakeLogin(clock + need - 60_000)); // one minute short
  const said = [];
  const events = [];
  const sleeps = [];
  let looks = 0;
  const res = await waitForLoginValidity({
    file: f,
    timeLimitMs: 420_000,
    say: (l) => said.push(l),
    event: (e) => events.push(e),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      // After three looks, the person's own claude refreshes the real file (here: the fake).
      if (++looks === 3) writeLogin(d, fakeLogin(clock + 8 * 3_600_000));
    },
    label: "cell-x",
  });
  assert.equal(res.ok, true);
  assert.equal(res.requiredMs, need);
  assert.deepEqual(sleeps, [30_000, 30_000, 30_000]);
  assert.equal(res.waitedMs, 90_000);
  const pauses = said.filter((l) => l.startsWith(WAIT_LINE));
  assert.equal(pauses.length, 1, "one clear line, not one per poll");
  assert.match(pauses[0], /no benchmark run may refresh it \(16 min left; this run needs 17 min; cell-x\)/);
  assert.equal(events.filter((e) => e.type === "login-guard-pause").length, 3);
  assert.equal(events.filter((e) => e.type === "login-guard-resume").length, 1);
  assertNoSecret("printed lines", said);
  assertNoSecret("events", events);
  assertNoSecret("result", res);
  fs.rmSync(d, { recursive: true, force: true });
});

test("waitForLoginValidity: long enough -> no wait, no line; no file (API key) -> at once; unreadable -> waits; told to stop -> not ok", async () => {
  const d = tmp();
  const clock = 5_000_000_000;
  const said = [];
  const ok = await waitForLoginValidity({ file: writeLogin(d, fakeLogin(clock + 3_600_000)), timeLimitMs: 420_000, say: (l) => said.push(l), now: () => clock, sleep: async () => assert.fail("no sleep") });
  assert.equal(ok.ok, true);
  assert.equal(ok.waitedMs, 0);
  assert.deepEqual(said, []);
  assert.equal((await waitForLoginValidity({ file: null, timeLimitMs: 420_000, sleep: async () => assert.fail("no sleep") })).ok, true);
  // Expired, or an expiry that cannot be read: never launched; the runner can be stopped while waiting.
  for (const doc of [fakeLogin(clock - 1), `{"claudeAiOauth":{"refreshToken":"${MARKERS[1]}"`]) {
    const lines = [];
    let polls = 0;
    const r = await waitForLoginValidity({ file: writeLogin(d, doc), timeLimitMs: 420_000, say: (l) => lines.push(l), now: () => clock, sleep: async () => polls++, shouldStop: () => polls >= 2 });
    assert.deepEqual({ ok: r.ok, stopped: r.stopped }, { ok: false, stopped: true });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(WAIT_LINE));
    assertNoSecret("paused line", lines);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test("watchSealedLogin: the first seal and a halt's erase are not refreshes; a re-seal (atomic replace) is; so is an audited refresh", async () => {
  const state = tmp();
  const sealed = path.join(state, SEALED_LOGIN_REL);
  const seal = (tag) => {
    fs.mkdirSync(path.dirname(sealed), { recursive: true, mode: 0o700 });
    const t = `${sealed}.${process.pid}.${tag}.tmp`;
    fs.writeFileSync(t, JSON.stringify({ v: 1, data: tag }), { mode: 0o600 });
    fs.renameSync(t, sealed);
  };
  const tick = () => new Promise((r) => setTimeout(r, 30));
  // Session without a refresh: sealed at launch, untouched after.
  let w = watchSealedLogin([state], { intervalMs: 5 });
  seal("first");
  await tick();
  assert.deepEqual(w.finish(), { loginRefreshedInRun: false, reseals: 0, auditRefreshTypes: [] });
  // A halt erases it, a later launch seals the plaintext again: still no refresh.
  w = watchSealedLogin([state], { intervalMs: 5 });
  fs.rmSync(sealed);
  await tick();
  seal("again");
  await tick();
  assert.equal(w.finish().loginRefreshedInRun, false);
  // The relay rotated the token and sealed it again over the old file: a refresh.
  w = watchSealedLogin([state], { intervalMs: 5 });
  await tick();
  seal("rotated");
  await tick();
  const r = w.finish();
  assert.equal(r.loginRefreshedInRun, true);
  assert.equal(r.reseals, 1);
  // A build that audits its relay's events: a refreshed event in the audit counts as well.
  const s2 = tmp();
  fs.mkdirSync(path.join(s2, "claude-code"), { recursive: true });
  fs.writeFileSync(path.join(s2, "claude-code", "audit.jsonl"), `${JSON.stringify({ type: "claude-code.launch" })}\n${JSON.stringify({ type: "claude-code.login.relay", payload: { kind: "refreshed", status: 401 } })}\nnot json\n`);
  const a = watchSealedLogin([s2], { intervalMs: 5 }).finish();
  assert.deepEqual(a, { loginRefreshedInRun: true, reseals: 0, auditRefreshTypes: ["claude-code.login.relay"] });
  assert.equal(watchSealedLogin([tmp()], { intervalMs: 5 }).finish().loginRefreshedInRun, false, "nothing sealed, no audit");
  // The kit's audited relay events (codenclawed after bcd03c8): a refresh, and a FAILED refresh, each stop the batch.
  for (const type of ["claude-code.auth.relay.token-refreshed", "claude-code.auth.relay.token-refresh-failed"]) {
    const s3 = tmp();
    fs.mkdirSync(path.join(s3, "claude-code"), { recursive: true });
    fs.writeFileSync(path.join(s3, "claude-code", "audit.jsonl"), `${JSON.stringify({ type: "claude-code.launch" })}\n${JSON.stringify({ type, actor: "codenclawed", payload: { reason: "expiry", method: "POST", path: "/v1/messages", status: 0 } })}\n`);
    assert.deepEqual(watchSealedLogin([s3], { intervalMs: 5 }).finish(), { loginRefreshedInRun: true, reseals: 0, auditRefreshTypes: [type] }, type);
    assert.ok(KIT_REFRESH_RECORD.test(type), type);
  }
  // Other relay records (a refused route) and the login-seal move are not refreshes.
  const s4 = tmp();
  fs.mkdirSync(path.join(s4, "claude-code"), { recursive: true });
  fs.writeFileSync(path.join(s4, "claude-code", "audit.jsonl"), `${JSON.stringify({ type: "claude-code.auth.login-seal.migrated", payload: { from: "device-challenge", to: "device-key-derive" } })}\n${JSON.stringify({ type: "claude-code.auth.device-factor", payload: { outcome: "verified", via: "device-unlock" } })}\n`);
  assert.equal(watchSealedLogin([s4], { intervalMs: 5 }).finish().loginRefreshedInRun, false, "a login-seal move is not a refresh");
});

test("a refresh stops the batch: results/STOP (and the runner's own stop file) touched, the reason said, no secret", () => {
  const results = tmp();
  const said = [];
  const why = stopBatchForLoginRefresh(results, "C2 some|cell, run /x", { stopFiles: ["STOP", "STOP-HOSTC"], say: (l) => said.push(l) });
  assert.ok(fs.existsSync(path.join(results, "STOP")));
  assert.ok(fs.existsSync(path.join(results, "STOP-HOSTC")));
  assert.match(why, /person's real Claude login may now hold an invalidated refresh token/);
  assert.deepEqual(said, [why]);
  fs.rmSync(results, { recursive: true, force: true });
});

test("a plain claude refreshing a run's COPY: its expiry changed (expiries only; unknown is not a refresh)", () => {
  assert.equal(copyRefreshed(1000, 2000), true);
  assert.equal(copyRefreshed(1000, 1000), false);
  assert.equal(copyRefreshed(1000, null), false, "the copy erased (a halt) or never made");
  assert.equal(copyRefreshed(null, 2000), false);
  const d = tmp();
  fs.writeFileSync(path.join(d, "n.txt"), "1800000000000\n");
  fs.writeFileSync(path.join(d, "x.txt"), "null\n");
  assert.equal(readExpiryNote(path.join(d, "n.txt")), 1_800_000_000_000);
  assert.equal(readExpiryNote(path.join(d, "x.txt")), null);
  assert.equal(readExpiryNote(path.join(d, "absent.txt")), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test("CLI `login-guard.mjs expires FILE` (run inside the sandbox) prints the expiry or null, nothing else from the file", () => {
  const d = tmp();
  const cli = path.join(HERE, "hostc", "login-guard.mjs");
  const good = spawnSync(process.execPath, [cli, "expires", writeLogin(d, fakeLogin(1_234_567))], { encoding: "utf8" });
  assert.equal(good.status, 0);
  assert.equal(good.stdout, "1234567\n");
  assert.equal(good.stderr, "");
  const bad = spawnSync(process.execPath, [cli, "expires", writeLogin(d, `{"refreshToken":"${MARKERS[1]}",`)], { encoding: "utf8" });
  assert.equal(bad.stdout, "null\n");
  assertNoSecret("CLI", bad.stdout + bad.stderr);
  const missing = spawnSync(process.execPath, [cli, "expires", path.join(d, "absent")], { encoding: "utf8" });
  assert.equal(missing.stdout, "null\n");
  fs.rmSync(d, { recursive: true, force: true });
});

test("the real login stays read-only: a sandbox that could write it is refused; a stopped guard launches nothing", async () => {
  const d = tmp();
  const login = writeLogin(fs.mkdtempSync(path.join(d, "home-")), fakeLogin(1));
  const runDir = fs.mkdtempSync(path.join(d, "run-"));
  assert.equal(loginBindProblem(login, [runDir]), null);
  assert.match(loginBindProblem(login, [runDir, path.dirname(login)]), /would be writable in the sandbox/);
  assert.match(loginBindProblem(login, [login]), /would be writable/);
  assert.equal(loginBindProblem(null, [runDir]), null);
  const inRun = writeLogin(runDir, fakeLogin(1));
  const base = { runDir, cwd: runDir, argv: ["/bin/true"], env: {}, stdoutFile: path.join(runDir, "o"), stderrFile: path.join(runDir, "e"), timeoutMs: 1000 };
  await assert.rejects(async () => runBench({ ...base, credentialsFile: inRun }), /refusing to run: the login file .* would be writable/);
  await assert.rejects(async () => runBench({ ...base, argv: ["--bind", path.dirname(login), "/x", "/bin/true"], credentialsFile: login }), /would be writable/);
  // The gate says no (told to stop while waiting, or a refresh already happened): no sandbox starts.
  await assert.rejects(runBench({ ...base, credentialsFile: login, gate: async () => false }), (e) => e.loginGuardStop === true);
  assert.equal(fs.existsSync(path.join(runDir, "o")), false, "nothing was launched");
  fs.rmSync(d, { recursive: true, force: true });
});
