// C2 device unlocks: the harness side of codenclawed's device-counted headless launches.
//
// With an Enclaweder bound, a headless codenclawed launch spends ONE use of an unlock grant the
// DEVICE keeps and counts (codenclawed src/device-activation.mjs, enclawed-oss kit
// spendDeviceUnlock). The grant is issued once, at a terminal, with an authenticator code the
// device verifies; codenclawed stores only a record naming it at <state>/claude-code/device-unlock.json
// (at most 65535 uses, at most 36 h; editing the record gains nothing, the device decides).
//
// Every benchmark run has a throwaway state dir, so the person issues ONE grant into a fixed
// host-side state dir (C2_GRANT_DIR, by c2-grant.mjs) and before each C2 run the harness copies
// that record into the run's state dir. When the device answers that the grant is used up,
// expired, revoked or replaced, the run is recorded `invalid: "c2-unlock-exhausted"` (never a
// result, never a refusal-by-design), the runner pauses, prints one line telling the person to
// issue a new grant, and resumes by itself when a NEWER record appears (polled by mtime).
//
// From the ticket-bound builds on (device-activation.mjs GRANT_TICKET_BINDING, kit unlockScope v3),
// every device unlock is bound to ONE unlock ticket (its body digest and credential), and a grant
// for more than one launch or ten minutes to ONE job (name, measured code, effective policy,
// project dir, launch kind). So the shared C2 state the person prepares once holds, next to the
// grant record: the person's throwaway credential and the ONE shared ticket the grant is bound to
// (claude-code/auth/), and the device-signed approval of the snapshot's measurement (and of the
// effective policy when a user policy file shapes it; claude-code/approvals.json, c2-approve.mjs).
// The runners copy all of it into every C2 run's state dir (installShared) and launch every C2
// session from ONE project path (C2_PROJECT_DIR: the main plan builds each C2 run there, hostc binds
// its run's project there), so all C2 runs are the grant's job. Attack 7 keeps its own fresh 1-use,
// 10-minute grant per repetition.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORK } from "./bench-config.mjs";

/** The fixed host-side codenclawed state dir the person issues the grant into. */
export const C2_GRANT_DIR = path.resolve(process.env.BENCH_C2_GRANT_DIR?.trim() || path.join(WORK, "c2-grant"));
/** Where codenclawed keeps the record under a state dir (appStateDir()/device-unlock.json). */
export const grantRecordPath = (stateDir) => path.join(stateDir, "claude-code", "device-unlock.json");
export const C2_GRANT_FILE = grantRecordPath(C2_GRANT_DIR);
/** The person's credential and the shared unlock ticket, under a state dir (codenclawed authDir). */
export const authDirOf = (stateDir) => path.join(stateDir, "claude-code", "auth");
export const ticketPath = (stateDir) => path.join(authDirOf(stateDir), "unlock-ticket.json");
/** The person's device-signed approvals (codenclawed commitments.mjs approvalsFile). */
export const approvalsPath = (stateDir) => path.join(stateDir, "claude-code", "approvals.json");

/**
 * The shared grant's job: ONE project path every C2 session is launched from, `codenclawed -p`
 * (headless:print), the snapshot's approved measurement and the runs' effective policy.
 *
 * C2 runs are serialized (one device queue, one worker; hostc holds the device for a whole run), so
 * every C2 run uses ONE fixed run directory under the work dir, C2_RUN_DIR, with its project at
 * C2_PROJECT_DIR (the operator's decision, 2026-11-23): one job-bound device unlock then covers the
 * whole plan. The main plan (run.mjs) builds each C2 run there, cleaned first, and moves it to the
 * run's own directory under runs/ when the run ends (holdC2RunDir: never two at once, asserted by an
 * exclusive lock). hostc builds its project in its own run directory and binds it over
 * C2_PROJECT_DIR inside the sandbox; the job names the project by that path.
 */
export const C2_JOB_NAME = "hostc-c2";
export const C2_RUN_DIR = path.join(WORK, "c2-run");
export const C2_PROJECT_DIR = path.join(C2_RUN_DIR, "proj");
export const C2_RUN_LOCK = path.join(WORK, "c2-run.lock");
export const C2_JOB_KIND = "headless:print";

