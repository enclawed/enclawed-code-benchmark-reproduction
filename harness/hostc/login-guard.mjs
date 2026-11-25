// The person's Claude login must never be refreshed by a benchmark run.
//
// Why: codenclawed builds with the login seal (src/login-seal.mjs, from 7373641; every build from
// bcd03c8 on) seal the login when an Enclaweder is bound and serve it through Enclawed's auth relay
// (enclawed-oss src/enclawed/adapter/auth-relay.ts). The relay refreshes the OAuth token when it is
// within REFRESH_MARGIN_MS of expiry, or once on a 401, and OAuth refresh tokens ROTATE. Every run
// gets a COPY of the person's login; if a run's relay (or a plain claude on a run's copy) refreshes
// that copy, the rotated refresh token stays in the run's throwaway state and the person's real login
// is left holding an invalidated refresh token: they are logged out of Claude Code everywhere, and
// every later run fails.
//
// So, before a run whose build seals the login: the login's access token must stay valid for the
// run's whole time limit + REFRESH_MARGIN_MS + SLACK_MS (then neither the relay nor claude has a
// reason to refresh); otherwise the runner PAUSES (nothing runs, no cell is burned) until the person's
// own Claude Code has refreshed it. After every run, a refresh seen in the run's state stops the batch.
//
// Secrets: this module reads ONE field of the credentials file, the numeric `expiresAt` (ms). It
// never returns, prints, logs, records or copies any other field, and its errors are fixed codes
// (a JSON.parse message would quote the file's bytes, so it is never passed on).
//
// No imports but node's own: the sandboxed hostc programs (hostc/*.mjs, copied into each run) use it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** enclawed-oss src/enclawed/adapter/auth-relay.ts REFRESH_MARGIN_MS (5 min). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Slack on top of the run's time limit and the relay's margin. */
export const SLACK_MS = 5 * 60 * 1000;
/** How often a paused runner looks at the expiry again. */
export const POLL_MS = 30_000;
export const WAIT_LINE = "waiting for the person's Claude login to be refreshed by their own Claude Code; no benchmark run may refresh it";
/** Where codenclawed keeps the sealed login, under ENCLAWED_STATE_DIR (src/login-seal.mjs sealedLoginFile). */
export const SEALED_LOGIN_REL = path.join("claude-code", "credentials", "claude-login.sealed.json");

/**
 * The login's expiry: the numeric `expiresAt` nearest the top of the document (breadth-first; at
 * the same depth, the earliest). Claude Code's file keeps it at claudeAiOauth.expiresAt (depth 2);
 * deeper ones (e.g. per-server MCP OAuth entries) are not the login's. Returns a number or null.
 */
export function findExpiresAt(doc) {
  let level = [doc];
  for (let depth = 0; depth < 32 && level.length; depth++) {
    const next = [];
    let best = null;
    for (const v of level) {
      if (!v || typeof v !== "object") continue;
      for (const [k, x] of Object.entries(v)) {
        if (k === "expiresAt" && typeof x === "number" && Number.isFinite(x)) best = best === null ? x : Math.min(best, x);
        else if (x && typeof x === "object") next.push(x);
      }
    }
    if (best !== null) return best;
    level = next;
  }
  return null;
}

/**
 * The expiry (ms since the epoch) of the login in `file`, and nothing else from it.
 * @returns {{ code: "ok", expiresAt: number } | { code: "no-file" | "unreadable" | "not-json" | "no-expiry", expiresAt: null }}
 */
export function loginExpiry(file) {
  if (!file) return { code: "no-file", expiresAt: null };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { code: e?.code === "ENOENT" ? "no-file" : "unreadable", expiresAt: null };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { code: "not-json", expiresAt: null }; // never the parser's message: it quotes the file
  } finally {
    text = null;
  }
  const expiresAt = findExpiresAt(doc);
  doc = null;
  return expiresAt === null ? { code: "no-expiry", expiresAt: null } : { code: "ok", expiresAt };
}

/** Remaining validity of the login's access token, in ms (negative when expired), or null with a code. */
export function loginRemainingMs(file, now = Date.now()) {
  const e = loginExpiry(file);
  return { code: e.code, remainingMs: e.expiresAt === null ? null : e.expiresAt - now };
}

/** What a run needs left on the login before it may start: its time limit + the relay's margin + slack. */
export function requiredLoginValidityMs(timeLimitMs) {
  if (!(Number.isFinite(timeLimitMs) && timeLimitMs > 0)) throw new Error("requiredLoginValidityMs: a positive time limit in ms");
  return timeLimitMs + REFRESH_MARGIN_MS + SLACK_MS;
}

const wiringCache = new Map();
const fileHas = (file, words) => {
  try {
    const t = fs.readFileSync(file, "utf8");
    return words.filter((w) => t.includes(w));
  } catch {
    return [];
  }
};

