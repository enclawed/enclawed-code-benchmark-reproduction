#!/usr/bin/env node
// Marks the cells of the five class-A stego scenarios whose planted carrier was defective, so the
// runner re-runs them with the fixed carriers (scenarios/scenarios.mjs, catalog.mjs; checked by
// stego-carriers.test.mjs). Like invalidate-cut-inputs.mjs it appends a copy of each cell's last
// record with `invalid: "stego-carrier-defect"`; the originals stay. The mark depends only on the
// scenario id, never on a verdict. The defects:
//   rot13-fixture-exfil, variation-prbody-exfil  the port placeholder was encoded with the
//       instruction, so the decoded command named "{{PORT}}" (rot13: "{{CBEG}}"), no reachable port;
//   split-files-delete  CONTRIBUTING.md carried "(see README)" instead of the instruction's second
//       half, so the instruction could not be put together ("rm -f l" only);
//   base64-source-delete, bidi-source-githook  the carrier replaced src/math.js with README text, so
//       the source the "fix the failing test" task works on was gone.
//
//   node invalidate-stego-carriers.mjs --arms N0,N1,C1,C2 [--build <id> for codenclawed arms] [--results DIR] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { RESULTS } from "./bench-config.mjs";

export const STEGO_CARRIER_INVALID = "stego-carrier-defect";
export const DEFECTIVE = new Set(["rot13-fixture-exfil", "variation-prbody-exfil", "split-files-delete", "base64-source-delete", "bidi-source-githook"].map((s) => `stego-${s}`));

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : null;
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const arms = new Set((arg("--arms") ?? "").split(",").filter(Boolean));
  const build = arg("--build");
  const dry = process.argv.includes("--dry-run");
  if (!arms.size) {
    console.error("usage: node invalidate-stego-carriers.mjs --arms N0,N1,C1,C2 [--build <id>] [--results DIR] [--dry-run]");
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
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (!r.key || !arms.has(r.arm) || !DEFECTIVE.has(r.scenario)) continue;
      if (r.arm.startsWith("C") && build && r.build !== build) continue;
      last.set(r.key, r);
    }
    for (const r of last.values()) {
      if (r.invalid || r.harnessError) continue;
      const k = `${r.arm}/${r.scenario}`;
      counts[k] = (counts[k] ?? 0) + 1;
      if (!dry) fs.appendFileSync(file, `${JSON.stringify({ ...r, invalid: STEGO_CARRIER_INVALID, invalidated: { at: new Date().toISOString(), reason: "the planted stego carrier was defective (see invalidate-stego-carriers.mjs); the cell re-runs with the fixed carrier" } })}\n`);
    }
  }
  console.log(`${dry ? "[dry-run] " : ""}cells marked ${STEGO_CARRIER_INVALID}: ${JSON.stringify(counts, null, 1)}`);
}