/** The process named in a lock file, or null when the file is missing or unreadable. */
function lockHolder(lockFile) {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(lockFile, "utf8"))?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
};

/**
 * Take the fixed C2 run directory for ONE run: an exclusive lock (created with O_EXCL, naming this
 * process) asserts that no other C2 run uses it, in this process or any other; a lock left by a
 * process that is gone is taken over. The directory is then cleaned (whatever a crashed run left is
 * removed) and made again, empty. `finish(dest)` moves it to the run's own directory (`dest`, under
 * runs/) and releases the lock. Throws when another live run holds it.
 */
export function holdC2RunDir({ runDir = C2_RUN_DIR, lockFile = C2_RUN_LOCK } = {}) {
  const token = crypto.randomBytes(8).toString("hex");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token, since: new Date().toISOString(), runDir }), { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const holder = lockHolder(lockFile);
      if (holder !== null && alive(holder)) {
        throw new Error(`C2: the fixed C2 run directory ${runDir} is in use by process ${holder}${holder === process.pid ? " (this runner)" : ""}; C2 runs never run two at once`);
      }
      if (attempt > 2) throw new Error(`C2: cannot take the lock ${lockFile}`);
      fs.rmSync(lockFile, { force: true }); // left by a process that is gone
    }
  }
  const release = () => {
    try {
      if (JSON.parse(fs.readFileSync(lockFile, "utf8"))?.token === token) fs.rmSync(lockFile, { force: true });
    } catch {
      /* already gone */
    }
  };
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    release();
    throw e;
  }
  let done = false;
  return {
    dir: runDir,
    /** Move the run's files to `dest` (its own directory under runs/) and release the lock. */
    finish(dest) {
      if (done) return null;
      done = true;
      try {
        if (!fs.existsSync(runDir)) return null;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          fs.renameSync(runDir, dest);
        } catch (e) {
          if (e?.code !== "EXDEV") throw e;
          fs.cpSync(runDir, dest, { recursive: true, verbatimSymlinks: true });
          fs.rmSync(runDir, { recursive: true, force: true });
        }
        return dest;
      } finally {
        release();
      }
    },
  };
}
/** The shared grant's bounds: the device's maximum uses, 36 h (the build's GRANT_MAX_*); the shared ticket lives as long. */
export const C2_SHARED_USES = 65535;
export const C2_SHARED_MINUTES = 2160;

/**
 * The environment a hostc C2 session's launcher computes its effective policy under (the variables
 * policyCandidates and shellFlavor read: no SHELL, an empty HOME, the run's state dir, required root).
 * c2-grant.mjs computes the job's policy digest under it, with `state` = the shared grant dir (which,
 * like every run's fresh state dir, holds no policy file).
 */
export function c2RunEnv({ state, home, pathEnv = process.env.PATH }) {
  return {
    HOME: home,
    USER: process.env.USER ?? "",
    LANG: "C.UTF-8",
    PATH: pathEnv,
    TERM: "dumb",
    TMPDIR: "/tmp",
    ENCLAWED_STATE_DIR: state,
    ENCLAWED_HOME: path.join(state, "ehome"),
    ENCLAWEDER_ROOT: "required",
    ENCLAWEDER_DEVICE: "deny",
  };
}

/**
 * Does the snapshot bind device unlocks to a ticket (and beyond one launch, to a job)? Then every C2
 * session presents the SHARED ticket, runs as the shared grant's job (C2_PROJECT_DIR, -p) and needs
 * the approvals (installShared); an older build keeps the unbound shared grant.
 */
export function ticketBoundBuild(snap) {
  try {
    return /export const GRANT_TICKET_BINDING = true/.test(fs.readFileSync(path.join(snap, "src", "device-activation.mjs"), "utf8"));
  } catch {
    return false;
  }
}

/** The commands the person runs for what the shared C2 state still lacks (sharedC2Missing). */
export function sharedC2Commands(build, missing) {
  return [...(missing.includes("approvals") ? [approveCommand(build)] : []), ...(missing.some((m) => m !== "approvals") ? [issueCommand(build)] : [])];
}

