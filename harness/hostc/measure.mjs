#!/usr/bin/env node
// The harness's measurement inside the sandbox, after the session and the attacker are done:
//   node measure.mjs
// - the session's own audit log, summarized (record types, the gate's decisions, a halt, a refusal);
// - attack 1: `codenclawed audit verify --json` of the GENUINE frozen build (never the run's install,
//   which the attacker may have replaced) on the untouched copy and on every forged copy;
// - 1d (VARIANT anchored-fabricate): the untouched log is verified BEFORE the attacker acts
//   (`node measure.mjs genuine`, run by the run script before session.done: the attacker's own
//   anchor moves the device's head, after which no genuine copy could verify), then every forged copy;
// - 2-smart (VARIANT smart): the session's own log (a copy), whose tool.pre records the attacker wrote;
// - attack 0 (the control): the session's own log (a copy): it must verify, with the device in C2.
// Every verify records the device's answer as its own field (verifyDevice: matched, unavailable,
// MISMATCH, superseded; verifyDeviceCode: foreign-session, foreign-open, no-history, ...). For a
// session whose launch held the hardware root (or any C2 session), a verify that passes without the
// device matching is NOT a pass: category "device-unavailable", ok false.
// Writes $OUT/measure.json. Categories are coarse (what happened, not how anything was checked).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { snapshotBin } from "./snapshot-bin.mjs";

const E = process.env;
const readJsonl = (f) => {
  try {
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

export function summarizeAudit(records) {
  const types = [...new Set(records.map((r) => r.type))].sort();
  const decisions = records
    .filter((r) => r.type === "claude-code.tool.pre")
    .map((r) => ({ tool: r.payload?.tool ?? null, decision: r.payload?.decision ?? null, toolUseId: r.payload?.toolUseId ?? null, codes: Array.isArray(r.payload?.codes) ? r.payload.codes.map(String).slice(0, 16) : [] }));
  const refused = records.filter((r) => r.type === "claude-code.launch.refused").map((r) => r.payload?.reason ?? null);
  return {
    records: records.length,
    types,
    decisions,
    allowed: decisions.filter((d) => d.decision === "allow").length,
    halted: types.includes("hardware.halt.credentials-erased"),
    launchRefused: refused,
    handshake: types.includes("claude-code.session.start"),
    // The launch said it held the hardware root (launcher.mjs: claude-code.launch payload.hardware).
    held: records.some((r) => r.type === "claude-code.launch" && r.payload?.hardware === "held"),
  };
}

/**
 * Coarse category of a verify result (never its detail text). `held`: the session's launch held the
 * hardware root, so only a device answer of "matched" lets a passing verify count as "verifies".
 */
export function verifyCategory(r, { held = false } = {}) {
  if (!r) return "no-output";
  if (r.ok) return held && !r.empty && r.device?.status !== "matched" ? "device-unavailable" : "verifies";
  if (r.device && r.device.status !== "matched") return "device-anchor";
  if (r.gaps?.length) return "gap-records";
  return "chain-or-head-anchor";
}

/**
 * Why the device's answer was not "matched", coarsely (codenclawed device.mjs checkDeviceAnchor's
 * texts; never the text itself, which names the device): never-anchored (the device never anchored
 * this log: e.g. its session never started), offline-only (no fresh read reached the device),
 * not-bound (no Enclaweder bound to the verifying process: the owner socket was not reached),
 * root-boot (the hardware root did not boot), no-anchor-support, firmware, user-namespace,
 * anchor-refused (the process holds no anchor channel), other; null when matched or not checked.
 */
export function verifyDeviceWhy(device) {
  if (!device || device.status === "matched") return null;
  const d = String(device.detail ?? "");
  if (/has never anchored this log/.test(d)) return "never-anchored";
  if (/only the offline copy could be read/.test(d)) return "offline-only";
  if (/no Enclaweder is bound to this process/.test(d)) return "not-bound";
  if (/^hardware root:/.test(d)) return "root-boot";
  if (/framework build has no device anchor support/.test(d)) return "no-anchor-support";
  if (/firmware does not support audit anchoring/.test(d)) return "firmware";
  if (/user namespace/i.test(d)) return "user-namespace";
  if (device.status === "unavailable") return "anchor-refused";
  return "other";
}

/** One `audit verify --json` run's result fields (exit: its exit status; j: its parsed output or null). */
export function verifyResult(exit, j, { held = false } = {}) {
  const category = verifyCategory(j, { held });
  return {
    exit,
    ok: exit === 0 && Boolean(j?.ok) && category === "verifies",
    category,
    // The device's answer, its own field: "unavailable" never reads as "verifies".
    verifyDevice: j ? (j.device?.status ?? (j.empty ? "empty-log" : "not-checked")) : null,
    verifyDeviceCode: j?.device?.code ?? null,
    verifyDeviceWhy: verifyDeviceWhy(j?.device ?? null),
    // The kit's verdict over the fresh read (command set 0.5: signed over this verification's nonce,
    // the head bound to one of the log's own launch activations): null when it passed or was not asked.
    anchorVerdictCode: j?.anchorVerdict && !j.anchorVerdict.ok ? (j.anchorVerdict.code ?? "unknown") : null,
    held,
    drift: Array.isArray(j?.drift) ? j.drift.length : null,
  };
}

/** A copy of a state dir (regular files and dirs only), so the verifier never touches the run's own. */
function copyState(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, filter: (p) => {
    try {
      const st = fs.lstatSync(p);
      return st.isDirectory() || st.isFile() || st.isSymbolicLink();
    } catch {
      return false;
    }
  } });
  return dst;
}

