#!/usr/bin/env node
// Marks every recorded run whose stream showed claude.ai account-synced
// content (skills in the anthropic-skills:* namespace or "(claude.ai sync)"
// commands, synced plugins, or a call to one) as
// invalid: "claudeai-account-skills-listed". Like invalidate-connector.mjs it
// appends a copy of the cell's last record with `invalid` set (the originals
// stay; the last row for a key wins), so summaries exclude the cell and the
// runner runs it again under harness v4.
// No model is called. Evidence: the run's out/stream.jsonl on disk, checked by
// the same guard the runner uses (streamAccountExposure in run.mjs). A run with
// no session (no init) saw nothing and is kept.
//   node benchmarks/invalidate-account-skills.mjs [--dry-run] <results.jsonl>...
import fs from "node:fs";
import path from "node:path";
import { ACCOUNT_SKILLS_INVALID, streamAccountExposure } from "./run.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const files = args.filter((a) => a !== "--dry-run");
if (!files.length) {
  process.stderr.write("usage: invalidate-account-skills.mjs [--dry-run] <results.jsonl>...\n");
  process.exit(2);
}
for (const file of files) {
  const last = new Map();
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const r = JSON.parse(l);
      if (r.key && r.scenario) last.set(r.key, r);
    } catch {
      /* skip */
    }
  }
  const tally = { invalidated: 0, atInit: 0, afterInit: 0, invoked: 0, kept: 0, noSession: 0, noStream: 0, alreadyInvalid: 0, harnessError: 0, byHarness: {} };
  for (const r of last.values()) {
    if (r.invalid) {
      tally.alreadyInvalid++;
      continue;
    }
    if (r.harnessError) {
      tally.harnessError++;
      continue;
    }
    let text = null;
    try {
      text = fs.readFileSync(path.join(r.runDir, "out", "stream.jsonl"), "utf8");
    } catch {
      /* gone */
    }
    if (text === null) {
      tally.noStream++;
      continue;
    }
    if (!text.includes('"init"')) {
      tally.noSession++;
      continue;
    }
    const x = streamAccountExposure(text);
    if (!x || x.invalid !== ACCOUNT_SKILLS_INVALID) {
      tally.kept++;
      continue;
    }
    if (x.detail.calledSkill) tally.invoked++;
    else if (x.detail.where === "init") tally.atInit++;
    else tally.afterInit++;
    const h = r.harness ?? "v1";
    tally.byHarness[h] = (tally.byHarness[h] ?? 0) + 1;
    tally.invalidated++;
    if (!dry) fs.appendFileSync(file, `${JSON.stringify({ ...r, invalid: ACCOUNT_SKILLS_INVALID, invalidated: { at: new Date().toISOString(), evidence: "stream", exposure: x.detail } })}\n`);
  }
  process.stdout.write(`${file}${dry ? " (dry run)" : ""}: ${JSON.stringify(tally)}\n`);
}
