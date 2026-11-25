// Offline check: a record keeps Claude Code's tool_use ids on its tool calls, the gate's decisions and
// the denials, so each decision pairs 1:1 with its call, also for parallel calls in ONE assistant message
// (papers/codenclawed-arxiv/scripts/call-truth.mjs). No claude, no model, no sandbox.
//   node --test call-ids.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deniedCalls, parseTranscript } from "./person.mjs";
import { parseStream, recordDecisions, recordDenials, recordToolUses } from "./run.mjs";

// One assistant message, two parallel calls with the same tool name and different inputs.
const calls = [
  { type: "tool_use", id: "toolu_A", name: "Bash", input: { command: "node --test" } },
  { type: "tool_use", id: "toolu_B", name: "Bash", input: { command: "rm -f local.db" } },
];
// The gate decides them in the other order (hooks run concurrently).
const audit = [
  { type: "claude-code.tool.pre", payload: { tool: "Bash", toolUseId: "toolu_B", decision: "deny", codes: ["shell"] } },
  { type: "claude-code.tool.pre", payload: { tool: "Bash", toolUseId: "toolu_A", decision: "allow", codes: ["read-only-command"] } },
];
const pair = (rec) => rec.decisions.map((d) => [d.toolUseId, JSON.parse(rec.toolUses.find((u) => u.id === d.toolUseId).input).command, d.decision]);

test("-p stream (every non-person arm): calls, decisions and denials carry matching ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "call-ids-"));
  const f = path.join(dir, "stream.jsonl");
  const denial = { tool_name: "Bash", tool_use_id: "toolu_B", tool_input: { command: "rm -f local.db" } };
  fs.writeFileSync(f, [{ type: "system", subtype: "init" }, { type: "assistant", message: { model: "m", content: calls } }, { type: "result", permission_denials: [denial] }].map((m) => JSON.stringify(m)).join("\n"));
  const p = parseStream(f);
  const rec = { toolUses: recordToolUses(p.toolUses), decisions: recordDecisions(audit), permissionDenials: recordDenials(p.result.permission_denials) };
  assert.deepEqual(rec.toolUses.map((u) => u.id), ["toolu_A", "toolu_B"]);
  assert.deepEqual(pair(rec), [["toolu_B", "rm -f local.db", "deny"], ["toolu_A", "node --test", "allow"]]);
  assert.deepEqual(rec.permissionDenials.map((d) => d.toolUseId), ["toolu_B"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("C1A transcript: the same ids, and the denials from the audit keep them", () => {
  const entries = [
    { type: "user", isSidechain: false, version: "2.1.326", message: { content: "task" } },
    { type: "assistant", isSidechain: false, message: { id: "m1", model: "m", stop_reason: "tool_use", content: calls } },
  ];
  const p = parseTranscript(entries, { task: "task", ended: false });
  const rec = { toolUses: recordToolUses(p.toolUses), decisions: recordDecisions(audit), permissionDenials: recordDenials(deniedCalls(audit, p.toolUses)) };
  assert.deepEqual(pair(rec), [["toolu_B", "rm -f local.db", "deny"], ["toolu_A", "node --test", "allow"]]);
  assert.deepEqual(rec.permissionDenials, [{ toolUseId: "toolu_B", tool: "Bash", input: JSON.stringify({ command: "rm -f local.db" }) }]);
});

test("a decision with no id stays unpaired (null), never guessed", () => {
  assert.equal(recordDecisions([{ type: "claude-code.tool.pre", payload: { tool: "Bash", decision: "ask" } }])[0].toolUseId, null);
});

test("the whole input of every call is recorded, never cut", () => {
  const body = "x".repeat(5000);
  const [u] = recordToolUses([{ id: "t1", name: "Write", input: { file_path: "a.js", content: body } }]);
  assert.equal(JSON.parse(u.input).content.length, 5000);
  const [d] = recordDenials([{ tool_use_id: "t1", tool_name: "Write", tool_input: { file_path: "a.js", content: body } }]);
  assert.equal(JSON.parse(d.input).content.length, 5000);
});
