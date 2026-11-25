// C2: keep the batch's ONE continuing codenclawed state genuine between runs (hostc.mjs and run.mjs's
// C2 arm). The state, its snapshot and the decisions: hostc/batch-state.mjs. This file runs the check
// (hostc/batch-check.mjs) in a sandbox like a run's, through the owner socket, and pauses for the
// person when the check says so.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGrant, installPrepared, installShared, ticketBoundBuild } from "./c2-unlock.mjs";
import { batchEnv, decideBatchCheck, personCommand, restoreLogSet, snapshotGenuine, waitForPerson } from "./hostc/batch-state.mjs";
import { WORK } from "./bench-config.mjs";
import { runBench } from "./sandbox-ext.mjs";
import { HOME } from "./scenarios/sandbox.mjs";

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const HB_SRC = path.join(BENCH, "hostc");

/** Hold an flock(1) on the device lock while the check runs (never overlaps a run or another runner's device work). */
function holdLock(lockFile) {
  return new Promise((resolve, reject) => {
    const holder = spawn("flock", ["-o", "-w", "7200", lockFile, "-c", "echo held; exec cat > /dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
    let done = false;
    holder.stdout.on("data", (d) => {
      if (!done && String(d).includes("held")) {
        done = true;
        resolve(() => {
          holder.stdin.end();
          setTimeout(() => holder.kill("SIGKILL"), 2000).unref();
        });
      }
    });
    holder.on("close", (c) => !done && reject(new Error(`could not take the device lock (flock exit ${c})`)));
  });
}

/** The check, in a sandbox: the batch state writable, the owner's socket dir read-only, the snapshot read-only. */
export async function runBatchCheck({ batch, snap, sock, lockFile }) {
  const dir = path.join(batch.checks, `${new Date().toISOString().replace(/[:.]/g, "-")}.${crypto.randomBytes(3).toString("hex")}`);
  const hb = path.join(dir, "hb");
  fs.mkdirSync(hb, { recursive: true, mode: 0o700 });
  for (const n of fs.readdirSync(HB_SRC).filter((x) => x.endsWith(".mjs"))) fs.copyFileSync(path.join(HB_SRC, n), path.join(hb, n));
  const release = lockFile ? await holdLock(lockFile) : () => {};
  try {
    await runBench({
      runDir: dir,
      cwd: dir,
      argv: ["--bind", batch.state, batch.state, "--ro-bind", path.dirname(sock), path.dirname(sock), process.execPath, path.join(hb, "batch-check.mjs")],
      env: { HOME, USER: os.userInfo().username, LANG: "C.UTF-8", PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: "/tmp", SNAP: snap, ...batchEnv(batch.state, sock) },
      roBinds: [snap],
      stdoutFile: path.join(dir, "check.json"),
      stderrFile: path.join(dir, "check.err"),
      timeoutMs: 240_000,
    });
  } finally {
    release();
  }
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(dir, "check.json"), "utf8").trim().split("\n");
  } catch {
    lines = [];
  }
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return { error: `no answer (see ${dir})` };
  }
}

/** The activation material a run presents, installed into the batch state (the person's own files). */
export function installActivation(state, { snap, prepared = null }) {
  if (prepared) return installPrepared(state, prepared.state);
  return ticketBoundBuild(snap) ? installShared(state) : installGrant(state);
}

/**
 * Before a C2 run: the batch state must be genuine (batch-state.mjs decideBatchCheck). The activation
 * material is installed first (`audit accept` asks for the person's second factor on that state). A log
 * the device does not anchor is put back from the genuine snapshot once and checked again; otherwise the
 * runner pauses for the person's command (`audit accept`, `recover-root`) and checks again.
 * `check` is injectable (tests). Returns { ok: true, probe, logRestored } or { ok: false, stop }.
 */
export async function ensureC2Batch({ batch, snap, sock, build, prepared = null, shouldStop = () => false, event = () => {}, lockFile = null, out = process.stdout, check = runBatchCheck, pollMs = 10_000, sleep }) {
  installActivation(batch.state, { snap, prepared });
  let logRestored = false;
  let restoredOnce = false;
  for (;;) {
    const probe = await check({ batch, snap, sock, lockFile });
    const d = decideBatchCheck(probe, { snapshot: fs.existsSync(batch.genuine), logRestored: restoredOnce });
    event({ type: "batch-check", build, action: d.action, reason: d.reason, gate: probe?.gate ?? null, root: probe?.root ? { booted: probe.root.booted } : null, verify: probe?.verify ? { empty: probe.verify.empty, ok: probe.verify.ok, category: probe.verify.category, verifyDevice: probe.verify.verifyDevice ?? null } : null });
    if (d.action === "ok") {
      snapshotGenuine(batch.state, batch.genuine);
      return { ok: true, probe, logRestored };
    }
    if (d.action === "restore-log") {
      event({ type: "batch-restore-log", build, files: restoreLogSet(batch.state, batch.genuine), reason: d.reason });
      logRestored = true;
      restoredOnce = true;
      continue;
    }
    if (d.action === "stop") return { ok: false, stop: d.reason };
    const command = personCommand(d.action, { node: process.execPath, build, work: WORK, bench: BENCH });
    if (!(await waitForPerson({ kind: d.action, reason: d.reason, command, resumeFile: batch.resume, event, shouldStop, out, pollMs, ...(sleep ? { sleep } : {}) }))) return { ok: false, stop: `stopped while waiting for the person (${d.action})` };
    restoredOnce = false;
  }
}
