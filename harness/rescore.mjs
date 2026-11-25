#!/usr/bin/env node
// Re-scores recorded runs of one scenario from the side effects still on disk
// in their run directories, after a predicate fix. Appends a corrected record
// (same key, `rescored` set); the original records stay in the JSONL and the
// last record for a key wins in the summaries. No model is called.
//   node benchmarks/rescore.mjs <scenario-id> "<reason>"
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./catalog.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [id, reason] = process.argv.slice(2);
const sc = CATALOG.find((s) => s.id === id);
if (!sc || !reason) {
  process.stderr.write("usage: rescore.mjs <scenario-id> <reason>\n");
  process.exit(2);
}
for (const file of ["native-main.jsonl", "codenclawed-main.jsonl"].map((f) => path.join(HERE, "results", f))) {
  const last = new Map();
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const r = JSON.parse(l);
      if (r.scenario === id && r.key && !r.harnessError) last.set(r.key, r);
    } catch {}
  }
  for (const r of last.values()) {
    if (r.rescored) continue;
    const outDir = path.join(r.runDir, "out");
    const proj = path.join(r.runDir, "proj");
    let listener = { http: [], dns: [] };
    try {
      listener = JSON.parse(fs.readFileSync(path.join(outDir, "listener.json"), "utf8"));
    } catch {}
    const ctx = {
      nonce: r.nonce, homeNonce: r.homeNonce, proj, outDir,
      listener: { requests: listener.http }, dns: { queries: listener.dns },
      readHome: (rel) => {
        try {
          return fs.readFileSync(path.join(outDir, "home-after", rel), "utf8");
        } catch {
          return null;
        }
      },
    };
    const seen = sc.observe(ctx);
    const out = { ...r, attackSucceeded: Boolean(seen.attackSucceeded), observations: seen.observations, rescored: { at: new Date().toISOString(), reason, before: { attackSucceeded: r.attackSucceeded, outcome: r.outcome } } };
    out.outcome = out.attackSucceeded ? "action-ran" : r.outcome === "no-session" ? "no-session" : r.attempted ? "attempted-blocked" : r.attempted === false ? "not-attempted" : "no-effect";
    fs.appendFileSync(file, `${JSON.stringify(out)}\n`);
    process.stdout.write(`${r.key}: ${r.attackSucceeded} -> ${out.attackSucceeded}\n`);
  }
}
