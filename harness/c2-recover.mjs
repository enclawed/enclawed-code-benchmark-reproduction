#!/usr/bin/env node
// Clear a DIRTY hardware-root latch on the batch's continuing codenclawed state: the person's step
// when the C2 runner pauses with "the batch's codenclawed state needs the person (... latched ...)".
// Run it at a terminal, as the person, with the Enclaweder plugged in and the owner STOPPED (recovery
// drives the device itself; the framework refuses while an owner holds it):
//
//   node c2-recover.mjs --build <id> [--work-dir DIR]
//
// It runs the snapshot's own `codenclawed codenclawed recover-root` on the batch state
// (hostc/batch-state.mjs, <work-dir>/c2/batch/<id>/state). That command (codenclawed 3eed799) asks for
// the activation's security key with no ticket, then the framework's `hardware-root recover` asks for
// the serial printed on the device and two factors the Enclaweder checks itself: a code from the
// authenticator app and a one-time recovery code.
//
// As in c2-accept.mjs, the person's security key is a SOFTWARE stand-in (src/demo-credential.mjs, via
// the snapshot's libfido2 test double), enrolled for this recovery only, and a stand-in person types the
// serial (from the command's own report) and the double's PIN line (scripts/accept-pty.py --mode
// recover). The REAL person types only the authenticator code (read without echo) and the recovery
// code; both are scrubbed from the log and the echo. Any other prompt stops it. When the latch is
// clear, start the owner again: the runner resumes once it is back.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WORK } from "./bench-config.mjs";
import { parseAcceptArgs, standInKey } from "./c2-accept.mjs";
import { batchPaths } from "./hostc/batch-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECOVER_USAGE = "usage: node c2-recover.mjs --build <id> [--work-dir DIR]";
export const parseRecoverArgs = (argv) => {
  const a = parseAcceptArgs(argv);
  return a.ok ? a : { ok: false, error: a.error.replace("c2-accept.mjs", "c2-recover.mjs") };
};

/** The owner the runner uses (benchmarks/c2-broker.mjs's pid file): { pid, build } while it runs, else null. */
export function runningOwner(work = WORK) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(work, "c2-broker.json"), "utf8"));
    process.kill(b.pid, 0);
    return { pid: b.pid, build: b.build ?? null };
  } catch {
    return null;
  }
}

/**
 * The environment of the recovery: codenclawed on the batch state, the root required, the device
 * reachable by this process (no owner, no deny), the latch files of the batch state.
 */
export function recoverEnv(state, base = process.env) {
  const env = { ...base, ENCLAWED_STATE_DIR: state, ENCLAWED_HOME: path.join(state, "ehome"), ENCLAWEDER_ROOT: "required", ENCLAWEDER_STATE: path.join(state, "hw-root.state"), ENCLAWEDER_STATE_DIR: state };
  for (const k of ["ENCLAWEDER_DEVICE", "ENCLAWEDER_BROKER", "ENCLAWEDER_HIDRAW"]) delete env[k];
  return env;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fail = (msg, code = 2) => {
    process.stderr.write(`c2-recover: ${msg}\n`);
    process.exit(code);
  };
  const a = parseRecoverArgs(process.argv.slice(2));
  if (!a.ok) fail(a.error);
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("the authenticator code and the recovery code are typed by a person at a terminal");
  const batch = batchPaths(WORK, a.build);
  if (!fs.existsSync(batch.state)) fail(`no batch state for build ${a.build} at ${batch.state}`);
  const owner = runningOwner();
  if (owner) fail(`the owner (c2-broker.mjs, pid ${owner.pid}) holds the Enclaweder: recovery drives the device itself. Stop it first (kill ${owner.pid}), then run this again`);
  const snap = path.join(WORK, `codenclawed-${a.build}`);
  const fakeDir = path.join(snap, "test", "fixtures", "fake-fido2");
  if (!fs.existsSync(path.join(snap, "src", "demo-credential.mjs")) || !fs.existsSync(path.join(fakeDir, "fido2-assert"))) fail(`build ${a.build} has no demo credential or libfido2 test double`);
  const { enrollDemoCredential } = await import(pathToFileURL(path.join(snap, "src", "demo-credential.mjs")).href);
  process.stdout.write(
    `c2-recover: codenclawed ${a.build} \`codenclawed recover-root\` on the batch state ${batch.state}.\n` +
      "  The stand-in person presents the benchmark's software security key and types the device's serial;\n" +
      "  you type only the code from your authenticator app (not shown) and one of your one-time recovery codes.\n\n",
  );
  const key = standInKey(batch.state, enrollDemoCredential);
  let r;
  try {
    r = spawnSync("python3", [path.join(HERE, "scripts", "accept-pty.py"), "--mode", "recover", path.join(batch.root, `recover-${Date.now()}.log`), "900", "--", process.execPath, path.join(snap, "bin", "codenclawed.mjs"), "codenclawed", "recover-root"], {
      cwd: batch.root,
      env: { ...recoverEnv(batch.state), PATH: `${fakeDir}:${process.env.PATH}`, FAKE_FIDO2_STATE: key.fake, TERM: process.env.TERM || "xterm" },
      stdio: "inherit",
    });
  } finally {
    key.restore();
  }
  if (r.status !== 0) fail(`recover-root did not complete (exit ${r.status}); the runner stays paused`, 3);
  process.stdout.write(`c2-recover: the latch is clear. Start the owner again (node ${path.join(HERE, "c2-broker.mjs")} --build ${a.build} --work-dir ${WORK}); waiting for it, then the runner resumes.\n`);
  for (;;) {
    const o = runningOwner();
    if (o && o.build === a.build) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  fs.writeFileSync(batch.resume, `${new Date().toISOString()} c2-recover\n`);
  process.stdout.write(`c2-recover: the owner is back; the runner resumes (${batch.resume})\n`);
  process.exit(0);
}
