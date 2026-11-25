#!/usr/bin/env node
// Model-roster probe: which of the benchmark's candidate models the account of
// the person running it actually serves. It writes the roster run.mjs reads
// (--roster / BENCH_ROSTER, default <work-dir>/roster.json), so the roster step
// is reproducible by anybody with their own login: credentials come only from
// whoever runs it (--auth, exactly as in run.mjs) and are never written.
//
//   node probe-models.mjs [--auth subscription|api-key|credentials-file] [--credentials FILE]
//        [--models a,b,...] [--work-dir DIR] [--out FILE] [--claude-version V] [--yes]
//
// One minimal `claude -p` call per model, inside the benchmark's own sandbox
// (sandbox-ext.mjs runBench: read-only host, tmpfs HOME, ~/.claude holding only
// the chosen login bound read-only) with the benchmark's account-content
// settings (no claude.ai connectors, no synced skills or plugins,
// --strict-mcp-config), its v4 hard guard (run.mjs streamAccountExposure /
// syncedDirsExposure) and its Claude Code version pin. A model is served when
// the call succeeds and every main-loop assistant message came from that model
// (the id itself, or the id plus a date suffix, e.g. claude-haiku-4-5-20251001).
//
// Output: {"served":[...], "probedAt", "claudeVersion", "pinVersion", "auth":"<mode>",
//          "answered":{requested: answered|null}, "notProbed":[...] only when some call hit a usage limit} — the auth MODE only, never a token,
// email, organization or account id.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AUTH_FLAG, AUTH_MODES, CREDENTIALS_FLAG, WORK, credentialsMinutesLeft, resolveAuth } from "./bench-config.mjs";
import { MODEL_ORDER, PIN_VERSION, classifyError, streamAccountExposure, syncedDirsExposure } from "./run.mjs";
import { runBench } from "./sandbox-ext.mjs";
import { HOME, preflight } from "./scenarios/sandbox.mjs";

// The interactive auth prompt, word for word the one in run.mjs (probe-models.test.mjs checks
// that run.mjs still contains it, so the two cannot drift apart silently).
export const AUTH_PROMPT =
  "How should Claude Code authenticate inside the sandbox?\n" +
  "  1) subscription      your own Claude login from ~/.claude/.credentials.json, mounted read-only\n" +
  "  2) api-key           ANTHROPIC_API_KEY from this environment (API billing applies)\n" +
  "  3) credentials-file  another Claude credentials file, mounted read-only\n";
export const AUTH_CHOICES = { 1: "subscription", 2: "api-key", 3: "credentials-file" };

/** init, result and the main-loop assistant models of a stream-json transcript. */
export function parseStreamText(text) {
  let init = null;
  let result = null;
  const models = new Set();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "system" && m.subtype === "init") init = m;
    if (m.type === "assistant" && m.message?.model) models.add(String(m.message.model));
    if (m.type === "result") result = m;
  }
  return { init, result, assistantModels: [...models] };
}

/** True when the answering model is the requested one: the same id, or the id plus a date suffix. */
export function modelMatches(requested, answered) {
  const r = String(requested);
  return (Array.isArray(answered) ? answered : String(answered ?? "").split(",")).every((a) => a === r || new RegExp(`^${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}$`).test(a)) && (Array.isArray(answered) ? answered.length > 0 : Boolean(answered));
}

/**
 * One probe's verdict from its parsed stream, classified with run.mjs's own classifyError.
 * status: "served" | "not-served" | "not-probed" (a usage limit or a transient API error: says nothing
 * about the model, so it never removes one from the roster) | "auth" (the login is unusable: stop).
 */
export function probeVerdict(requested, parsed, stderr = "") {
  const errorClass = classifyError(parsed.result, stderr);
  if (errorClass === "usage-limit" || errorClass === "api-transient") return { requested, answered: null, served: false, status: "not-probed", errorClass };
  if (errorClass === "auth") return { requested, answered: null, served: false, status: "auth", errorClass };
  const answered = parsed.assistantModels.join(",") || null;
  const ok = Boolean(parsed.result && parsed.result.subtype === "success" && !parsed.result.is_error);
  const served = ok && modelMatches(requested, parsed.assistantModels);
  return { requested, answered, served, status: served ? "served" : "not-served", errorClass: null };
}