/**
 * The main plan, C2: a credential of the run's own for the MCP pins only (the person's own second
 * key, as in every other arm), added to the run's factor store BESIDE the shared credential that
 * signed the shared ticket (installShared): the launch must present that ticket, and the person's
 * pin steps need a key whose private half this process holds. `enroll` is the snapshot's
 * enrollDemoCredential (it refuses anything but a fresh directory under the OS temp dir). Returns the
 * credential as enrollDemoCredential does, with authDir the run's.
 */
export function addPinCredential(stateDir, enroll) {
  const store = path.join(authDirOf(stateDir), "factors.json");
  const doc = JSON.parse(fs.readFileSync(store, "utf8"));
  if (!Array.isArray(doc?.credentials) || doc.credentials.length === 0) throw new Error(`C2: ${store} holds no enrolled credential (installShared first)`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c2-pin-cred-"));
  try {
    const c = enroll(path.join(tmp, "auth"));
    // A distinct local id: the shared credential keeps its own (the ticket names it).
    const ids = new Set(doc.credentials.map((x) => x.id));
    let n = 2;
    while (ids.has(`de30000${n}`)) n++;
    const credential = { ...c.credential, id: `de30000${n}`, label: "run pin key" };
    doc.credentials.push(credential);
    fs.writeFileSync(store, JSON.stringify(doc), { mode: 0o600 });
    return { ...c, credential, authDir: authDirOf(stateDir) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The marks a C2 record gets when the device unlock, not the attack, decided the run. */
export const C2_UNLOCK_EXHAUSTED = "c2-unlock-exhausted";
/** The C-arm launch failed for a reason of the harness or the deployment (root env, activation, unlock). */
export const C_ARM_MISCONFIGURED = "c-arm-launch-misconfigured";

/**
 * The kit's device-unlock refusal codes (enclawed-oss adapter/session.ts UnlockRefusal) after which
 * only a NEW grant helps: the device holds no live grant (uses ran out, lease expired, revoked,
 * device restarted) or holds another one than the record names.
 */
export const GRANT_GONE_CODES = new Set(["no-grant", "mismatch"]);

// The kit's texts for those two codes (UNLOCK_TEXT), for launches whose audit could not be read.
const GRANT_GONE_TEXT = /holds no live unlock|holds another unlock than the one named here/i;

// Every launch refusal of the device / activation path (kit activateSession, deviceActivation,
// spendDeviceUnlock; codenclawed launcher and device-activation.mjs), plus the older ones the
// runner already treated as misconfiguration (root env, passphrase, ticket, enrollment), and the
// command set 0.5 ones (the kit's commandSetPin on a device that does not prove 0.5: reflash it;
// the login key that KEY_DERIVE gives only on the launch's activation).
export const ACTIVATION_REFUSAL =
  /ENCLAWEDER_ROOT=|passphrase|unlock ticket|not enrolled|two-factor|activation|cannot verify an authenticator code|authenticator code|device unlock|device-verified|holds no live unlock|holds another unlock|unlock was made|Enclaweder's (?:answer|receipt)|Enclaweder did not|no Enclaweder that this process can use|cannot ask the Enclaweder|codenclawed auth unlock|command set 0\.5|reflash runbook|KEY_DERIVE|Enclaweder's derived key|never relayed in the clear/i;

/** The record's identity and file state, or null when there is no readable record. */
export function grantInfo(file = C2_GRANT_FILE) {
  let st;
  let text;
  try {
    st = fs.statSync(file);
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let g;
  try {
    g = JSON.parse(text);
  } catch {
    return null;
  }
  if (!g || (g.v !== 1 && g.v !== 2) || typeof g.gid !== "string") return null;
  return {
    file,
    mtimeMs: st.mtimeMs,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    gid: g.gid,
    boot: g.boot ?? null,
    uses: g.uses ?? null,
    leaseMs: g.leaseMs ?? null,
    // v2 (ticket-bound): whether it names a ticket, and its job (digests and names only; null: a 1-use, 10-minute unlock).
    ticketBound: Boolean(g.ticket),
    job: g.job ? { name: g.job.name ?? null, measurementDigest: g.job.measurementDigest ?? null, policyDigest: g.job.policyDigest ?? null, projectDigest: g.job.projectDigest ?? null, kind: g.job.kind ?? null } : null,
  };
}

/** Copy the host-side record into one run's state dir (before the launch). Returns grantInfo or null. */
export function installGrant(stateDir, file = C2_GRANT_FILE) {
  const info = grantInfo(file);
  if (!info) return null;
  const dest = grantRecordPath(stateDir);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.copyFileSync(file, dest);
  fs.chmodSync(dest, 0o600);
  return info;
}

const copyIf = (src, dst) => {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
  return true;
};

/**
 * What the shared C2 state still lacks before a hostc C2 run can launch (empty: ready): a ticket-bound
 * job grant, the shared ticket and credential it is bound to, the device-signed measurement approval.
 */
export function sharedC2Missing(dir = C2_GRANT_DIR) {
  const out = [];
  const g = grantInfo(grantRecordPath(dir));
  if (!g) out.push("grant");
  else if (!g.ticketBound || !g.job) out.push("job-bound grant");
  if (!fs.existsSync(ticketPath(dir)) || !fs.existsSync(path.join(authDirOf(dir), "factors.json"))) out.push("ticket");
  if (!fs.existsSync(approvalsPath(dir))) out.push("approvals");
  return out;
}

/**
 * hostc, C2: copy the shared state into one run's state dir: the grant record, the credential and the
 * ONE ticket it is bound to (the launch must present that very ticket), and the approvals. Returns
 * grantInfo or null when any of it is missing (nothing is copied then).
 */
export function installShared(stateDir, dir = C2_GRANT_DIR) {
  if (sharedC2Missing(dir).length) return null;
  copyIf(path.join(authDirOf(dir), "factors.json"), path.join(authDirOf(stateDir), "factors.json"));
  copyIf(ticketPath(dir), ticketPath(stateDir));
  copyIf(approvalsPath(dir), approvalsPath(stateDir));
  return installGrant(stateDir, grantRecordPath(dir));
}

/** codenclawed's audit records (hash-chained JSONL) of one run's state dir. */
export function readAudit(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, "claude-code", "audit.jsonl"), "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * How the device-unlock step of a C2 launch ended: { spent: true, ... } when the device counted a use,
 * { spent: false, code, gone } when it refused (gone: only a new grant helps), or null when the launch
 * never reached that step. From the kit's audit record (type "auth.device-factor" under any prefix, via "device-unlock")
 * of the FIRST launch in the state dir (the genuine one; a compromised-host attacker relaunches after
 * it), else from the launcher's stderr.
 */
export function unlockOutcome(audit, stderr = "") {
  // codenclawed writes the kit's record under its own prefix ("claude-code.auth.device-factor").
  const last = audit.find((x) => typeof x?.type === "string" && /(?:^|\.)auth\.device-factor$/.test(x.type) && x.payload?.via === "device-unlock");
  if (last?.payload?.outcome === "verified") {
    return { spent: true, gid: last.payload.gid ?? null, useIndex: last.payload.useIndex ?? null, usesLeft: last.payload.usesLeft ?? null };
  }
  if (last?.payload?.outcome === "refused") {
    const code = String(last.payload.code ?? "unknown");
    return { spent: false, code, gone: GRANT_GONE_CODES.has(code) };
  }
  if (GRANT_GONE_TEXT.test(stderr)) {
    return { spent: false, code: /holds another unlock/i.test(stderr) ? "mismatch" : "no-grant", gone: true };
  }
  return null;
}

/**
 * The invalid mark of a C2 record whose session never started, or null. `launched`: claude started.
 * A used-up grant is its own mark (the runner pauses); every other activation/unlock refusal is a
 * misconfigured launch. Neither is ever counted, nor taken as a refusal by design.
 */
export function c2LaunchInvalid({ launched, unlock, stderr = "" }) {
  if (launched) return null;
  if (unlock && !unlock.spent && unlock.gone) return C2_UNLOCK_EXHAUSTED;
  if ((unlock && !unlock.spent) || ACTIVATION_REFUSAL.test(stderr)) return C_ARM_MISCONFIGURED;
  return null;
}

const HERE_DIR = path.dirname(new URL(import.meta.url).pathname);
/** The one command the person runs to issue the shared grant (c2-grant.mjs, with the broker running). */
export function issueCommand(build) {
  return `node ${path.join(HERE_DIR, "c2-grant.mjs")} --build ${build} --work-dir ${WORK} --uses ${C2_SHARED_USES} --minutes ${C2_SHARED_MINUTES} --job ${C2_JOB_NAME}`;
}
/** The one command the person runs once per snapshot: the device-signed approval of its measurement (and policy). */
export function approveCommand(build) {
  return `node ${path.join(HERE_DIR, "c2-approve.mjs")} --build ${build} --work-dir ${WORK}`;
}

/**
 * Attack 7's command: ONE use, a short lease, issued into that run's own state dir and bound to the
 * one-use ticket prepared for that run (hostc.mjs prepareFreshGrant), so neither a copy of the shared
 * grant nor the attacker's own ticket can spend it.
 */
export function freshGrantCommand(build, stateDir, ticketFile) {
  return `node ${path.join(HERE_DIR, "c2-grant.mjs")} --build ${build} --work-dir ${WORK} --grant-dir ${stateDir} --uses 1 --minutes 10 --bind-ticket ${ticketFile}`;
}

/**
 * Attack 7: copy what was prepared for this run (the person's throwaway credential, its one-use
 * ticket and the fresh grant record bound to it) into the run's state dir. Returns grantInfo or null.
 */
export function installPrepared(stateDir, preparedState, sharedDir = C2_GRANT_DIR) {
  const info = grantInfo(grantRecordPath(preparedState));
  const auth = path.join(preparedState, "claude-code", "auth");
  if (!info || !fs.existsSync(path.join(auth, "unlock-ticket.json"))) return null;
  fs.mkdirSync(path.join(stateDir, "claude-code"), { recursive: true, mode: 0o700 });
  fs.cpSync(auth, path.join(stateDir, "claude-code", "auth"), { recursive: true });
  // The snapshot's measurement approval is the shared one (once per snapshot).
  copyIf(approvalsPath(sharedDir), approvalsPath(stateDir));
  return installGrant(stateDir, grantRecordPath(preparedState));
}

/**
 * Wait until the host-side record is newer than `afterMtimeMs` (null: until any readable record
 * exists). Prints ONE line, records a pause event, polls every `pollMs`, and gives up only when
 * `shouldStop()` says so (then returns null).
 */
export async function waitForGrant({ afterMtimeMs = null, build, reason, event = () => {}, out = process.stdout, pollMs = 10_000, shouldStop = () => false, file = C2_GRANT_FILE, command = null, ready = () => true }) {
  // `ready`: anything else the run needs besides a newer record (hostc: the shared ticket, the approvals).
  const fresh = () => {
    const g = grantInfo(file);
    return g && (afterMtimeMs === null || g.mtimeMs > afterMtimeMs) && ready() ? g : null;
  };
  let g = fresh();
  if (g) return g;
  event({ type: "pause", reason: `c2-unlock: ${reason}`, grantFile: file, waitingFor: afterMtimeMs === null ? "a grant record" : "a grant record newer than the used-up one" });
  // Say plainly who must act and how: only the person can issue an unlock (an authenticator code the
  // device checks), and the runner is waiting, not broken.
  out.write(
    `C2 paused: waiting for a device unlock (${reason}).\n` +
      `  Run this at a terminal, with the device plugged in, and type the code from your authenticator app:\n` +
      `    ${[].concat(command ?? issueCommand(build)).join("\n    ")}\n` +
      `  C2 resumes by itself within ${Math.round(pollMs / 1000)} seconds of the new unlock.\n`,
  );
  for (;;) {
    if (shouldStop()) return null;
    await new Promise((r) => setTimeout(r, pollMs));
    g = fresh();
    if (g) {
      event({ type: "resume", reason: "c2-unlock: new grant record", gid: g.gid, uses: g.uses, mtime: new Date(g.mtimeMs).toISOString() });
      out.write(`C2 resumed: new device unlock (gid ${g.gid}, ${g.uses} uses)\n`);
      return g;
    }
  }
}
