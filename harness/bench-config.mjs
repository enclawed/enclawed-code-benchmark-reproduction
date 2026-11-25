// Where the benchmark keeps its files and how it authenticates Claude Code.
// Nothing here is specific to one machine or one person: every path comes
// from a flag or an environment variable, with defaults relative to the
// repository or the OS temp directory.
//
//   --work-dir DIR        BENCH_WORK_DIR    run directories, codenclawed snapshots, roster, socat
//                                           (default: <os tmpdir>/codenclawed-bench)
//   --results DIR         BENCH_RESULTS     result JSONL (default: benchmarks/results)
//   --roster FILE         BENCH_ROSTER      JSON {"served":[model ids]} (default: <work-dir>/roster.json;
//                                           without it the models named by --models are used as given)
//   --socat FILE          BENCH_SOCAT       socat for the N1 arm (default: <work-dir>/socat-root/usr/bin/socat,
//                                           else socat on PATH)
//   --auth subscription|api-key|credentials-file      BENCH_AUTH
//   --credentials FILE    BENCH_CREDENTIALS  (with --auth credentials-file)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
};
const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);

export const WORK = path.resolve(nonEmpty(flag("--work-dir")) ?? nonEmpty(process.env.BENCH_WORK_DIR) ?? path.join(os.tmpdir(), "codenclawed-bench"));
export const RESULTS = path.resolve(nonEmpty(flag("--results")) ?? nonEmpty(process.env.BENCH_RESULTS) ?? path.join(HERE, "results"));
export const ROSTER_FILE = path.resolve(nonEmpty(flag("--roster")) ?? nonEmpty(process.env.BENCH_ROSTER) ?? path.join(WORK, "roster.json"));
export const SOCAT = (() => {
  const explicit = nonEmpty(flag("--socat")) ?? nonEmpty(process.env.BENCH_SOCAT);
  if (explicit) return path.resolve(explicit);
  const local = path.join(WORK, "socat-root", "usr", "bin", "socat");
  if (fs.existsSync(local)) return local;
  const r = spawnSync("sh", ["-c", "command -v socat"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : local;
})();

export const AUTH_MODES = ["subscription", "api-key", "credentials-file"];
/** The auth the person running the benchmark chose (flag, env, or the interactive prompt in run.mjs). */
export function resolveAuth(mode, credentialsPath) {
  if (!AUTH_MODES.includes(mode)) throw new Error(`--auth must be one of ${AUTH_MODES.join(", ")}`);
  if (mode === "subscription") {
    // Their own Claude login, as `claude` stores it; mounted read-only into the sandbox.
    return { mode, credentialsFile: path.join(os.homedir(), ".claude", ".credentials.json"), apiKey: null };
  }
  if (mode === "credentials-file") {
    if (!credentialsPath) throw new Error("--auth credentials-file needs --credentials <path>");
    return { mode, credentialsFile: path.resolve(credentialsPath), apiKey: null };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("--auth api-key needs ANTHROPIC_API_KEY in the environment");
  return { mode, credentialsFile: null, apiKey: key };
}
export const AUTH_FLAG = nonEmpty(flag("--auth")) ?? nonEmpty(process.env.BENCH_AUTH);
export const CREDENTIALS_FLAG = nonEmpty(flag("--credentials")) ?? nonEmpty(process.env.BENCH_CREDENTIALS);

/** Minutes left on an OAuth credentials file, or null (no file / no expiry, e.g. an API key). */
export function credentialsMinutesLeft(file) {
  if (!file) return null;
  try {
    const exp = JSON.parse(fs.readFileSync(file, "utf8"))?.claudeAiOauth?.expiresAt;
    return typeof exp === "number" ? (exp - Date.now()) / 60_000 : null;
  } catch {
    return null;
  }
}
