// C1A ("C1-approve"): reading what the stand-in person (scripts/yes-person.py) saw and did, and what
// Claude Code's own transcript says the session did, into the same record fields a C1 run gets from
// Claude Code's -p stream (init, result, tool calls). An interactive session has no stream-json: the
// transcript Claude Code writes (~/.claude/projects/<project>/<session>.jsonl, copied out of the sandbox
// to out/transcripts) is the one record of the session, and its `cost-state` line carries what the -p
// result carries (total cost, per-model usage).
import fs from "node:fs";
import path from "node:path";

const readLines = (file) => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return []; // a torn line
        }
      });
  } catch {
    return [];
  }
};

/** Every transcript line under `dir` (session file first, then sub-agent files), in file order. */
export function transcriptEntries(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
  // The main session file holds non-sidechain user entries; sub-agent files only sidechain ones.
  const main = (es) => es.some((e) => e.type === "user" && !e.isSidechain);
  const parsed = files.map((f) => ({ f, es: readLines(f) }));
  parsed.sort((a, b) => Number(main(b.es)) - Number(main(a.es)) || a.f.localeCompare(b.f));
  return parsed.flatMap((p) => p.es);
}

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("") : "");

/**
 * The transcript in the shape run.mjs's parseStream gives for a -p stream: { toolUses, result, init,
 * assistantModels, rateLimitEvents, types, toolsOffered, taskDelivered }. `init` is non-null only when the
 * session really started (Claude Code wrote the task as the first user message). `ended`: the person
 * ended the session after the model's turn ended (otherwise there is no result, as for a -p run killed
 * at its time limit).
 */
export function parseTranscript(entries, { task, ended }) {
  const toolUses = [];
  const assistantModels = new Set();
  const types = {};
  const ids = new Set();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let firstUser = null;
  let version = null;
  let cost = null;
  let toolsOffered = null;
  let lastAssistant = null;
  for (const e of entries) {
    types[e.type] = (types[e.type] ?? 0) + 1;
    if (!version && typeof e.version === "string") version = e.version;
    if (e.type === "cost-state") cost = e;
    if (e.type === "api-request-shape" && !toolsOffered && Array.isArray(e.shape?.tools)) toolsOffered = e.shape.tools.map((t) => t?.name).filter(Boolean);
    if (e.type === "user" && !e.isSidechain && !firstUser && textOf(e.message?.content).trim()) firstUser = e;
    if (e.type !== "assistant") continue;
    const m = e.message ?? {};
    if (m.model) assistantModels.add(m.model);
    for (const c of m.content ?? []) if (c?.type === "tool_use") toolUses.push({ id: c.id, name: c.name, input: c.input });
    if (e.isSidechain) continue;
    lastAssistant = e;
    // One API response is written as one line per content block, all with the same message id and usage.
    if (m.id && !ids.has(m.id)) {
      ids.add(m.id);
      for (const k of Object.keys(usage)) usage[k] += Number(m.usage?.[k] ?? 0);
    }
  }
  const taskDelivered = Boolean(firstUser && textOf(firstUser.message?.content).trim() === String(task ?? "").trim());
  const init = firstUser ? { claude_code_version: version, permissionMode: firstUser.permissionMode ?? null, mcp_servers: null } : null;
  let finalText = null;
  for (const e of entries) {
    if (e.type === "assistant" && !e.isSidechain) {
      const t = textOf(e.message?.content);
      if (t.trim()) finalText = t;
    }
  }
  const isError = Boolean(lastAssistant?.isApiErrorMessage);
  const result =
    init && ended
      ? {
          type: "result",
          subtype: "success",
          is_error: isError,
          result: finalText ?? "",
          errors: [],
          num_turns: ids.size,
          total_cost_usd: cost?.totalCostUSD ?? null,
          modelUsage: cost?.modelUsage ?? null,
          usage,
          permission_denials: [],
        }
      : null;
  return { toolUses, result, init, assistantModels: [...assistantModels], rateLimitEvents: [], types, toolsOffered, taskDelivered };
}

