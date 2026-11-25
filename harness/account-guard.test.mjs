// Offline unit check of the benchmark's account-content hard guard (harness v4).
// No model, no sandbox, no network: it feeds stream lines shaped like the ones
// Claude Code 2.1.326 really emitted in v3 runs to the guard and checks the verdict.
//   node --test benchmarks/account-guard.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_SKILLS_INVALID, CONNECTOR_INVALID, accountSkillCall, accountSkillExposure, streamAccountExposure, syncedDirsExposure } from "./run.mjs";

const BUNDLED = ["deep-research", "design", "dataviz", "update-config", "code-review", "simplify", "run"];
const init = (extra = {}) => ({ type: "system", subtype: "init", tools: ["Bash", "Read", "Skill"], mcp_servers: [], skills: [...BUNDLED], slash_commands: [...BUNDLED, "compact"], plugins: [{ name: "cc-plugin-privacy", path: "builtin", source: "cc-plugin-privacy@builtin" }], ...extra });
const lines = (...ms) => ms.map((m) => JSON.stringify(m)).join("\n");
const toolUse = (name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input }] } });

test("a clean init with bundled skills and repo-planted project skills passes", () => {
  const m = init({ skills: [...BUNDLED, "format-code", "lint", "archive-data"] });
  assert.equal(accountSkillExposure(m), null);
  assert.equal(streamAccountExposure(lines(m, toolUse("Skill", { skill: "format-code" }), toolUse("Skill", { skill: "update-config" }))), null);
});

test("init listing an anthropic-skills:* skill is caught", () => {
  const m = init({ skills: [...BUNDLED, "anthropic-skills:docs", "anthropic-skills:pdf"] });
  assert.deepEqual(accountSkillExposure(m).skills, ["anthropic-skills:docs", "anthropic-skills:pdf"]);
  assert.equal(streamAccountExposure(lines(m)).invalid, ACCOUNT_SKILLS_INVALID);
});

test("init listing one only in slash_commands is caught", () => {
  assert.equal(streamAccountExposure(lines(init({ slash_commands: ["anthropic-skills:xlsx"] }))).invalid, ACCOUNT_SKILLS_INVALID);
});

test("a synced skill that lands after init (commands_changed) is caught", () => {
  const cc = { type: "system", subtype: "commands_changed", commands: [{ name: "deep-research", description: "bundled" }, { name: "docs", description: "docs (editable docs ...). (claude.ai sync)", argumentHint: "", aliases: ["anthropic-skills:docs"] }] };
  const x = streamAccountExposure(lines(init(), cc));
  assert.equal(x.invalid, ACCOUNT_SKILLS_INVALID);
  assert.deepEqual(x.detail.skills, ["anthropic-skills:docs"]);
  // The description marker alone is enough.
  assert.equal(accountSkillExposure({ type: "system", subtype: "commands_changed", commands: [{ name: "morning", description: "Brief. (claude.ai sync)" }] }).skills[0], "morning");
});

test("commands_changed with only bundled and project commands passes", () => {
  assert.equal(streamAccountExposure(lines(init(), { type: "system", subtype: "commands_changed", commands: [{ name: "lint", description: "Run the linter" }] })), null);
});

test("a synced plugin in init is caught", () => {
  assert.equal(accountSkillExposure(init({ plugins: [{ name: "x", path: "/home/u/.claude/plugins/synced/x", source: "x@claudeai" }] })).plugins.length, 1);
});

test("invoking an account skill is caught, prefixed or bare", () => {
  assert.equal(accountSkillCall({ name: "Skill", input: { skill: "anthropic-skills:docx" } }), "anthropic-skills:docx");
  assert.equal(accountSkillCall({ name: "Skill", input: { skill: "pptx" } }), "pptx");
  assert.equal(accountSkillCall({ name: "Skill", input: { skill: "format-code" } }), null);
  assert.equal(accountSkillCall({ name: "Bash", input: { command: "docs" } }), null);
  assert.equal(streamAccountExposure(lines(init(), toolUse("Skill", { skill: "anthropic-skills:docs" }))).invalid, ACCOUNT_SKILLS_INVALID);
});

test("claude.ai connectors are still caught (v3 guard kept)", () => {
  assert.equal(streamAccountExposure(lines(init({ mcp_servers: [{ name: "claude.ai Claude Docs", status: "connected", source: "claudeai" }] }))).invalid, CONNECTOR_INVALID);
  assert.equal(streamAccountExposure(lines(init(), toolUse("mcp__claude_ai_Claude_Docs__batch", {}))).invalid, CONNECTOR_INVALID);
});

test("a partial trailing line (live stream) does not throw or fire", () => {
  assert.equal(streamAccountExposure(`${JSON.stringify(init())}\n{"type":"system","subtype":"comm`), null);
});

test("anything synced into the sandbox HOME is caught", () => {
  assert.equal(syncedDirsExposure(""), null);
  assert.equal(syncedDirsExposure(".claude/skills\n.claude/skills/synced"), null);
  assert.equal(syncedDirsExposure(".claude/skills/synced\n.claude/skills/synced/docs/SKILL.md").syncedFiles.length, 1);
  assert.equal(syncedDirsExposure(".claude/plugins/synced/x/plugin.json").syncedFiles.length, 1);
});
