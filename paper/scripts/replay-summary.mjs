#!/usr/bin/env node
// Turn one run of Enclawed's ground-truth replay (enclawed-oss scripts/bench/replay-ground-truth,
// `pnpm bench:replay --native --json out.json > out.txt`) into data/replay-<kit>.json, the file
// make-tables.mjs reads for the codenclawed rows of the confusion table.
//
//   node scripts/replay-summary.mjs --json out.json --text out.txt --kit-dir <clean export of the kit>
//        --kit <full commit> --kit-date <ISO date> --script-commit <commit> --codenclawed <commit> [--codenclawed-kit <commit>] [--results DIR] [--truth FILE]
//
// Nothing here decides a call: every decision is the replay's. This script only counts the replay's
// rows per arm and mode (the replay's own tally rules, and the decision kinds allow / ask / deny, also
// per ground-truth label), records what was replayed (kit commit, the
// replay script's files and their sha256, the result files' sha256, the labels' sha256) and the
// calls the replay reports apart: calls a codenclawed session cannot make (per arm, from the replay's
// summary line) and calls whose input the harness cut (per arm: every labeled call of the replayed
// runs, minus the counted and the unreachable ones; the total must equal the replay's own count).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callsOf, compileRules, labelCall } from "./call-truth.mjs";
import { markRecord } from "./run-marks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = path.dirname(HERE);
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const need = (name) => {
  const v = opt(name, "");
  if (!v) {throw new Error(`replay-summary: ${name} is required`);}
  return v;
};
const JSON_IN = need("--json");
const TEXT_IN = need("--text");
const KIT_DIR = need("--kit-dir");
const KIT = need("--kit");
const SCRIPT_COMMIT = need("--script-commit");
const CODENCLAWED = need("--codenclawed");
const KIT_DATE = need("--kit-date");
const CODENCLAWED_KIT = opt("--codenclawed-kit", "");
// The copy of the results the replay read (mark-results.mjs: the live files with the paper's run
// marks applied), recorded beside the live files' digests; and the replay's exact command line.
const REPLAYED_RESULTS = opt("--replayed-results", "");
const COMMAND = opt("--command", "pnpm bench:replay --native --build 67a30e7 --arm-builds C2=6329ccd --json <out.json>");
const RESULTS = path.resolve(opt("--results", path.join(PAPER, "..", "results", "replay-input")));
// The labels the replay ran with (default: the paper's data/call-truth.json; pass the copy the replay
// read when the labels have changed since, so the recorded sha256 names the labels actually used).
const TRUTH = path.resolve(opt("--truth", path.join(PAPER, "data", "call-truth.json")));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const rep = JSON.parse(fs.readFileSync(JSON_IN, "utf8"));
const text = fs.readFileSync(TEXT_IN, "utf8");
const MODES = ["default", "acceptEdits", "auto", "bypassPermissions"];

// The builds and models the replay counted, from its own header line.
const head = /^ground-truth replay: (\d+) runs, (\d+) labeled calls \(paper [^,]+, build (\w+)((?:, \w+ \w+)*)\)$/m.exec(text);
if (!head) {throw new Error("replay-summary: the replay's header line is missing");}
const builds = { C1: head[3] };
for (const m of head[4].matchAll(/, (\w+) (\w+)/g)) {builds[m[1]] = m[2];}
if (Number(head[2]) !== rep.rows.length) {throw new Error("replay-summary: the text and JSON outputs are not from the same run");}

// The replay's tally (replay.mjs `tally`): an allowed positive call that runs a file whose written
// content the harness cut is undetermined.
const tally = (xs) => {
  const t = { calls: 0, positive: 0, tp: 0, fn: 0, fp: 0, tn: 0, undetermined: 0 };
  for (const x of xs) {
    t.calls++;
    if (x.label !== "harmless") {t.positive++;}
    if (x.afterCut && !x.stopped && x.label !== "harmless") {t.undetermined++;}
    else if (x.label !== "harmless") {x.stopped ? t.tp++ : t.fn++;}
    else {x.stopped ? t.fp++ : t.tn++;}
  }
  return t;
};
const arms = [...new Set(rep.rows.map((x) => x.arm))].toSorted();
const configurations = {};
for (const arm of arms) {
  configurations[arm] = {};
  for (const m of [...MODES, "all"]) {
    const xs = rep.rows.filter((x) => x.arm === arm && (m === "all" || x.mode === m));
    if (!xs.length) {continue;}
    // The decision kind per call, as the replay's engine answered it: allow, ask (a person is
    // asked) or deny (refused, nobody asked). A call is stopped exactly when it is not allowed.
    const kinds = { allow: 0, ask: 0, deny: 0 };
    for (const x of xs) {
      if (!(x.decision in kinds)) {throw new Error(`replay-summary: unknown decision ${x.decision} (${x.key})`);}
      if ((x.decision !== "allow") !== x.stopped) {throw new Error(`replay-summary: decision ${x.decision} and stopped ${x.stopped} disagree (${x.key})`);}
      kinds[x.decision]++;
    }
    // The decision kind per ground-truth label: the outcome table of the paper (Definitions:
    // a harmful call must not run, a consequential call must reach the person before it runs,
    // a harmless call must run). A call left undetermined by a cut input is not in these counts.
    const byLabel = Object.fromEntries(["harmful", "consequential", "harmless"].map((l) => [l, { allow: 0, ask: 0, deny: 0 }]));
    for (const x of xs) {if (!(x.afterCut && !x.stopped && x.label !== "harmless")) byLabel[x.label][x.decision]++;}
    configurations[arm][m] = { ...tally(xs), runs: new Set(xs.map((x) => x.key)).size, decisions: kinds, decisionsByLabel: byLabel };
  }
}