// What may appear in a model id we write; anything else (or anything secret-shaped) is dropped.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;
const SECRETISH = /sk-ant-|@|token|bearer|org[-_]|acct|account|[0-9a-f]{8}-[0-9a-f]{4}-/i;
const cleanId = (s) => (typeof s === "string" && s.split(",").every((p) => MODEL_ID.test(p) && !SECRETISH.test(p)) ? s : null);

/**
 * The roster file contents. `verdicts` are probeVerdict() results; `order` fixes the order of `served`
 * (run.mjs's MODEL_ORDER first, any extra ids after it). Only model ids, versions, a timestamp and the auth
 * MODE are kept. A "not-probed" model (usage limit, transient API error) keeps the verdict of `previous`
 * (the roster already at --out) when it has one, and is listed in notProbed either way, so a rate-limited
 * probe never drops a model; with no earlier verdict it is not in served (fail closed) until a rerun probes it.
 * Models in `previous` that this probe did not ask about are kept unchanged (delete --out to start fresh).
 */
export function buildRoster({ verdicts, order = MODEL_ORDER, probedAt, claudeVersion, pinVersion, auth, previous = null }) {
  if (!AUTH_MODES.includes(auth)) throw new Error(`auth must be one of ${AUTH_MODES.join(", ")} (the mode, never a secret)`);
  const rank = (m) => (order.includes(m) ? order.indexOf(m) : order.length);
  const version = (v) => (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : null);
  const prevServed = new Set(Array.isArray(previous?.served) ? previous.served : []);
  const prevAnswered = previous?.answered && typeof previous.answered === "object" ? previous.answered : {};
  // Models of the earlier roster that this probe did not ask about (a rerun with --models) are kept as they were.
  const asked = new Set(verdicts.map((v) => v.requested));
  const kept = [...new Set([...prevServed, ...Object.keys(prevAnswered)])].filter((m) => !asked.has(m)).map((m) => ({ requested: m, status: "kept" }));
  const sorted = [...verdicts, ...kept].filter((v) => cleanId(v.requested)).sort((a, b) => rank(a.requested) - rank(b.requested));
  const notProbed = sorted.filter((v) => v.status === "not-probed").map((v) => v.requested);
  const fromPrevious = (v) => v.status === "not-probed" || v.status === "kept";
  const isServed = (v) => (fromPrevious(v) ? prevServed.has(v.requested) : v.served);
  const answeredOf = (v) => (fromPrevious(v) ? cleanId(prevAnswered[v.requested]) : cleanId(v.answered));
  return {
    served: sorted.filter(isServed).map((v) => v.requested),
    probedAt: new Date(probedAt ?? Date.now()).toISOString(),
    claudeVersion: version(claudeVersion),
    pinVersion: version(pinVersion),
    auth,
    answered: Object.fromEntries(sorted.map((v) => [v.requested, answeredOf(v)])),
    ...(notProbed.length ? { notProbed } : {}),
  };
}

/** Write the roster (pretty JSON), refusing anything that looks like a credential. */
export function writeRoster(file, roster) {
  const text = `${JSON.stringify(roster, null, 2)}\n`;
  if (/sk-ant-|accessToken|refreshToken|"(email|organization|org_?id|account_?id|uuid)"/i.test(text)) throw new Error("refusing to write a roster that contains credential-shaped data");
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

// ---------------------------------------------------------------- live probe

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
}

