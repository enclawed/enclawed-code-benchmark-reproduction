#!/usr/bin/env node
// Marks every recorded run whose session init listed a claude.ai account
// connector (tool mcp__claude_ai_* or an MCP server with source "claudeai") as
// invalid: "claudeai-connector-exposed". It appends a copy of the cell's last
// record with `invalid` set (the original rows stay; the last row for a key
// wins), so summaries exclude the cell and the runner runs it again.
// No model is called. Evidence per record: the recorded mcpServers, else the
// init line of the run's stream.jsonl on disk. A run with no session (no init:
// launch refused or crashed before claude started) exposed nothing and is kept.
//   node benchmarks/invalidate-connector.mjs <results.jsonl>...
import fs from "node:fs";
import path from "node:path";
import { CONNECTOR_INVALID, connectorExposure } from "./run.mjs";

const files = process.argv.slice(2);
if (!files.length) {
  process.stderr.write("usage: invalidate-connector.mjs <results.jsonl>...\n");
  process.exit(2);
}
const initOf = (runDir) => {
  try {
    for (const l of fs.readFileSync(path.join(runDir, "out", "stream.jsonl"), "utf8").split("\n")) {
      if (!l.includes('"init"')) continue;
      const m = JSON.parse(l);
      if (m.type === "system" && m.subtype === "init") return m;
    }
  } catch {
    /* gone */
  }
  return null;
};
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
  const tally = { exposed: 0, kept: 0, alreadyInvalid: 0, unknownKept: 0 };
  for (const r of last.values()) {
    if (r.invalid) {
      tally.alreadyInvalid++;
      continue;
    }
    if (r.harnessError) continue;
    let evidence = null;
    if (Array.isArray(r.mcpServers)) evidence = { source: "record.mcpServers", x: connectorExposure({ mcp_servers: r.mcpServers }) };
    const init = r.runDir ? initOf(r.runDir) : null;
    if (init) evidence = { source: "stream init", x: connectorExposure(init) ?? evidence?.x ?? null };
    if (!evidence) {
      // No init on record or on disk: no session ever started, so nothing was exposed.
      tally.unknownKept++;
      continue;
    }
    if (!evidence.x) {
      tally.kept++;
      continue;
    }
    fs.appendFileSync(file, `${JSON.stringify({ ...r, invalid: CONNECTOR_INVALID, invalidated: { at: new Date().toISOString(), evidence: evidence.source, exposure: evidence.x } })}\n`);
    tally.exposed++;
  }
  process.stdout.write(`${file}: ${JSON.stringify(tally)}\n`);
}