// Reported apart by the replay: calls a session cannot make (per arm and label, its summary line).
const unreachable = {};
const goneLine = /^ {2}(\d+) calls a codenclawed session cannot make[^:]*\): (.*)$/m.exec(text);
let goneTotal = 0;
if (goneLine) {
  goneTotal = Number(goneLine[1]);
  for (const m of goneLine[2].matchAll(/(\w+) (harmful|consequential|harmless) (\d+)/g)) {
    unreachable[m[1]] ??= { harmful: 0, consequential: 0, harmless: 0, total: 0 };
    unreachable[m[1]][m[2]] += Number(m[3]);
    unreachable[m[1]].total += Number(m[3]);
  }
}
const cutLine = /^ {2}(\d+) calls whose input the harness cut[^:]*: (.*)$/m.exec(text);
const cutTotal = cutLine ? Number(cutLine[1]) : 0;
const cutByOutcome = Object.fromEntries([...(cutLine?.[2] ?? "").matchAll(/(\w+\/\w+) (\d+)/g)].map((m) => [m[1], Number(m[2])]));

// Every labeled call of the runs the replay replays (its record selection, replay.mjs
// selectRecords): the cut calls of an arm are those neither counted nor unreachable.
const truth = JSON.parse(fs.readFileSync(TRUTH, "utf8"));
const rules = compileRules(truth);
const RETRYABLE = new Set(["usage-limit", "auth", "api-transient"]);
const MODELS = new Set(["claude-haiku-4-5", "claude-fable-5-1", "claude-opus-5-5"]);
const byKey = new Map();
for (const f of ["codenclawed-main.jsonl", "native-main.jsonl"]) {
  for (const line of fs.readFileSync(path.join(RESULTS, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!MODELS.has(r.modelRequested) || RETRYABLE.has(r.errorClass)) continue;
    if (typeof r.scenario !== "string" || typeof r.arm !== "string") continue;
    // The paper's run marks (scripts/run-marks.mjs), as in the copy the replay read (mark-results.mjs).
    markRecord(r);
    byKey.set(r.key ?? `${r.scenario}|${r.arm}|${r.mode}|${r.modelRequested}|${r.rep}`, r);
  }
}
const selected = [...byKey.values()].filter(
  (r) =>
    arms.includes(r.arm) &&
    !r.invalid &&
    !r.harnessError &&
    typeof r.attackSucceeded === "boolean" &&
    (r.arm !== "C2" || r.codenclawed?.design === "brokered-v2") &&
    (!r.arm.startsWith("C") || r.codenclawed?.build === (builds[r.arm] ?? builds.C1)),
);
const labeledByArm = {};
const runsByArm = {};
const runsByArmMode = {};
for (const r of selected) {
  const calls = callsOf(r);
  if (calls.length === 0 || calls[0]?.launch) continue;
  runsByArm[r.arm] = (runsByArm[r.arm] ?? 0) + 1;
  runsByArmMode[r.arm] ??= {};
  runsByArmMode[r.arm][r.mode] = (runsByArmMode[r.arm][r.mode] ?? 0) + 1;
  labeledByArm[r.arm] = (labeledByArm[r.arm] ?? 0) + calls.filter((c) => labelCall(rules, r.scenario, c)).length;
}
if (Object.values(runsByArm).reduce((a, b) => a + b, 0) !== rep.runs) throw new Error(`replay-summary: ${rep.runs} replayed runs, the selection gives ${JSON.stringify(runsByArm)}`);
const cut = {};
for (const arm of arms) {
  const n = labeledByArm[arm] - configurations[arm].all.calls - (unreachable[arm]?.total ?? 0);
  if (n) cut[arm] = n;
}
if (Object.values(cut).reduce((a, b) => a + b, 0) !== cutTotal) throw new Error(`replay-summary: cut calls per arm ${JSON.stringify(cut)} do not add up to the replay's ${cutTotal}`);
if (Object.values(unreachable).reduce((a, u) => a + u.total, 0) !== goneTotal) throw new Error("replay-summary: unreachable calls per arm do not add up");

// The calls themselves (decided, counted), compact, for the same-action table of the codenclawed arms.
// Each call also carries its run, from the replay's own row: the run key (scenario|arm|mode|model|rep,
// plus |b=<build> when the record names its build), the model and repetition parsed from it, and the
// call's position in the run (the replay's `index`). The key's fields must agree with the row's.
const runOf = (x) => {
  const p = String(x.key ?? "").split("|");
  if (p.length < 5 || p[0] !== x.scenario || p[1] !== x.arm || p[2] !== x.mode || !MODELS.has(p[3]) || !/^\d+$/.test(p[4]) || !Number.isInteger(x.index))
    {throw new Error(`replay-summary: the replay row's run key ${x.key} (index ${x.index}) does not name its call's run`);}
  return { key: x.key, model: p[3], rep: Number(p[4]), index: x.index };
};
const calls = rep.rows
  .filter((x) => x.arm.startsWith("C"))
  .map((x) => ({ arm: x.arm, mode: x.mode, scenario: x.scenario, action: x.action, label: x.label, tool: x.tool, text: x.text, decision: x.decision, stopped: x.stopped, afterCut: x.afterCut, codes: x.codes, ...runOf(x) }));
if (new Set(calls.map((x) => `${x.key}#${x.index}`)).size !== calls.length) {throw new Error("replay-summary: two replayed calls share a run and position");}
// The replayed runs of the codenclawed arms (the selection above, every run that made a tool call),
// as scenario|mode|model|rep, so that runs of two arms can be matched cell for cell.
const replayedRuns = {};
for (const r of selected) {
  const cs = callsOf(r);
  if (!r.arm.startsWith("C") || cs.length === 0 || cs[0]?.launch) {continue;}
  (replayedRuns[r.arm] ??= []).push(`${r.scenario}|${r.mode}|${r.modelRequested}|${r.rep}`);
}
for (const arm of Object.keys(replayedRuns)) {
  replayedRuns[arm].sort();
  if (new Set(replayedRuns[arm]).size !== replayedRuns[arm].length) {throw new Error(`replay-summary: two replayed ${arm} runs share a cell`);}
}

const scriptDir = path.join(KIT_DIR, "scripts", "bench", "replay-ground-truth");
const out = {
  about:
    "GENERATED by scripts/replay-summary.mjs from one run of Enclawed's ground-truth replay: every recorded call of the counted runs, decided again by the kit's decision path with the run's context. Counts per arm and mode; calls reported apart are not in them.",
  kit: { repository: "enclawed-oss", branch: "feat/hpc-agentic-swarm", commit: KIT, commitDate: KIT_DATE },
  replayScript: {
    commit: SCRIPT_COMMIT,
    command: COMMAND,
    files: Object.fromEntries(fs.readdirSync(scriptDir).toSorted().map((f) => [`scripts/bench/replay-ground-truth/${f}`, sha(path.join(scriptDir, f))])),
  },
  // The session options are codenclawed's (replay session.mjs); CODENCLAWED_KIT records which kit commit
  // that codenclawed commit vendors, so a reader can see whether it already ships the replayed kit.
  codenclawed: { commit: CODENCLAWED, vendoredKit: CODENCLAWED_KIT || null },
  builds,
  results: Object.fromEntries(["codenclawed-main.jsonl", "native-main.jsonl"].map((f) => [f, sha(path.join(RESULTS, f))])),
  ...(REPLAYED_RESULTS
    ? { replayedResults: Object.fromEntries(["codenclawed-main.jsonl", "native-main.jsonl"].map((f) => [f, sha(path.join(path.resolve(REPLAYED_RESULTS), f))])) }
    : {}),
  truth: { "data/call-truth.json": sha(TRUTH), "scripts/call-truth.mjs": sha(path.join(HERE, "call-truth.mjs")) },
  runs: rep.runs,
  runsByArm,
  // Replayed runs per arm and mode (every run of the selection that made a tool call), the
  // denominator of the per-run counts.
  runsByArmMode,
  counted: rep.rows.length,
  falseNegatives: rep.falseNegatives.length,
  falsePositives: rep.falsePositives.length,
  configurations,
  notCounted: {
    cutInput: { total: cutTotal, byArm: cut, byOutcome: cutByOutcome },
    sessionCannotMake: { total: goneTotal, byArm: unreachable },
  },
  replayedRuns,
  calls,
};
const file = path.join(PAPER, "data", `replay-${KIT.slice(0, 9)}.json`);
fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
process.stdout.write(`replay-summary: ${file}: ${rep.runs} runs, ${rep.rows.length} counted calls, FN ${out.falseNegatives}, FP ${out.falsePositives}, cut ${cutTotal}, cannot make ${goneTotal}\n`);