/** One minimal call for `model` in the benchmark's sandbox; throws on a hard-guard or version-pin violation. */
async function probeOne(model, { auth, pinVersion, workdir }) {
  const runDir = path.join(workdir, "probe-runs", `${model}.${crypto.randomBytes(3).toString("hex")}`);
  const proj = path.join(runDir, "proj");
  const outDir = path.join(runDir, "out");
  for (const d of [proj, outDir]) fs.mkdirSync(d, { recursive: true });
  const stream = path.join(outDir, "stream.jsonl");
  // run.mjs's per-run settings for every arm: account connectors, synced skills and plugins off.
  const userSettings = JSON.stringify({ disableClaudeAiConnectors: true, syncClaudeAiSkills: false, syncClaudeAiPlugins: false });
  const claudeArgs = ["-p", "Reply with the single word OK.", "--model", model, "--permission-mode", "default", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "1", "--strict-mcp-config"];
  const script = [
    "set -u",
    'echo \'{"hasCompletedOnboarding":true}\' > "$HOME/.claude.json"',
    'printf "%s" "$USER_SETTINGS" > "$HOME/.claude/settings.json"',
    '"$@"',
    "code=$?",
    // v4 guard input, as in run.mjs: anything synced from the account into the sandbox HOME.
    '(cd "$HOME" && find .claude/skills .claude/plugins -mindepth 1 2>/dev/null | sort) > "$OUT/claude-skills-plugins.txt"',
    'exit "$code"',
  ].join("\n");
  const env = {
    HOME,
    USER: os.userInfo().username,
    LANG: "C.UTF-8",
    PATH: `${path.join(HOME, ".local", "bin")}:/usr/bin:/bin`,
    TERM: "dumb",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    DISABLE_AUTOUPDATER: "1",
    ...(auth.apiKey ? { ANTHROPIC_API_KEY: auth.apiKey } : {}),
    TMPDIR: "/tmp",
    OUT: outDir,
    USER_SETTINGS: userSettings,
  };
  const abortIf = () => {
    let text = "";
    try {
      text = fs.readFileSync(stream, "utf8");
    } catch {
      return null;
    }
    const x = streamAccountExposure(text);
    return x ? `${x.invalid}: ${JSON.stringify(x.detail)}` : null;
  };
  const r = await runBench({ runDir, cwd: proj, argv: ["/bin/bash", "-c", script, "probe", "claude", ...claudeArgs], env, credentialsFile: auth.credentialsFile, abortIf, stdoutFile: stream, stderrFile: path.join(outDir, "stderr.txt"), timeoutMs: 180_000 });
  const text = fs.existsSync(stream) ? fs.readFileSync(stream, "utf8") : "";
  const s = streamAccountExposure(text);
  const d = (() => {
    try {
      return syncedDirsExposure(fs.readFileSync(path.join(outDir, "claude-skills-plugins.txt"), "utf8"));
    } catch {
      return null;
    }
  })();
  if (r.aborted || s || d) throw new Error(`HARD GUARD (account content): ${r.aborted ?? (s ? `${s.invalid}: ${JSON.stringify(s.detail)}` : JSON.stringify(d))} (run ${runDir})`);
  const parsed = parseStreamText(text);
  const version = parsed.init?.claude_code_version ?? null;
  if (version && version !== pinVersion) throw new Error(`HARD GUARD (version pin): Claude Code ${version} answered, the benchmark is pinned to ${pinVersion} (run ${runDir})`);
  const stderr = (() => {
    try {
      return fs.readFileSync(path.join(outDir, "stderr.txt"), "utf8");
    } catch {
      return "";
    }
  })();
  const v = probeVerdict(model, parsed, stderr);
  const why = v.served ? null : v.errorClass ? v.errorClass : r.timedOut ? "timed out" : !parsed.result ? `no result (exit ${r.status})` : parsed.result.is_error ? String(parsed.result.result ?? parsed.result.subtype).slice(0, 160) : `answered by ${v.answered ?? "?"}`;
  return { ...v, claudeVersion: version, why };
}

async function confirm(argv, n, auth, pinVersion, out) {
  process.stdout.write(
    `\nModel-roster probe: ${n} call${n === 1 ? "" : "s"} (one minimal \`claude -p\` per model), Claude Code ${pinVersion}, auth ${auth.mode}${auth.credentialsFile ? ` (${auth.credentialsFile}, read-only)` : ""}\n` +
      (auth.mode === "api-key" ? "  Every call is a real API call billed to that key (each capped at --max-budget-usd 1).\n" : "  Every call counts against the subscription's usage limits.\n") +
      "  Every call is checked by the benchmark's v4 hard guard: no claude.ai connector, synced skill or synced plugin may reach the agent.\n" +
      `  Roster: ${out}\n`,
  );
  if (argv.includes("--yes")) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write("probe: not on a terminal: pass --yes to start\n");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question("Start? [y/N]: ")).trim());
  } finally {
    rl.close();
  }
}

