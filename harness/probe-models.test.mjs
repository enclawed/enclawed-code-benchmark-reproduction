// Offline unit check of the model-roster probe (probe-models.mjs).
// No model, no sandbox, no network: fake stream-json transcripts and a fake answered map.
//   node --test probe-models.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AUTH_PROMPT, buildRoster, modelMatches, parseStreamText, probeVerdict, writeRoster } from "./probe-models.mjs";
import { MODEL_ORDER, PIN_VERSION } from "./run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lines = (...ms) => ms.map((m) => JSON.stringify(m)).join("\n");
const init = { type: "system", subtype: "init", claude_code_version: "2.1.326", tools: ["Bash"], mcp_servers: [] };
const reply = (model, text = "OK") => ({ type: "assistant", message: { model, content: [{ type: "text", text }] } });
const ok = (text = "OK") => ({ type: "result", subtype: "success", is_error: false, result: text });

test("the auth prompt is word for word run.mjs's", () => {
  const src = fs.readFileSync(path.join(HERE, "run.mjs"), "utf8");
  for (const l of AUTH_PROMPT.trimEnd().split("\n")) assert.ok(src.includes(JSON.stringify(`${l}\n`).slice(1, -1)), `run.mjs no longer has: ${l}`);
  assert.match(PIN_VERSION, /^\d+\.\d+\.\d+$/);
});

test("parseStreamText takes init, result and the main-loop models; partial lines are skipped", () => {
  const p = parseStreamText(`${lines(init, reply("claude-haiku-4-5-20251001"), ok())}\n{"type":"assist`);
  assert.equal(p.init.claude_code_version, "2.1.326");
  assert.equal(p.result.subtype, "success");
  assert.deepEqual(p.assistantModels, ["claude-haiku-4-5-20251001"]);
});

test("modelMatches: the id itself or the id plus a date suffix, nothing else", () => {
  assert.ok(modelMatches("claude-haiku-4-5", "claude-haiku-4-5"));
  assert.ok(modelMatches("claude-haiku-4-5", ["claude-haiku-4-5-20251001"]));
  assert.ok(!modelMatches("claude-haiku-4-5", ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]));
  assert.ok(!modelMatches("claude-opus-4-7", "claude-opus-4-6"));
  assert.ok(!modelMatches("claude-opus-4", "claude-opus-4-6")); // a prefix is not a match
  assert.ok(!modelMatches("claude-haiku-4-5", []));
  assert.ok(!modelMatches("claude-haiku-4-5", null));
});

test("probeVerdict: served, substituted, error, usage limit, auth", () => {
  assert.equal(probeVerdict("claude-haiku-4-5", parseStreamText(lines(init, reply("claude-haiku-4-5-20251001"), ok()))).status, "served");
  const sub = probeVerdict("claude-opus-5-5", parseStreamText(lines(init, reply("claude-opus-4-7"), ok())));
  assert.deepEqual([sub.status, sub.answered], ["not-served", "claude-opus-4-7"]);
  const err = probeVerdict("claude-fable-5-2", parseStreamText(lines(init, { type: "result", subtype: "success", is_error: true, result: "model not found" })));
  assert.equal(err.status, "not-served");
  // Claude Code reports a usage limit as an ordinary synthetic reply: never "not served".
  const lim = probeVerdict("claude-sonnet-5-5", parseStreamText(lines(init, reply("<synthetic>", "You've hit your 5-hour limit · resets 3am"), ok("You've hit your 5-hour limit · resets 3am"))));
  assert.deepEqual([lim.status, lim.errorClass], ["not-probed", "usage-limit"]);
  assert.equal(probeVerdict("claude-haiku-4-5", parseStreamText(""), "Claude AI usage limit reached").status, "not-probed");
  assert.equal(probeVerdict("claude-haiku-4-5", parseStreamText(lines(init, { type: "result", subtype: "success", is_error: true, result: "OAuth token has expired" }))).status, "auth");
});