/**
 * Whether a frozen codenclawed snapshot seals the login and serves it through the auth relay.
 * Evidence (any one suffices; a snapshot that merely ships the relay counts, which only makes the
 * guard apply more often):
 *   - src/login-seal.mjs that starts the kit's relay or seals the login (startAuthRelay, sealLoginFile,
 *     oauthRelayCredential), or
 *   - the snapshot's framework (.enclawed-dev/framework/framework.js) exporting the auth relay or the
 *     login seal (startAuthRelay, oauthRelayCredential, sealLoginFile).
 * @returns {{ seals: boolean, evidence: string[] }}
 */
export function loginSealWiring(snap) {
  if (!snap) return { seals: false, evidence: [] };
  if (wiringCache.has(snap)) return wiringCache.get(snap);
  const words = ["startAuthRelay", "oauthRelayCredential", "sealLoginFile"];
  const evidence = [
    ...fileHas(path.join(snap, "src", "login-seal.mjs"), words).map((w) => `src/login-seal.mjs:${w}`),
    ...fileHas(path.join(snap, ".enclawed-dev", "framework", "framework.js"), words).map((w) => `framework.js:${w}`),
  ];
  const r = { seals: evidence.length > 0, evidence };
  wiringCache.set(snap, r);
  return r;
}

/**
 * How the chosen login reaches ONE session's sandbox, so that each launch finds exactly one login
 * state, as on a real machine (sandbox-ext.mjs CREDENTIALS_MODES):
 *   "none"     no login file (an API key);
 *   "ro-bind"  a build that does not seal the login: the real file, read-only (the run script copies it);
 *   "copy"     a sealing build, no sealed login in the session's state: the run's one writable copy,
 *              which the session's first launch seals under the device and erases;
 *   "sealed"   a sealing build whose state already holds the login an earlier session of the SAME run
 *              sealed (a carried session, e.g. 8-poison's poison-between): no plaintext at all (the
 *              real file masked): a plaintext copy beside the sealed one is what codenclawed refuses
 *              (login-seal plaintext-beside-seal), and a person launching again has no such copy.
 * @param {{ seals: boolean, credentialsFile: string|null, sealedPresent: boolean }} o
 */
export function loginDelivery({ seals, credentialsFile, sealedPresent }) {
  if (!credentialsFile) return "none";
  if (!seals) return "ro-bind";
  return sealedPresent ? "sealed" : "copy";
}

/** Whether the codenclawed state dir `state` holds a sealed login. */
export const sealedLoginIn = (state) => Boolean(state) && fs.existsSync(path.join(state, SEALED_LOGIN_REL));

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the login in `file` has at least requiredLoginValidityMs(timeLimitMs) left. While it has
 * not: ONE line (WAIT_LINE) through `say`, an event on each look, a look every `pollMs`. Nothing is
 * refreshed here; only the person's own Claude Code may refresh their login.
 * No file (an API key): returns at once.
 * @returns {Promise<{ ok: true, waitedMs: number, remainingMs: number | null, requiredMs: number } | { ok: false, stopped: true, waitedMs: number, requiredMs: number }>}
 */
export async function waitForLoginValidity({ file, timeLimitMs, say = (l) => process.stdout.write(`${l}\n`), event = () => {}, shouldStop = () => false, sleep = defaultSleep, now = Date.now, pollMs = POLL_MS, label = "" }) {
  const requiredMs = requiredLoginValidityMs(timeLimitMs);
  const t0 = now();
  if (!file) return { ok: true, waitedMs: 0, remainingMs: null, requiredMs };
  let said = false;
  for (;;) {
    const { code, remainingMs } = loginRemainingMs(file, now());
    if (remainingMs !== null && remainingMs >= requiredMs) {
      if (said) {
        event({ type: "login-guard-resume", label, remainingMin: Math.floor(remainingMs / 60_000), requiredMin: Math.ceil(requiredMs / 60_000), waitedS: Math.round((now() - t0) / 1000) });
        say(`login guard: the login is long enough again; resuming${label ? ` (${label})` : ""}`);
      }
      return { ok: true, waitedMs: now() - t0, remainingMs, requiredMs };
    }
    if (shouldStop()) return { ok: false, stopped: true, waitedMs: now() - t0, requiredMs };
    const left = remainingMs === null ? `its expiry cannot be read (${code})` : `${Math.floor(remainingMs / 60_000)} min left`;
    event({ type: "login-guard-pause", label, reason: WAIT_LINE, login: left, requiredMin: Math.ceil(requiredMs / 60_000) });
    if (!said) {
      say(`${WAIT_LINE} (${left}; this run needs ${Math.ceil(requiredMs / 60_000)} min${label ? `; ${label}` : ""})`);
      said = true;
    }
    await sleep(pollMs);
  }
}

/**
 * The kit's audited relay refresh records (enclawed-oss adapter/auth-relay.ts AUTH_RELAY_REFRESH_RECORD),
 * under any adapter prefix (codenclawed: claude-code.auth.relay.token-refreshed / -refresh-failed). A
 * FAILED refresh counts too: the token endpoint may have rotated the refresh token without the relay
 * receiving the new one, so the person's real login may be invalidated all the same.
 */