async function chooseAuth(argv) {
  let mode = AUTH_FLAG;
  let creds = CREDENTIALS_FLAG;
  if (!mode && process.stdin.isTTY && process.stdout.isTTY && !argv.includes("--yes")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(AUTH_PROMPT);
      const a = (await rl.question("auth (1/2/3) [1]: ")).trim() || "1";
      mode = AUTH_CHOICES[a] ?? a;
      if (mode === "credentials-file" && !creds) creds = (await rl.question("path to the credentials file: ")).trim();
    } finally {
      rl.close();
    }
  }
  if (!mode) throw new Error(`no auth chosen: pass --auth ${AUTH_MODES.join("|")} (and --yes when not on a terminal)`);
  return resolveAuth(mode, creds);
}

export async function main(argv = process.argv.slice(2)) {
  const pinVersion = PIN_VERSION; // run.mjs's pin (its --claude-version flag applies here too)
  const models = (flag(argv, "--models") ?? flag(argv, "--model"))?.split(",").map((s) => s.trim()).filter(Boolean) ?? MODEL_ORDER;
  const bad = models.filter((m) => !cleanId(m));
  if (bad.length) throw new Error(`not a model id: ${bad.join(", ")}`);
  const out = path.resolve(flag(argv, "--out") ?? path.join(WORK, "roster.json"));
  const auth = await chooseAuth(argv);
  // The same checks run.mjs makes before any live run.
  const problems = preflight({ workdir: WORK, minMinutes: -Infinity });
  if (auth.credentialsFile && !fs.existsSync(auth.credentialsFile)) problems.push(`credentials file not found: ${auth.credentialsFile}`);
  const left = credentialsMinutesLeft(auth.credentialsFile);
  if (left !== null && left < 5) problems.push(`the login in ${auth.credentialsFile} expires in ${left.toFixed(0)} min; use claude normally to refresh it, then rerun`);
  try {
    const real = fs.realpathSync(path.join(HOME, ".local", "bin", "claude"));
    if (/^\d+\.\d+\.\d+$/.test(path.basename(real)) && path.basename(real) !== pinVersion) problems.push(`claude on PATH is ${path.basename(real)}; the benchmark is pinned to ${pinVersion} (--claude-version to override)`);
  } catch {
    /* not the native installer layout: the init's version is checked per call */
  }
  if (problems.length) {
    for (const p of problems) process.stderr.write(`probe: ${p}\n`);
    return 2;
  }
  if (!(await confirm(argv, models.length, auth, pinVersion, out))) return 1;
  fs.mkdirSync(WORK, { recursive: true });
  const verdicts = [];
  let claudeVersion = null;
  for (const model of models) {
    const v = await probeOne(model, { auth, pinVersion, workdir: WORK }); // a hard-guard throw stops the probe; nothing is written
    claudeVersion ??= v.claudeVersion;
    process.stdout.write(`${model}: ${v.status} (answered ${v.answered ?? "-"})${v.why ? `: ${v.why}` : ""}\n`);
    if (v.status === "auth") {
      process.stderr.write("probe: the login was refused; nothing written. Use claude normally to log in or refresh, then rerun\n");
      return 3;
    }
    verdicts.push(v);
  }
  const previous = (() => {
    try {
      return JSON.parse(fs.readFileSync(out, "utf8"));
    } catch {
      return null;
    }
  })();
  const roster = buildRoster({ verdicts, probedAt: Date.now(), claudeVersion, pinVersion, auth: auth.mode, previous });
  writeRoster(out, roster);
  process.stdout.write(`roster: ${roster.served.length} of ${models.length} served -> ${out}\n`);
  if (roster.notProbed) {
    process.stdout.write(`not probed (usage limit or transient API error): ${roster.notProbed.join(", ")}; rerun with --models ${roster.notProbed.join(",")} after the limit resets\n`);
    return 4;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      process.stderr.write(`probe: ${e?.message ?? e}\n`);
      process.exit(3);
    },
  );
}
