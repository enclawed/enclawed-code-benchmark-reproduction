#!/usr/bin/env node
// Marks the cells whose last record holds a tool-call input the harness cut (recordToolUses kept
// only 500 characters, recordDenials 300, until the whole input was recorded). A cut input cannot
// be judged by the ground truth, so the cell is re-run with the whole input. Like
// invalidate-connector.mjs it appends a copy of the cell's last record with
// `invalid: "input-cut-by-harness"`; the originals stay, and the runner re-runs the cell. The mark
// depends only on the recorded input's length, never on the verdict.
//
//   node invalidate-cut-inputs.mjs --arms N0,N1,C2 [--build <id> for codenclawed arms] [--results DIR] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { RESULTS } from "./bench-config.mjs";

export const CUT_INPUT_INVALID = "input-cut-by-harness";
const TOOL_CUT = 500;
const DENIAL_CUT = 300;

/** True when the record holds an input at (or over) the old cut length: it may have been cut. */
export const hasCutInput = (r) =>
  (r.toolUses ?? []).some((u) => String(u.input ?? "").length >= TOOL_CUT) ||
  (r.permissionDenials ?? []).some((d) => String(d.input ?? "").length >= DENIAL_CUT);

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : null;
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const arms = new Set((arg("--arms") ?? "").split(",").filter(Boolean));
  const build = arg("--build");
  const dry = process.argv.includes("--dry-run");
  if (!arms.size) {
    console.error("usage: node invalidate-cut-inputs.mjs --arms N0,N1,C2 [--build <id>] [--results DIR] [--dry-run]");
    process.exit(2);
  }
  const dir = arg("--results") ?? RESULTS;
  const counts = {};
  for (const f of ["native-main.jsonl", "codenclawed-main.jsonl"]) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue;
    const last = new Map();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line);
      if (!r.key || !arms.has(r.arm)) continue;
      if (r.arm.startsWith("C") && build && r.build !== build) continue;
      last.set(r.key, r);
    }
    for (const r of last.values()) {
      if (r.invalid || r.harnessError || !hasCutInput(r)) continue;
      counts[r.arm] = (counts[r.arm] ?? 0) + 1;
      if (!dry) fs.appendFileSync(file, `${JSON.stringify({ ...r, invalid: CUT_INPUT_INVALID, invalidated: { at: new Date().toISOString(), reason: "a tool-call input was cut by the harness (500/300 characters); the cell re-runs with the whole input recorded" } })}\n`);
    }
  }
  console.log(`${dry ? "[dry-run] " : ""}cells marked ${CUT_INPUT_INVALID}: ${JSON.stringify(counts)}`);
}
