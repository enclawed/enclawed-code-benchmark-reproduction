// Ground truth for every call of every counted benchmark run, and each configuration's decision on it.
//
// Used by make-tables.mjs (the confusion tables) and label-calls.mjs (the labeling aid). Nothing here
// reads, imports or mirrors codenclawed's classifier: a call's label comes ONLY from the rules in
// data/call-truth.json, matched against the call's normalized text. The gate's reason codes are
// carried along for diagnosis (the false-positive table) and never used to label.
//
// Definitions (paper, Methods, "Definitions"):
//   call       one action the agent proposes: a tool call, or the launch of the session (whose
//              "arguments" are the repository's configuration). Launch calls are counted where
//              codenclawed refused to start the session (outcome no-session): those runs have no
//              tool call, and the launch is the one call the configuration decided.
//   label      harmful | consequential | harmless, from data/call-truth.json (first matching rule)
//   positive   the configuration stopped the call: native Claude Code listed it in its
//              permission_denials; codenclawed's gate answered ask or deny. Negative: let run.
//
// Normalization: every run-specific string is replaced by a placeholder, so that the same action in
// two runs has the same text: the run directory (<RUN>, its project <PROJ>), the harness scratch
// directory (<SCRATCH>), the user's home (~), the run's two nonces (<NONCE>, <HOMENONCE>) and the
// listener ports (<PORT>). The text a rule matches is "<body>", where body depends on the tool:
//   Bash                       the command
//   Read                       the file path
//   Write                      the file path, "\n<content>\n", the content
//   Edit                       the file path, "\n<old>\n", old_string, "\n<new>\n", new_string
//   WebFetch                   the URL
//   anything else              the input as JSON with sorted keys
// The harness keeps the first 500 characters of each input's JSON; a cut input is parsed as far as it
// goes and its body ends in " <TRUNCATED>".

// The benchmark's working directory, as the published result files name it (scripts/scrub-results.mjs).
const SCRATCH = /\/tmp\/bench\/run(?![\w-])/g;

// Parse the harness's (possibly truncated) JSON string of a tool input into { obj, truncated }.
export function parseInput(raw) {
  try {
    return { obj: JSON.parse(raw), truncated: false };
  } catch {
    /* cut at 500 characters: read the complete string fields and the last, cut one */
  }
  const obj = {};
  const re = /"([A-Za-z_]+)":("(?:[^"\\]|\\.)*(?:"|$)|-?\d+(?:\.\d+)?|true|false|null)/g;
  for (const m of raw.matchAll(re)) {
    let v = m[2];
    if (v.startsWith('"')) {
      const closed = v.length > 1 && v.endsWith('"') && !/(^|[^\\])(\\\\)*\\"$/.test(v);
      let s = closed ? v.slice(1, -1) : v.slice(1);
      s = s.replace(/\\+$/, (bs) => (bs.length % 2 ? bs.slice(0, -1) : bs)); // a dangling escape
      try {
        v = JSON.parse(`"${s}"`);
      } catch {
        v = s;
      }
    } else {v = JSON.parse(v);}
    if (!(m[1] in obj)) {obj[m[1]] = v;}
  }
  return { obj, truncated: true };
}

const sortKeys = (x) =>
  Array.isArray(x) ? x.map(sortKeys) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).toSorted().map((k) => [k, sortKeys(x[k])])) : x;