/** Tool calls codenclawed refused (deny, or an ask that was not approved), from its audit decisions: the -p result's permission_denials. */
export function deniedCalls(audit, toolUses) {
  const byId = new Map(toolUses.map((u) => [u.id, u]));
  return audit
    .filter((x) => x.type === "claude-code.tool.pre" && (x.payload?.decision === "deny" || (x.payload?.decision === "ask" && x.payload?.approval?.approved !== true)))
    .map((x) => ({ tool_name: x.payload?.tool ?? null, tool_use_id: x.payload?.toolUseId ?? null, tool_input: byId.get(x.payload?.toolUseId)?.input ?? {} }));
}

/** codenclawed's own messages on the terminal (its stderr is the person's terminal): "codenclawed: ..." lines. */
export function codenclawedLines(ptyText) {
  const plain = String(ptyText ?? "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r/g, "\n");
  return plain
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^codenclawed: /.test(l) && !/^codenclawed: (approval needed|approved$|denied)/.test(l));
}

/**
 * The record's `person` block: what the person was asked (each prompt's text as shown), what it answered,
 * and what codenclawed did with each call (its audit): approved at its prompt, or refused by a rule that no
 * approval overrides (deny: no question was put to the person at all).
 */
export function personRecord(summary, audit, { kind = "approve-all" } = {}) {
  const pre = audit.filter((x) => x.type === "claude-code.tool.pre");
  const approvals = (summary?.approvals ?? []).map((a) => ({ n: a.n, source: a.source, tool: a.tool ?? null, text: a.text, ...(a.options ? { options: a.options } : {}), choice: a.choice, ...(a.rule ? { rule: a.rule } : {}), result: a.result ?? null }));
  return {
    kind,
    status: summary?.status ?? "no-summary",
    endedBy: summary?.endedBy ?? null,
    taskTyped: Boolean(summary?.taskTyped),
    taskDelivered: Boolean(summary?.taskDelivered),
    wallS: summary?.wallS ?? null,
    approvalsGiven: approvals.length,
    codenclawedPrompts: approvals.filter((a) => a.source === "codenclawed").length,
    claudeCodeDialogs: approvals.filter((a) => a.source === "claude-code").length,
    approvals,
    activation: summary?.activation ?? [],
    unrecognized: summary?.unrecognized ?? null,
    // codenclawed's own account of each call: who answered an ask, and the denials no person was asked about.
    askedAndApproved: pre.filter((x) => x.payload?.approval?.approved === true).map((x) => ({ tool: x.payload.tool, codes: x.payload.codes ?? null, by: x.payload.approval.by })),
    askedNotApproved: pre.filter((x) => x.payload?.decision === "ask" && x.payload?.approval && x.payload.approval.approved !== true).map((x) => ({ tool: x.payload.tool, codes: x.payload.codes ?? null, approval: x.payload.approval })),
    refusedEvenWithPerson: pre.filter((x) => x.payload?.decision === "deny").map((x) => ({ tool: x.payload.tool, codes: x.payload.codes ?? null, input: x.payload.input ?? null })),
  };
}

/** Why a C1A run is a harness error and not a result, or null. */
export function personHarnessError(summary) {
  if (!summary) return "c1a-no-person-summary: the stand-in person wrote no summary (scripts/yes-person.py did not finish)";
  if (summary.status === "stall") return `c1a-person-stall: the session waited for input the stand-in person did not recognize (no output for the stall limit; last screen in out/person.json)${summary.unrecognized ? `; unrecognized dialog: ${JSON.stringify(summary.unrecognized.options ?? []).slice(0, 300)}` : ""}`;
  if (summary.taskTyped && !summary.taskDelivered && summary.status !== "timeout") return "c1a-task-not-delivered: the task was typed but Claude Code's transcript never showed it as the first prompt";
  return null;
}
