// C2: ONE continuing codenclawed state per batch, as on a real machine.
//
// The Enclaweder holds ONE anchored audit-log head for the whole machine. A run that starts from a
// fresh state directory brings a new, empty log that cannot match the head the previous run left on
// the device, and codenclawed refuses it (anchor-not-matched, foreign-session: fail closed). So every
// C2 run of a batch (hostc.mjs, and run.mjs's C2 arm) continues one state directory: the audit log,
// its anchor file and history, the approvals, the grant, the person's credential and ticket. Each
// run still has its own sandbox, project, install and output. The attacker acts on that real state,
// as a same-user attacker would.
//
// Around each run (hostc.mjs ensureBatchGenuine / finishBatchRun, run.mjs the same):
//   before   a check through the owner socket (batch-check.mjs, in a sandbox): would a launch on the
//            log as it is pass codenclawed's own anchor gate, and does `audit verify` accept it? If so
//            the state is genuine: it is snapshotted (the harness's own backup, like a person's).
//            If not: the log files are put back from the last genuine snapshot (only when the device
//            still anchors that log: the check is run again), else the runner PAUSES and prints the
//            person's command: `audit accept` (a log the device does not anchor, e.g. after the
//            attacker anchored its own history), or `recover-root` (a DIRTY hardware-root latch).
//            Nothing here ever re-baselines the device itself.
//   setup    codenclawed's per-project file record is dropped (each run's project is a new checkout
//            at the job's one path), and on a build that seals the login the sealed login too (each
//            session is the first launch after a fresh `claude` login, so the token is never older
//            than the login guard allows); the run's activation material is installed.
//   after    the state as the run left it is copied into the run directory (evidence), then the
//            person's own files (everything under claude-code/ but the audit log and its anchor
//            files) are put back from the snapshot: a planted policy, a replaced credential or
//            ticket, pins, an erased login. The log is never rewritten here: the next check decides.
//   Never put back: the audit log set unless the check above allows it, and the framework's own
//   device state outside claude-code/ (hw-root state, forensics, queue journal), so a latch or a
//   halt the attacker caused stays visible.
//
// No imports but node's own (copied into the sandbox with the other hostc files).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where a batch keeps its continuing state and its genuine snapshot. `build` is the snapshot id. */
export function batchPaths(work, build, plan = "c2") {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(build))) throw new Error(`batchPaths: a snapshot id, not ${build}`);
  const root = path.join(work, plan, "batch", String(build));
  return {
    root,
    state: path.join(root, "state"),
    genuine: path.join(root, "genuine"),
    checks: path.join(root, "checks"),
    // The person touches this after running the printed command; the runner then checks again.
    resume: path.join(root, "RESUME"),
  };
}

/** codenclawed's own dir inside the state (paths.mjs appStateDir). */
const APP = "claude-code";
/** The audit log set: the log, its segments and head, its anchor file and history (and superseded copies). */
export const isLogFile = (name) => name === "audit.jsonl" || name.startsWith("audit.jsonl.");
/** codenclawed's per-project file record (file-integrity.mjs ledgerFileFor). */
export const LEDGER_DIR = path.join(APP, "file-integrity");
/** The sealed login (login-seal.mjs sealedLoginFile). */
export const SEALED_LOGIN = path.join(APP, "credentials", "claude-login.sealed.json");

/** Copy a tree: regular files, dirs and symlinks (sockets and fifos skipped). */
export function copyTree(src, dst, { filter = () => true } = {}) {
  fs.rmSync(dst, { recursive: true, force: true });
  if (!fs.existsSync(src)) return dst;
  fs.cpSync(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => {
      try {
        const st = fs.lstatSync(p);
        return (st.isDirectory() || st.isFile() || st.isSymbolicLink()) && filter(path.relative(src, p));
      } catch {
        return false;
      }
    },
  });
  return dst;
}