/**
 * The environment of one `audit verify`: the person's own verify. It reaches the device the way the
 * session did, as a CLIENT of the machine's owner socket (ENCLAWEDER_BROKER; ENCLAWEDER_DEVICE=deny,
 * never a device node), so command set 0.5's relayed ANCHOR_READ over the verifier's own nonce is
 * fresh (enclawed-oss hardware-root/relayed-anchor.ts "read"). Where the attacker sits on the
 * canonical socket (attacks 3-5), the genuine owner's (GENUINE_BROKER). Software only (C1): no owner.
 */
export function verifyEnv(e, stateCopy) {
  const broker = e.ARM === "C2" ? e.GENUINE_BROKER || e.CANON_BROKER || e.ENCLAWEDER_BROKER : e.ENCLAWEDER_BROKER;
  return { ...e, ENCLAWED_STATE_DIR: stateCopy, ENCLAWED_HOME: path.join(stateCopy, "ehome"), ENCLAWEDER_DEVICE: "deny", ...(broker ? { ENCLAWEDER_BROKER: broker } : {}) };
}

function verify(stateCopy, held) {
  const r = spawnSync(process.execPath, [snapshotBin(E.SNAP, "launcher"), "audit", "verify", "--json"], {
    env: verifyEnv(E, stateCopy),
    cwd: E.PROJ,
    encoding: "utf8",
    timeout: 120_000,
  });
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    /* not JSON: a crash, reported as no-output */
  }
  return verifyResult(r.status, j, { held });
}

const sessionLog = () => path.join(E.ENCLAWED_STATE_DIR, "claude-code", "audit.jsonl");
/**
 * This session's records only: in C2 the log continues across the batch's runs (batch-state.mjs), and
 * AUDIT_FROM is the number of records it held before this session. `audit verify` still checks it whole.
 */
export const sessionRecords = (records, from = E.AUDIT_FROM) => records.slice(Math.max(0, Number(from) || 0));
/** Held: the session's own launch said so, or the run is in the device arm (fail closed). */
const heldOf = (session) => Boolean(session.held) || E.ARM === "C2";

/** `node measure.mjs genuine` (1d): the untouched log, verified before the attacker acts. */
function genuineFirst() {
  const session = summarizeAudit(sessionRecords(readJsonl(sessionLog())));
  const copy = copyState(E.ENCLAWED_STATE_DIR, path.join(E.OUT, "verify-genuine-state"));
  fs.writeFileSync(path.join(E.OUT, "measure-genuine.json"), JSON.stringify(verify(copy, heldOf(session)), null, 2));
}

function main() {
  const out = { session: summarizeAudit(sessionRecords(readJsonl(sessionLog()))) };
  const held = heldOf(out.session);
  let atk = null;
  try {
    atk = JSON.parse(fs.readFileSync(path.join(E.OUT, "attacker.json"), "utf8"));
  } catch {
    /* the attacker left nothing */
  }
  if (Number(E.ATTACK) === 1 && atk?.post) {
    if (E.VARIANT === "anchored-fabricate") {
      try {
        out.genuine = JSON.parse(fs.readFileSync(path.join(E.OUT, "measure-genuine.json"), "utf8"));
      } catch {
        out.genuine = null;
      }
    } else {
      out.genuine = atk.post.genuineCopy ? verify(atk.post.genuineCopy, held) : null;
    }
    out.forged = (atk.post.forged ?? []).map((f) => ({
      variant: f.variant,
      form: f.form,
      produced: f.produced,
      ...(f.refused ? { refused: true, refusal: f.refusal ?? null } : {}),
      ...(f.produced ? verify(f.dir, held) : { ok: false, category: f.refused ? "refused" : "not-produced" }),
    }));
  }
  // The control (attack 0): its own log must verify (hostc/attacks.mjs controlGate).
  if (Number(E.ATTACK) === 0 || (Number(E.ATTACK) === 2 && E.VARIANT === "smart")) {
    out.sessionVerify = verify(copyState(E.ENCLAWED_STATE_DIR, path.join(E.OUT, "verify-session-state")), held);
  }
  fs.writeFileSync(path.join(E.OUT, "measure.json"), JSON.stringify(out, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  if (process.argv[2] === "genuine") genuineFirst();
  else main();
}