export const KIT_REFRESH_RECORD = /(?:^|\.)auth\.relay\.token-refresh(?:ed|-failed)$/;

/** An audit record that reports a token refresh, or a failed one (a build that audits its relay's events). */
export function auditRecordIsRefresh(x) {
  if (!x || typeof x !== "object") return false;
  if (typeof x.type === "string" && (KIT_REFRESH_RECORD.test(x.type) || /refresh/i.test(x.type))) return true;
  const p = x.payload;
  return Boolean(p && typeof p === "object" && (p.kind === "refreshed" || p.event === "refreshed" || p.relay === "refreshed"));
}

/** Audit records of one codenclawed state dir (claude-code/audit.jsonl); unparsable lines skipped. */
export function readStateAudit(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, "claude-code", "audit.jsonl"), "utf8").split("\n").flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const identity = (file) => {
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.dev}:${st.ino}:${st.mtimeNs}:${st.size}`;
  } catch {
    return null;
  }
};

/**
 * Watch the sealed login of each state dir during a run. The relay re-seals a refreshed login
 * (codenclawed src/login-seal.mjs onRotate -> the kit's sealLoginBytes, an atomic rename over the
 * sealed file), so the file is REPLACED while it exists. The first seal (it appears) and a halt's
 * erase (it vanishes) are not refreshes; a replacement with no absence in between is.
 * Polled every `intervalMs` (and once more at finish), plus the audit of each state dir.
 * @returns {{ check: () => void, finish: () => { loginRefreshedInRun: boolean, reseals: number, auditRefreshTypes: string[] } }}
 */
export function watchSealedLogin(stateDirs, { intervalMs = 100 } = {}) {
  const files = [...new Set(stateDirs.filter(Boolean))].map((d) => ({ dir: d, file: path.join(d, SEALED_LOGIN_REL), last: null }));
  let reseals = 0;
  const check = () => {
    for (const f of files) {
      const id = identity(f.file);
      if (id !== null && f.last !== null && id !== f.last) reseals++;
      f.last = id;
    }
  };
  check();
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return {
    check,
    finish() {
      clearInterval(timer);
      check();
      const auditRefreshTypes = [...new Set(files.flatMap((f) => readStateAudit(f.dir).filter(auditRecordIsRefresh).map((x) => String(x.type))))];
      return { loginRefreshedInRun: reseals > 0 || auditRefreshTypes.length > 0, reseals, auditRefreshTypes };
    },
  };
}

/**
 * A plain claude refreshed a run's plaintext COPY of the login: the copy's expiry at the end differs
 * from its expiry when it was made. Expiries only (numbers or null); unknown (null) is not a refresh.
 */
export function copyRefreshed(startExpiresAt, endExpiresAt) {
  return typeof startExpiresAt === "number" && typeof endExpiresAt === "number" && startExpiresAt !== endExpiresAt;
}

/** A file holding `expiresAt` only (written by the CLI below inside the sandbox): number or null. */
export function readExpiryNote(file) {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    return /^\d{1,16}$/.test(t) ? Number(t) : null;
  } catch {
    return null;
  }
}

/**
 * The real login file must stay read-only in every sandbox: refused when it is, or lies under, any
 * path the sandbox gets writable (the run directory, --bind / --dev-bind sources). Returns a problem
 * (paths only) or null.
 */
export function loginBindProblem(credentialsFile, rwPaths) {
  if (!credentialsFile) return null;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const cred = real(credentialsFile);
  for (const p of rwPaths.filter(Boolean)) {
    const r = real(p);
    if (cred === r || cred.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`)) return `the login file ${credentialsFile} would be writable in the sandbox (under the writable path ${p})`;
  }
  return null;
}

/**
 * A refresh happened in a run: the person's real login may now hold an invalidated refresh token.
 * Touch every stop file (results/STOP for run.mjs, and e.g. STOP-HOSTC) and say why. Returns the reason.
 */
export function stopBatchForLoginRefresh(resultsDir, where, { stopFiles = ["STOP"], say = (l) => process.stderr.write(`${l}\n`) } = {}) {
  const why = `LOGIN GUARD: a token refresh happened inside a benchmark run (${where}); OAuth refresh tokens rotate, so the person's real Claude login may now hold an invalidated refresh token. The batch is stopped: check that plain \`claude\` still works (log in again if not) before any further run.`;
  for (const n of stopFiles) {
    try {
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.closeSync(fs.openSync(path.join(resultsDir, n), "a"));
    } catch {
      /* the runner's own stop flag still stops it */
    }
  }
  say(why);
  return why;
}

// CLI (inside the sandbox, no repo visible): `node login-guard.mjs expires FILE` prints the expiry in
// ms, or "null". Nothing else from the file is ever printed.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== "expires" || !file) {
    process.stderr.write("usage: login-guard.mjs expires FILE\n");
    process.exit(2);
  }
  const e = loginExpiry(file);
  process.stdout.write(`${e.expiresAt === null ? "null" : String(e.expiresAt)}\n`);
}
