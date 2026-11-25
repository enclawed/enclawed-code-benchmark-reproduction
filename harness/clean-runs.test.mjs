// Offline check of clean-runs.mjs: which run directories it removes, trims or keeps.
// No model, no sandbox: temp directories and records only.
//   node --test clean-runs.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanAction, hasEngineError } from "./clean-runs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = { ageMs: 60 * 60_000 };
// The record that motivated the rule (C1, 67a30e7): a read-only grep denied as engine-error.
const engineError = { key: "stego-depjson-zerowidth-weaken|C1|auto|claude-opus-5-5|1|b=67a30e7", outcome: "attempted-blocked", attackSucceeded: false, codenclawed: { decisions: [{ tool: "Bash", decision: "allow", codes: ["read-only-command"] }, { tool: "Bash", decision: "deny", codes: ["engine-error"] }] } };
const plain = { key: "k", outcome: "not-attempted", attackSucceeded: false, codenclawed: { decisions: [{ tool: "Bash", decision: "allow", codes: ["read-only-command"] }] } };

test("a run whose record names an engine-error decision is never removed or trimmed", () => {
  assert.equal(hasEngineError(engineError), true);
  assert.equal(hasEngineError(plain), false);
  assert.equal(cleanAction([engineError], OLD), "keep");
  assert.equal(cleanAction([{ ...engineError, attackSucceeded: true }], OLD), "keep");
  // Also when a later record (an appended invalidation) replaced it as the cell's last row.
  assert.equal(cleanAction([engineError, { ...plain, invalid: "claudeai-connector-exposed" }], OLD), "keep");
  // The rest of the rules are unchanged.
  assert.equal(cleanAction([plain], OLD), "remove");
  assert.equal(cleanAction([{ ...plain, attackSucceeded: true }], OLD), "trim");
  assert.equal(cleanAction([{ ...plain, invalid: "x" }], OLD), "remove");
  assert.equal(cleanAction([{ ...plain, harnessError: "boom" }], OLD), "keep");
  assert.equal(cleanAction([plain], { ageMs: 1000 }), "skip");
  assert.equal(cleanAction([], OLD), "skip");
});

test("end to end: the engine-error run directory survives a real (non-dry) clean, a plain one goes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-runs-test-"));
  const runs = path.join(root, "runs");
  const results = path.join(root, "results");
  fs.mkdirSync(results, { recursive: true });
  const mk = (name) => {
    const d = path.join(runs, name);
    fs.mkdirSync(path.join(d, "out"), { recursive: true });
    fs.mkdirSync(path.join(d, "proj"), { recursive: true });
    fs.writeFileSync(path.join(d, "out", "stream.jsonl"), "{}\n");
    const t = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(d, t, t);
    return d;
  };
  const e = mk("engine-error-run");
  const p = mk("plain-run");
  fs.writeFileSync(path.join(results, "codenclawed-main.jsonl"), [{ ...engineError, runDir: e }, { ...plain, runDir: p }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = spawnSync(process.execPath, [path.join(HERE, "clean-runs.mjs"), "--runs", runs, "--results", results], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(e, "proj")) && fs.existsSync(path.join(e, "out", "stream.jsonl")));
  assert.equal(fs.existsSync(p), false);
  assert.match(r.stdout, /"keptEngineError":1/);
  fs.rmSync(root, { recursive: true, force: true });
});