export function initBatchState(state) {
  fs.mkdirSync(path.join(state, "ehome"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(state, APP), { recursive: true, mode: 0o700 });
  return state;
}

/** The state as it is now becomes the genuine snapshot (after a check passed). */
export function snapshotGenuine(state, genuine) {
  copyTree(state, `${genuine}.tmp`);
  fs.rmSync(genuine, { recursive: true, force: true });
  fs.renameSync(`${genuine}.tmp`, genuine);
  return genuine;
}

/** The state as a run left it, copied out as evidence (the run's own directory). */
export function evidenceCopy(state, dst) {
  return copyTree(state, dst);
}

const listFiles = (root, rel = "") => {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else if (e.isFile() || e.isSymbolicLink()) out.push(r);
  }
  return out;
};
const sameFile = (a, b) => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
};
/** A file of codenclawed's dir that is the person's (not the audit log set). `rel` is relative to claude-code/. */
const personFile = (rel) => !(rel.split(path.sep).length === 1 && isLogFile(rel));

/**
 * Put back the person's own files under claude-code/ from the genuine snapshot: files the run added
 * are removed, changed or removed ones restored. The audit log set is left as the run left it.
 * @returns {{ restored: string[], removed: string[] }} paths relative to the state dir
 */
export function restorePersonFiles(state, genuine) {
  const cur = path.join(state, APP);
  const snap = path.join(genuine, APP);
  const restored = [];
  const removed = [];
  const want = new Set(listFiles(snap).filter(personFile));
  for (const rel of listFiles(cur).filter(personFile)) {
    if (!want.has(rel)) {
      fs.rmSync(path.join(cur, rel), { force: true });
      removed.push(path.join(APP, rel));
    }
  }
  for (const rel of want) {
    const from = path.join(snap, rel);
    const to = path.join(cur, rel);
    if (sameFile(from, to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.rmSync(to, { force: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777);
    restored.push(path.join(APP, rel));
  }
  return { restored: restored.sort(), removed: removed.sort() };
}

/** Put the audit log set back from the genuine snapshot (only on the check's say-so). Returns the files. */
export function restoreLogSet(state, genuine) {
  const cur = path.join(state, APP);
  const snap = path.join(genuine, APP);
  const names = new Set();
  for (const d of [cur, snap]) {
    try {
      for (const n of fs.readdirSync(d)) if (isLogFile(n)) names.add(n);
    } catch {
      /* none */
    }
  }
  for (const n of names) {
    fs.rmSync(path.join(cur, n), { force: true });
    if (fs.existsSync(path.join(snap, n))) {
      fs.mkdirSync(cur, { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(snap, n), path.join(cur, n));
    }
  }
  return [...names].sort();
}

/**
 * Before a run (not between the carried sessions of one run): drop codenclawed's per-project file
 * record (each run's project is a new checkout at the job's one path), and on a sealing build the
 * sealed login (the run brings a fresh copy that the first launch seals). Returns what was removed.
 */
export function prepareRun(state, { sealing = false } = {}) {
  const removed = [];
  if (fs.existsSync(path.join(state, LEDGER_DIR))) {
    fs.rmSync(path.join(state, LEDGER_DIR), { recursive: true, force: true });
    removed.push(LEDGER_DIR);
  }
  if (sealing && fs.existsSync(path.join(state, SEALED_LOGIN))) {
    fs.rmSync(path.join(state, SEALED_LOGIN), { force: true });
    removed.push(SEALED_LOGIN);
  }
  return removed;
}

/** sha256 of the log set (names and bytes): did a step change the log? */
export function logSetDigest(state) {
  const h = crypto.createHash("sha256");
  const dir = path.join(state, APP);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(isLogFile).sort();
  } catch {
    names = [];
  }
  for (const n of names) h.update(`${n}\0`).update(fs.readFileSync(path.join(dir, n))).update("\0");
  return h.digest("hex");
}

/**
 * What the check (batch-check.mjs output) says to do next.
 *   ok           the next launch passes the anchor gate and the log verifies (or is empty)
 *   restore-log  put the log set back from the genuine snapshot and check again (once; only with a snapshot)
 *   accept       the person accepts the log as the new device-anchor baseline (`audit accept`)
 *   recover-root the hardware root is latched DIRTY: the person recovers it with the genuine device
 *   stop         the check could not reach the device (no owner, no device): a harness or machine problem
 * `probe`: { root: { booted, reason }, device, gate: { ok, status, code } | null, verify: { empty, ok, category } | null }.
 */
export function decideBatchCheck(probe, { snapshot = false, logRestored = false } = {}) {
  if (!probe || probe.error) return { action: "stop", reason: `the check gave no answer${probe?.error ? ` (${String(probe.error).slice(0, 200)})` : ""}` };
  const root = probe.root ?? {};
  if (!root.booted) {
    if (/DIRTY|latch/i.test(String(root.reason ?? ""))) return { action: "recover-root", reason: `the hardware root is latched: ${String(root.reason).slice(0, 300)}` };
    return { action: "stop", reason: `the hardware root did not start: ${String(root.reason ?? "?").slice(0, 300)}` };
  }
  if (!probe.device || !probe.gate) return { action: "stop", reason: "no Enclaweder that can anchor is bound through the owner socket" };
  const v = probe.verify ?? null;
  const verifies = Boolean(v && (v.empty || v.ok));
  if (probe.gate.ok && verifies) return { action: "ok", reason: null };
  const why = probe.gate.ok ? `the log does not verify (${v?.category ?? "no-output"}${v?.verifyDevice ? `/${v.verifyDevice}` : ""})` : `a launch would be refused at the anchor gate (${probe.gate.status}${probe.gate.code ? `, ${probe.gate.code}` : ""})`;
  if (snapshot && !logRestored) return { action: "restore-log", reason: why };
  return { action: "accept", reason: why };
}

/** The environment of codenclawed on the batch state, for the harness's check and the person's commands. */
export function batchEnv(state, sock) {
  return {
    ENCLAWED_STATE_DIR: state,
    ENCLAWED_HOME: path.join(state, "ehome"),
    ENCLAWEDER_ROOT: "required",
    ENCLAWEDER_DEVICE: "deny",
    ENCLAWEDER_BROKER: sock,
    ENCLAWEDER_STATE: path.join(state, "hw-root.state"),
    ENCLAWEDER_STATE_DIR: state,
  };
}

const q = (s) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
/**
 * The one command the person runs at a terminal, with the device plugged in. A stand-in person
 * presents the benchmark's software security key and types the serial (and ACCEPT); the person types
 * only the factors the Enclaweder checks. Each resumes the runner by itself.
 *   accept        c2-accept.mjs (the snapshot's `codenclawed audit accept`; the owner running): the
 *                 authenticator code;
 *   recover-root  c2-recover.mjs (the snapshot's `codenclawed codenclawed recover-root`; the owner
 *                 STOPPED, started again after): the authenticator code and a one-time recovery code.
 */
export function personCommand(kind, { node = "node", build, work, bench }) {
  const script = { accept: "c2-accept.mjs", "recover-root": "c2-recover.mjs" }[kind];
  if (!script) throw new Error(`personCommand: accept or recover-root, not ${kind}`);
  if (!build || !work || !bench) throw new Error(`personCommand ${kind}: build, work and bench are needed`);
  return `${node} ${q(path.join(bench, script))} --build ${q(build)} --work-dir ${q(work)}`;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Pause until the person has run the command and touched `resumeFile` (any write after the pause
 * began). ONE message, an event, a look every `pollMs`; false when told to stop.
 */
export async function waitForPerson({ kind, reason, command, resumeFile, out = process.stdout, event = () => {}, shouldStop = () => false, pollMs = 10_000, sleep = defaultSleep, now = Date.now }) {
  const t0 = now();
  try {
    fs.rmSync(resumeFile, { force: true });
  } catch {
    /* none */
  }
  event({ type: "pause", reason: `batch-state: ${kind}: ${reason}`, resumeFile });
  const how =
    kind === "accept"
      ? "  Run this at a terminal, with the Enclaweder plugged in and the owner (c2-broker.mjs) running, and type the code from your authenticator app when it asks (nothing else):\n"
      : "  Stop the owner (c2-broker.mjs) first: recovery drives the device itself. Then run this at a terminal, with the Enclaweder plugged in, and type the code from your authenticator app and one of your one-time recovery codes when it asks (nothing else); start the owner again when it says so:\n";
  out.write(`C2 paused: the batch's codenclawed state needs the person (${reason}).\n${how}    ${command}\n  The runner resumes by itself when it succeeds.\n`);
  for (;;) {
    if (fs.existsSync(resumeFile)) {
      fs.rmSync(resumeFile, { force: true });
      event({ type: "resume", reason: `batch-state: ${kind}`, waitedS: Math.round((now() - t0) / 1000) });
      return true;
    }
    if (shouldStop()) return false;
    await sleep(pollMs);
  }
}