const fake = {
  "claude-fable-5-2": "claude-fable-5-2",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-opus-5-5": "claude-opus-4-7", // substituted: not served
  "claude-sonnet-4-6": null, // the call failed
};
const verdictsOf = (map) => Object.entries(map).map(([requested, answered]) => ({ requested, answered, served: Boolean(answered) && modelMatches(requested, answered), status: Boolean(answered) && modelMatches(requested, answered) ? "served" : "not-served" }));

test("buildRoster: served in MODEL_ORDER order, answered map, auth mode only", () => {
  const r = buildRoster({ verdicts: verdictsOf(fake), probedAt: Date.UTC(2026, 10, 22), claudeVersion: "2.1.326", pinVersion: "2.1.326", auth: "subscription" });
  assert.deepEqual(r.served, ["claude-haiku-4-5", "claude-fable-5-2"]);
  assert.deepEqual(Object.keys(r.answered), ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-5-5", "claude-fable-5-2"]);
  assert.equal(r.answered["claude-opus-5-5"], "claude-opus-4-7");
  assert.equal(r.answered["claude-sonnet-4-6"], null);
  assert.deepEqual([r.probedAt, r.claudeVersion, r.auth, r.notProbed], ["2026-11-22T00:00:00.000Z", "2.1.326", "subscription", undefined]);
  assert.ok(r.served.every((m) => MODEL_ORDER.includes(m)));
  assert.throws(() => buildRoster({ verdicts: [], auth: "sk-ant-oat01-secret" }), /auth must be one of/);
});

test("buildRoster: a usage-limited model keeps its earlier verdict and is listed in notProbed", () => {
  const previous = { served: ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-4-6"], answered: { "claude-haiku-4-5": "claude-haiku-4-5-20251001", "claude-sonnet-5-5": "claude-sonnet-5-5", "claude-opus-4-6": "claude-opus-4-6" } };
  const verdicts = [
    { requested: "claude-haiku-4-5", answered: "claude-haiku-4-5-20251001", served: true, status: "served" },
    { requested: "claude-sonnet-5-5", answered: null, served: false, status: "not-probed", errorClass: "usage-limit" },
    { requested: "claude-opus-5-5", answered: null, served: false, status: "not-probed", errorClass: "usage-limit" }, // no earlier verdict
  ];
  const r = buildRoster({ verdicts, claudeVersion: "2.1.326", pinVersion: "2.1.326", auth: "api-key", previous });
  // sonnet-5-5 not dropped; opus-5-5 not added unverified; opus-4-6 (not asked this time) kept.
  assert.deepEqual(r.served, ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-4-6"]);
  assert.deepEqual(r.notProbed, ["claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.equal(r.answered["claude-sonnet-5-5"], "claude-sonnet-5-5");
  assert.equal(r.answered["claude-opus-5-5"], null);
});

test("buildRoster drops secret-shaped answered values; writeRoster refuses credential-shaped data", () => {
  const r = buildRoster({ verdicts: [{ requested: "claude-haiku-4-5", answered: "someone@example.com", served: false, status: "not-served" }], auth: "subscription" });
  assert.equal(r.answered["claude-haiku-4-5"], null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-test-"));
  try {
    const file = path.join(dir, "sub", "roster.json");
    const text = writeRoster(file, buildRoster({ verdicts: verdictsOf(fake), claudeVersion: "2.1.326", pinVersion: "2.1.326", auth: "subscription" }));
    const back = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(back.served, ["claude-haiku-4-5", "claude-fable-5-2"]);
    assert.deepEqual(Object.keys(back).sort(), ["answered", "auth", "claudeVersion", "pinVersion", "probedAt", "served"]);
    assert.doesNotMatch(text, /sk-ant-|accessToken|refreshToken|@/);
    assert.throws(() => writeRoster(path.join(dir, "bad.json"), { served: [], accessToken: "x" }), /credential-shaped/);
    assert.throws(() => writeRoster(path.join(dir, "bad2.json"), { served: [], note: "sk-ant-oat01-abc" }), /credential-shaped/);
    assert.ok(!fs.existsSync(path.join(dir, "bad.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
