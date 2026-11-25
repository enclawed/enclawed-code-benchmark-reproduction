#!/usr/bin/env node
// Accept the batch's continuing codenclawed log as the new device-anchor baseline: the person's step
// when the C2 runner pauses with "the batch's codenclawed state needs the person (... accept)".
// Run it at a terminal, as the person, while benchmarks/c2-broker.mjs holds the device:
//
//   node c2-accept.mjs --build <id> [--work-dir DIR]
//
// It runs the snapshot's own `codenclawed audit accept` on the batch state (hostc/batch-state.mjs,
// <work-dir>/c2/batch/<id>/state), as a CLIENT of the broker (ENCLAWEDER_DEVICE=deny). That command
// (codenclawed 3eed799 on) compares first (nothing is spent), prints what it would accept, asks for
// the device's serial and ACCEPT, then runs the launch's own activation with no ticket: the security
// key, then an authenticator code the Enclaweder verifies (sealed through the owner); the accept record
// is anchored under a session bound to that activation.
//
// In the benchmark the person's security key is a SOFTWARE stand-in, exactly as for the C2 launches
// (src/demo-credential.mjs: the shared ticket's credential, whose private key is never kept): this
// script enrolls a fresh stand-in key for this accept only (the batch's factor store holds it while
// the command runs and is put back after), drives the snapshot's libfido2 test double with it
// (test/fixtures/fake-fido2), and a stand-in person types the serial (from the command's own report)
// and ACCEPT (scripts/accept-pty.py). The REAL person types only the authenticator code, as at a
// launch's device unlock; nothing changes on the device without it. On success the runner resumes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WORK } from "./bench-config.mjs";
import { authDirOf } from "./c2-unlock.mjs";
import { brokerClient } from "./c2-person.mjs";
import { batchPaths } from "./hostc/batch-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ACCEPT_USAGE = "usage: node c2-accept.mjs --build <id> [--work-dir DIR]";

/** c2-accept.mjs's arguments: the snapshot id (the batch is keyed by it). */
export function parseAcceptArgs(argv) {
  const i = argv.indexOf("--build");
  const build = i >= 0 ? argv[i + 1] : null;
  if (!build || build.startsWith("--")) return { ok: false, error: ACCEPT_USAGE };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(build)) return { ok: false, error: `--build: a snapshot id, not ${build}` };
  return { ok: true, build };
}

/** The libfido2 test double's state for a stand-in key (run.mjs fakeFido2State's format). */
export function fakeFido2StateFor(cred, dir) {
  const f = path.join(dir, "fake-fido2.json");
  fs.writeFileSync(f, JSON.stringify({ privateKeyJwk: cred.privateKey.export({ format: "jwk" }), credentialId: cred.credential.credentialId, aaguid: cred.credential.aaguid, counterFile: path.join(dir, "fake-fido2.counter") }), { mode: 0o600 });
  return f;
}

/**
 * Put a fresh stand-in key in the batch state's factor store for the accept; returns a restore
 * function (the original store back, the stand-in's private key gone). `enroll`: demo-credential.mjs
 * enrollDemoCredential (it enrolls only into a throwaway dir: a temp one here, then copied in).
 */
export function standInKey(state, enroll, tmpRoot = os.tmpdir()) {
  const store = path.join(authDirOf(state), "factors.json");
  if (!fs.existsSync(store)) throw new Error(`no factor store at ${store} (the runner installs the person's credential before it pauses)`);
  const saved = fs.readFileSync(store);
  const dir = fs.mkdtempSync(path.join(tmpRoot, "c2-accept-"));
  fs.chmodSync(dir, 0o700);
  const cred = enroll(path.join(dir, "auth"));
  fs.copyFileSync(path.join(dir, "auth", "factors.json"), store);
  const fake = fakeFido2StateFor(cred, dir);
  return {
    fake,
    restore() {
      fs.writeFileSync(store, saved, { mode: 0o600 });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fail = (msg, code = 2) => {
    process.stderr.write(`c2-accept: ${msg}\n`);
    process.exit(code);
  };
  const a = parseAcceptArgs(process.argv.slice(2));
  if (!a.ok) fail(a.error);
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("the authenticator code is typed by a person at a terminal");
  const batch = batchPaths(WORK, a.build);
  if (!fs.existsSync(batch.state)) fail(`no batch state for build ${a.build} at ${batch.state}`);
  const { snap } = await brokerClient({ build: a.build, state: batch.state, fail });
  const fakeDir = path.join(snap, "test", "fixtures", "fake-fido2");
  if (!fs.existsSync(path.join(snap, "src", "demo-credential.mjs")) || !fs.existsSync(path.join(fakeDir, "fido2-assert"))) fail(`build ${a.build} has no demo credential or libfido2 test double`);
  const { enrollDemoCredential } = await import(pathToFileURL(path.join(snap, "src", "demo-credential.mjs")).href);
  process.stdout.write(
    `c2-accept: codenclawed ${a.build} \`audit accept\` on the batch state ${batch.state}.\n` +
      "  It shows what it would accept first. The stand-in person presents the benchmark's software security key and types the serial and ACCEPT;\n" +
      "  you type only the authenticator code the Enclaweder checks (nothing is accepted without it).\n\n",
  );
  const key = standInKey(batch.state, enrollDemoCredential);
  let r;
  try {
    r = spawnSync("python3", [path.join(HERE, "scripts", "accept-pty.py"), path.join(batch.root, `accept-${Date.now()}.log`), "600", "--", process.execPath, path.join(snap, "bin", "codenclawed.mjs"), "audit", "accept"], {
      cwd: batch.root,
      env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH}`, FAKE_FIDO2_STATE: key.fake, TERM: process.env.TERM || "xterm" },
      stdio: "inherit",
    });
  } finally {
    key.restore();
  }
  if (r.status !== 0) fail(`audit accept did not complete (exit ${r.status}); the runner stays paused`, 3);
  fs.writeFileSync(batch.resume, `${new Date().toISOString()} c2-accept\n`);
  process.stdout.write(`c2-accept: accepted; the runner resumes (${batch.resume})\n`);
  process.exit(0);
}
