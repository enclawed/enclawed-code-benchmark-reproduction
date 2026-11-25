#!/usr/bin/env node
// Remove per-run working files once a run's result is recorded and valid.
//
//   node clean-runs.mjs --runs <work-dir>/bench-native/runs --results <dir> [--dry-run]
//
// Decided from the LAST record per cell in the results files (the same rule the runner uses):
//   valid, attack did not take effect  -> the whole run directory goes (the result line is the record)
//   valid, attack took effect          -> keep out/ (stream, logs) for hand-checking; drop the rest
//   invalid / harness error / infra    -> keep everything (diagnosis) until the cell re-runs validly
//   ANY record of the run names an "engine-error" gate decision -> keep the whole directory, always
//                                          (an Enclawed decision that threw: needed to reproduce it)
// Directories with no record yet (a run in flight) and directories touched in the last 15 minutes
// are never touched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A record that carries an Enclawed gate decision with code "engine-error" (anywhere in it). */
export function hasEngineError(r) {
  const decisions = r?.codenclawed?.decisions ?? [];
  if (decisions.some((d) => (d?.codes ?? []).includes("engine-error"))) return true;
  // Any other place a decision code can be recorded (hostc evidence, measure summaries, tails).
  return JSON.stringify(r ?? null).includes("engine-error");
}

/**
 * What to do with one run directory: "skip" | "keep" | "remove" | "trim". `records`: every record
 * naming the directory, in file order (the last one decides, except that an engine-error in any keeps it).
 */
export function cleanAction(records, { ageMs, minAgeMs = 15 * 60_000 }) {
  if (ageMs < minAgeMs) return "skip";
  const r = records.at(-1);
  if (!r) return "skip";
  if (records.some(hasEngineError)) return "keep";
  const valid = !r.invalid && !r.harnessError && !INFRA.has(r.errorClass);
  if (!valid) {
    // Invalidated for a known, already-understood reason (account content, a misclassified
    // usage limit) or an infrastructure stop: the cell re-runs in a new directory, so this one
    // carries nothing left to diagnose. Harness errors are kept for diagnosis.
    return !r.harnessError && (r.invalid || INFRA.has(r.errorClass)) ? "remove" : "keep";
  }
  // A hit: keep the evidence (out/), drop the working copy.
  return r.attackSucceeded ? "trim" : "remove";
}
const INFRA = new Set(["usage-limit", "auth", "api-transient"]);

function main() {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : dflt;
  };
  if (!arg("--runs") || !arg("--results")) {
    console.error("usage: node clean-runs.mjs --runs DIR --results DIR [--dry-run]");
    process.exit(2);
  }
  const RUNS = path.resolve(arg("--runs", ""));
  const RESULTS = path.resolve(arg("--results", ""));
  const DRY = process.argv.includes("--dry-run");

  // Every record per run directory, in file order.
  const byDir = new Map();
  for (const f of fs.readdirSync(RESULTS).filter((n) => n.endsWith(".jsonl") && !n.includes("events"))) {
    for (const line of fs.readFileSync(path.join(RESULTS, f), "utf8").split("\n")) {
      if (!line) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (!r.runDir) continue;
      const k = path.basename(r.runDir);
      if (!byDir.has(k)) byDir.set(k, []);
      byDir.get(k).push(r);
    }
  }

  const now = Date.now();
  const stats = { removed: 0, trimmed: 0, kept: 0, keptEngineError: 0, skipped: 0 };
  for (const name of fs.readdirSync(RUNS)) {
    const dir = path.join(RUNS, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      stats.skipped++;
      continue;
    }
    const records = byDir.get(name) ?? [];
    const action = cleanAction(records, { ageMs: now - st.mtimeMs });
    if (action === "skip") {
      stats.skipped++;
    } else if (action === "keep") {
      if (records.some(hasEngineError)) stats.keptEngineError++;
      else stats.kept++;
    } else if (action === "remove") {
      if (!DRY) fs.rmSync(dir, { recursive: true, force: true });
      stats.removed++;
    } else {
      for (const sub of fs.readdirSync(dir)) {
        if (sub === "out") continue;
        if (!DRY) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
      }
      stats.trimmed++;
    }
  }
  console.log(`${DRY ? "[dry-run] " : ""}${JSON.stringify(stats)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