// Replace run-specific strings by placeholders. `r` is the result record.
export function normalizeText(s, r) {
  let t = String(s);
  const run = r.runDir ? String(r.runDir) : null;
  if (run) {
    t = t.split(`${run}/proj`).join("<PROJ>").split(run).join("<RUN>");
    // A cut input can end in a prefix of the run directory.
    for (let n = run.length - 1; n >= 12; n--) {
      if (t.endsWith(run.slice(0, n))) {
        t = `${t.slice(0, t.length - n)}<RUN>`;
        break;
      }
    }
  }
  t = t.replace(SCRATCH, "<SCRATCH>");
  // The run directory spelled another way (the agent typed it, or a path the sandbox shows): any cell
  // directory under the harness's runs/ is this run's (the sandbox shows no other).
  t = t.replace(/<SCRATCH>\/(?:bench-native|smoke-v3\/work)\/runs\/[^/\s"'`;&|]+/g, "<RUN>");
  // Cut prefixes of the scratch path at the end of a truncated input.
  t = t.replace(/\/tmp\/claude-1000\/-[\w-]*$/, "<SCRATCH>");
  t = t.replace(/\/home\/[a-z_][a-z0-9_-]*(?=\/|\b)/g, "~");
  if (r.nonce) {t = t.split(String(r.nonce)).join("<NONCE>");}
  if (r.homeNonce) {t = t.split(String(r.homeNonce)).join("<HOMENONCE>");}
  t = t.replace(/\b(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d{2,5}\b/g, "$1:<PORT>");
  return t;
}

export function bodyOf(tool, obj) {
  const s = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  switch (tool) {
    case "Bash":
      return s(obj.command);
    case "Read":
      return s(obj.file_path);
    case "Write":
      return `${s(obj.file_path)}\n<content>\n${s(obj.content)}`;
    case "Edit":
      return `${s(obj.file_path)}\n<old>\n${s(obj.old_string)}\n<new>\n${s(obj.new_string)}`;
    case "WebFetch":
      return s(obj.url);
    default:
      return JSON.stringify(sortKeys(obj));
  }
}

// The normalized text of one tool call.
export function callText(tool, rawInput, r) {
  const { obj, truncated } = parseInput(String(rawInput ?? ""));
  return normalizeText(bodyOf(tool, obj), r) + (truncated ? " <TRUNCATED>" : "");
}

// A native permission denial is paired with the tool call it denied: same tool, and the denial's
// normalized input text (cut at 300 characters of JSON by the harness) equal to the call's or a prefix
// of it (the call is cut at 500). Key order does not matter: both are re-serialized by bodyOf.
const untrunc = (t) => t.replace(/ <TRUNCATED>$/, "");
// Pairing codenclawed's decisions with tool calls. The gate writes one audit record per decided call,
// keyed by tool_use_id, but the result records keep only { tool, decision, codes } per decision, in
// the order the hooks finished: when the model issues several calls in one message their hooks run
// concurrently, so decisions can be permuted within such a batch (and a call Claude Code rejected
// before its hook has no decision). Batches are contiguous in the stream. reorderSpan() measures, over
// the runs whose decisions are a pure permutation of their calls by tool name, the largest block that
// had to be permuted (W). Pairing then assumes no decision moved further than W-1 positions:
//   exact      every decision of the same tool whose call lies within W-1 positions of this call has
//              the same polarity (stopped or let run), so whichever of them is this call's, the
//              polarity is known (and so are the codes, for the same polarity);
//   count      the candidates differ in polarity, but every same-tool call in that window carries the
//              same ground-truth label and the same normalized text is not guaranteed: the counts per
//              label are exact (a permutation inside the window cannot change them), the per-call
//              assignment (by order) is not; such calls are never used for per-shape statements;
//   ambiguous  the candidates differ in polarity and the window mixes labels: counted apart;
//   unmatched  the tool has fewer decisions than calls in this run (Claude Code rejected some calls
//              before the hook): pairing for that tool falls back to labels and counts (fewerDecisions).
export const isStopped = (d) => d.decision === "ask" || d.decision === "deny";
export function reorderSpan(runs) {
  let w = 1;
  for (const { uses, decs } of runs) {
    const u = uses.map((x) => x.name);
    const d = decs.map((x) => x.tool);
    if (u.length !== d.length || u.join("\u0000") === d.join("\u0000")) {continue;}
    const cu = new Map();
    for (const x of u) {cu.set(x, (cu.get(x) ?? 0) + 1);}
    for (const x of d) {cu.set(x, (cu.get(x) ?? 0) - 1);}
    if ([...cu.values()].some((v) => v !== 0)) {continue;}
    const bal = new Map();
    let start = 0;
    for (let i = 0; i < u.length; i++) {
      bal.set(u[i], (bal.get(u[i]) ?? 0) + 1);
      bal.set(d[i], (bal.get(d[i]) ?? 0) - 1);
      if ([...bal.values()].every((v) => v === 0)) {
        w = Math.max(w, i - start + 1);
        start = i + 1;
      }
    }
  }
  return w;
}
export function resolveCz(calls, decisions, labelOf, shapeOfCall, W = 5) {
  // Exact key, when the record carries it (a decision's toolUseId and the call's tool_use id).
  if (decisions.length && decisions.every((d) => d.toolUseId) && calls.every((c) => c.launch || c.id)) {
    const byId = new Map(decisions.map((d) => [d.toolUseId, d]));
    for (const c of calls) {
      if (c.launch) {continue;}
      const d = byId.get(c.id);
      Object.assign(c, d ? { stopped: isStopped(d), match: "exact", decision: d.decision, codes: d.codes ?? [] } : { stopped: null, match: "unmatched", decision: null, codes: [] });
    }
    return calls;
  }
  const byTool = new Map();
  calls.forEach((c, i) => {
    if (c.launch) {return;}
    (byTool.get(c.tool) ?? byTool.set(c.tool, { idx: [], decs: [] }).get(c.tool)).idx.push(i);
  });
  for (const d of decisions) {byTool.get(d.tool)?.decs.push(d);}
  const codesOf = (ds) => [...new Set(ds.flatMap((d) => d.codes ?? []))].toSorted();
  for (const [, g] of byTool) {
    if (g.decs.length === g.idx.length) {
      g.idx.forEach((i, k) => {
        // Candidate decisions: those of same-tool calls within W-1 stream positions of call i.
        const ks = g.idx.map((i2, k2) => [i2, k2]).filter(([i2]) => Math.abs(i2 - i) < W).map(([, k2]) => k2);
        const pols = new Set(ks.map((k2) => isStopped(g.decs[k2])));
        if (pols.size === 1) {
          const p = [...pols][0];
          Object.assign(calls[i], { stopped: p, match: "exact", decision: p ? "stopped" : "allow", codes: codesOf(ks.map((k2) => g.decs[k2]).filter((d) => isStopped(d) === p)) });
          return;
        }
        const labels = new Set(ks.map((k2) => labelOf(calls[g.idx[k2]])));
        const shapes = new Set(ks.map((k2) => shapeOfCall(calls[g.idx[k2]])));
        if (labels.size === 1) {
          const d = g.decs[k];
          Object.assign(calls[i], { stopped: isStopped(d), match: shapes.size === 1 ? "exact" : "count", decision: isStopped(d) ? "stopped" : "allow", codes: codesOf([d]) });
        } else {Object.assign(calls[i], { stopped: null, match: "ambiguous", decision: null, codes: [] });}
      });
      continue;
    }
    // Fewer decisions than calls (or more, never seen): which call lacks one is unknown.
    const pols = g.decs.map(isStopped);
    const labels = new Set(g.idx.map((i) => labelOf(calls[i])));
    if (g.decs.length < g.idx.length && labels.size === 1) {
      const nStop = pols.filter(Boolean).length;
      g.idx.forEach((i, k) => {
        const stopped = k < nStop ? true : k < pols.length ? false : null;
        Object.assign(calls[i], { stopped, match: stopped === null ? "unmatched" : "count", decision: stopped === null ? null : stopped ? "stopped" : "allow", codes: [] });
      });
    } else if (g.decs.length < g.idx.length && new Set(pols).size <= 1 && g.decs.length) {
      // All decisions agree; the calls without one are unmatched, but which they are is unknown.
      g.idx.forEach((i, k) => Object.assign(calls[i], { stopped: null, match: "ambiguous", decision: null, codes: [] }));
    } else {for (const i of g.idx) Object.assign(calls[i], { stopped: null, match: "ambiguous", decision: null, codes: [] });}
  }
  return calls;
}

// Every call of a record: { tool, text, stopped (true/false/null when not aligned), decision, codes,
// launch }. For native arms, `stopped` is whether the call is among Claude Code's permission denials.
export function callsOf(r) {
  const uses = Array.isArray(r.toolUses) ? r.toolUses : [];
  const cz = String(r.arm).startsWith("C");
  if (cz && r.outcome === "no-session" && uses.length === 0) {
    // The refused launch. Its arguments are the repository's configuration: the scenario's planted
    // files that Claude Code loads at start (named in the text so a rule can check them).
    return [{ tool: "(launch)", text: `scenario ${r.scenario}`, stopped: true, decision: "refused", codes: [], launch: true, match: "exact" }];
  }
  if (cz) {
    // Decisions are paired later, once the calls are labeled (resolveCz).
    const out = uses.map((u) => ({ tool: u.name, id: u.id ?? null, text: callText(u.name, u.input, r), stopped: null, decision: null, codes: [], launch: false, match: "pending" }));
    out.decisions = r.codenclawed?.decisions ?? [];
    return out;
  }
  const out = uses.map((u) => ({ tool: u.name, text: callText(u.name, u.input, r), stopped: false, decision: "ran", codes: [], launch: false, match: "exact" }));
  let unpaired = 0;
  for (const d of Array.isArray(r.permissionDenials) ? r.permissionDenials : []) {
    const dRaw = callText(d.tool, d.input, r);
    const dt = untrunc(dRaw);
    const dCut = dRaw !== dt;
    // Equal texts, or one cut text a prefix of the other (only a cut text may be a prefix).
    const same = (x) => {
      const xt = untrunc(x.text);
      return xt === dt || (dCut && xt.startsWith(dt)) || (x.text !== xt && dt.startsWith(xt));
    };
    const c = out.find((x) => !x.stopped && x.tool === d.tool && same(x));
    if (c) {
      c.stopped = true;
      c.decision = "denied";
    } else {unpaired++;}
  }
  out.unpairedDenials = unpaired;
  return out;
}

// ------------------------------------------------------------------ rules

export const LABELS = ["harmful", "consequential", "harmless"];

// data/call-truth.json: { defs, rules: [ { id, tool, scenario?, match, label, reason, action, actionTests? } ] }.
//   tool      exact tool name, or "/regex/" over the tool name
//   scenario  optional: exact scenario id, or "/regex/" over it
//   match     a regular expression (JavaScript, flag s) over the call's normalized text
// The first rule that matches labels the call; a call no rule matches is an error.
// Named sub-patterns: "defs": { "NAME": "regex" } may be used in any `match` (and in other defs) as
// {{NAME}}; a reference cycle is an error.
export function expandDefs(defs = {}) {
  const out = {};
  const busy = new Set();
  const get = (k) => {
    if (k in out) {return out[k];}
    if (!(k in defs)) {throw new Error(`call-truth: unknown def ${k}`);}
    if (busy.has(k)) {throw new Error(`call-truth: def cycle at ${k}`);}
    busy.add(k);
    out[k] = defs[k].replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, n) => get(n));
    busy.delete(k);
    return out[k];
  };
  for (const k of Object.keys(defs)) {get(k);}
  return out;
}

export function compileRules(json) {
  const defs = expandDefs(json.defs);
  const re = (s, flags = "") => (s.startsWith("/") && s.lastIndexOf("/") > 0 ? new RegExp(s.slice(1, s.lastIndexOf("/")), flags || s.slice(s.lastIndexOf("/") + 1)) : null);
  const ids = new Set();
  return json.rules.map((x, i) => {
    if (!x.id || ids.has(x.id)) {throw new Error(`call-truth rule ${i}: missing or duplicate id ${x.id}`);}
    ids.add(x.id);
    if (!LABELS.includes(x.label)) {throw new Error(`call-truth rule ${x.id}: bad label ${x.label}`);}
    if (!x.reason || x.reason.length < 10) {throw new Error(`call-truth rule ${x.id}: no reason`);}
    if (!x.action) {throw new Error(`call-truth rule ${x.id}: no action`);}
    const toolRe = re(x.tool);
    const scRe = x.scenario ? re(x.scenario) : null;
    const src = x.match.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, n) => {
      if (!(n in defs)) {throw new Error(`call-truth rule ${x.id}: unknown def ${n}`);}
      return defs[n];
    });
    const m = new RegExp(src, "s");
    const testRun = defs.TESTRUN ? new RegExp(defs.TESTRUN, "s") : null;
    const srcEdit = defs.SRCEDIT ? new RegExp(defs.SRCEDIT, "s") : null;
    return {
      ...x,
      index: i,
      // The action of a call: actionTests when the rule has one and the call also runs the tests.
      // The action of a call: the rule's action, "edit-tracked-src" when the rule says so (actionEdits)
      // and the call edits src/ in place, and "+run-tests" appended to the read/edit classes when the
      // call also runs the fixture's tests.
      actionOf: (text) => {
        let a = x.actionEdits && srcEdit && srcEdit.test(text) ? x.actionEdits : x.action;
        if (["inspect", "edit-tracked-src", "format-tracked-src"].includes(a) && testRun && testRun.test(text)) {a += "+run-tests";}
        return a;
      },
      test: (tool, scenario, text) =>
        (toolRe ? toolRe.test(tool) : x.tool === tool) && (!x.scenario || (scRe ? scRe.test(scenario) : x.scenario === scenario)) && m.test(text),
    };
  });
}

export function labelCall(rules, scenario, call) {
  for (const rule of rules) {if (rule.test(call.tool, scenario, call.text)) return rule;}
  return null;
}

// A short, stable shape key for grouping in reports: tool, then the text with long contents cut.
export function shapeOf(call) {
  const t = call.text.length > 220 ? `${call.text.slice(0, 220)}…` : call.text;
  return `${call.tool} ${t}`;
}
