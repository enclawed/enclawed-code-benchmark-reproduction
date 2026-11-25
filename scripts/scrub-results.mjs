#!/usr/bin/env node
// Make the published result files from the raw ones. Deterministic: the same raw bytes always give
// the same published bytes.
//
//   node scripts/scrub-results.mjs <raw file>:<published file> [<raw file>:<published file> ...]
//
// Every line keeps its place, and every byte outside the replaced values is kept as recorded
// (no record is re-serialized). What is replaced, everywhere it occurs:
//   - the benchmark's working directory, Claude Code's scratch directory of the session that ran it
//     (/tmp/claude-<uid>/-home-<user>-<checkout>/<session id>/scratchpad)    -> /tmp/bench/run
//     and its path-encoded form (-tmp-claude-<uid>--home-...-scratchpad)       -> -tmp-bench-run
//     also where a cut text holds only a piece of it                         -> /tmp/bench/run
//     (the session's own directory around it                                -> /tmp/bench)
//   - any other UUID-shaped identifier                                        -> 00000000-0000-0000-0000-000000000000
//   - the home directory /home/<user>                                         -> ~
//   - the Enclaweder's serial number (ECPRO-<hex>)                            -> ECPRO-SERIAL
//   - every e-mail address a model wrote, except the fixtures' reserved example
//     domains (example, *.example, *.invalid) and noreply@anthropic.com       -> user@example.com
//   - the claude.ai account connector's name ("claude.ai <Name>")            -> claude.ai connector
//     and its tool prefix (mcp__claude_ai_<Name>__)                           -> mcp__claude_ai_connector__
//   - the names of the account's synced skills (anthropic-skills:<name>)      -> anthropic-skills:account-skill
//   - the top-level `rateLimitEvents` field of a record (the subscription's
//     usage, utilization and overage state)                                   -> null
//
// /tmp/bench/run holds only path characters (the harness's attempt predicates read paths as shell
// text, where a ">" would read as a redirection), and the paper's call labeling
// (paper/scripts/call-truth.mjs) recognizes it as the scratch directory. A cut beginning of the
// directory of 12 characters or more becomes /tmp/bench/run too, which is again the beginning of the
// published run directory, as the labeling requires. Other paths under /tmp/claude-<uid>/ (files a
// model wrote there) name no user and are kept. ~ is what the labeling puts in place of the home
// directory.
import fs from "node:fs";

const HOME_RE = /\/home\/[a-z_][a-z0-9_-]*(?![A-Za-z0-9_-])/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SERIAL_RE = /ECPRO-[0-9A-F]{8,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Fixture addresses (reserved example domains, possibly cut short) and model commit trailers stay.
const keepEmail = (a) => {
  const [local, domain] = a.split("@");
  return /(^|\.)exa(m(p(l(e)?)?)?)?(\.|$)|\.invalid$/.test(domain) || (local === "noreply" && domain === "anthropic.com") || a === "user@example.com";
};
const CONNECTOR_RE = /claude\.ai (?!connector\b)[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*/g;
const CONNECTOR_TOOL_RE = /mcp__claude_ai_(?!connector__)[A-Za-z0-9_]+?__/g;
const SKILL_RE = /anthropic-skills:(?!account-skill\b)[a-z0-9-]+/g;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const BENCH_DIR = "/tmp/bench/run";
const BENCH_DIR_ENC = "-tmp-bench-run";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROOT_RE = new RegExp(`/tmp/claude-\\d+/-home-[A-Za-z0-9._-]+?/${UUID}/scratchpad`, "g");
const ROOT_ENC_RE = new RegExp(`-tmp-claude-\\d+--home-[A-Za-z0-9._-]+?-${UUID}-scratchpad`, "g");
const SESSION_RE = new RegExp(`/tmp/claude-\\d+/-home-[A-Za-z0-9._-]+?/${UUID}`, "g");
const PATH_CH = "A-Za-z0-9._/-";

// The working directories the raw files name (read from the files, not written here).
export function rootsOf(texts) {
  const roots = new Set();
  for (const t of texts) for (const m of t.matchAll(ROOT_RE)) roots.add(m[0]);
  return [...roots].sort();
}

// A text cut short (a tool input cut at 500 characters, the tail of stderr, a table cell) can hold
// only the beginning of a working directory, then no further path character (anywhere once it reaches
// the user's part of the path; a shorter beginning of 12 characters or more only where a string ends),
// or only its end, then the rest of a path under it.
const partialCache = new Map();
function partialRes(roots) {
  const key = roots.join("\n");
  if (partialCache.has(key)) return partialCache.get(key);
  const pre = []; // into the user's part of the path: anywhere
  const preEnd = []; // shorter: only where a string ends (a cut input)
  const suf = [];
  for (const r of roots) {
    const user = r.indexOf("-home-");
    for (let n = r.length - 1; n >= 12; n--) (n > user ? pre : preEnd).push(esc(r.slice(0, n)));
    for (let n = r.length - 1; n >= 1; n--) suf.push(esc(r.slice(r.length - n)));
  }
  const byLength = (a, b) => b.length - a.length || (a < b ? -1 : 1);
  const out = [];
  if (pre.length) {
    out.push(new RegExp(`(?:${[...new Set(pre)].sort(byLength).join("|")})(?![${PATH_CH}])`, "g"));
    out.push(new RegExp(`(?:${[...new Set(preEnd)].sort(byLength).join("|")})(?=")`, "g"));
    out.push(new RegExp(`(?<![${PATH_CH}])(?:${[...new Set(suf)].sort(byLength).join("|")})(?=/(?:bench-native|smoke-v3|hostc|modelprobe|c2-))`, "g"));
  }
  // Last, any other piece of a path that still holds 8 or more characters of the user's part of a
  // working directory or of its session id: the whole path token.
  const pieces = new Set();
  for (const r of roots) {
    const from = r.indexOf("-home-") + 6;
    const to = r.length - "/scratchpad".length;
    const userEnd = r.indexOf("-", from); // the user's name ends at the first "-" after -home-
    const idStart = r.lastIndexOf("/", to - 1) + 1;
    // Windows that touch the user's name or the session id (not ones inside the checkout's name alone).
    for (let i = from; i + 8 <= to; i++) if (i < userEnd || i + 8 > idStart) pieces.add(esc(r.slice(i, i + 8)));
  }
  if (pieces.size) out.push(new RegExp(`[${PATH_CH}]*(?:${[...pieces].sort().join("|")})[${PATH_CH}]*`, "g"));
  partialCache.set(key, out);
  return out;
}

export function scrubText(s, roots = []) {
  // Whole directories first (with the raw session id), then cut pieces of them.
  // The session's own directory, of which the working directory is scratchpad/, becomes /tmp/bench,
  // after the cut beginnings of the working directory (which can end inside "scratchpad").
  const res = partialRes(roots);
  let t = s.replace(ROOT_RE, BENCH_DIR).replace(ROOT_ENC_RE, BENCH_DIR_ENC);
  for (const re of res.slice(0, -1)) t = t.replace(re, BENCH_DIR);
  t = t.replace(SESSION_RE, "/tmp/bench");
  if (res.length) t = t.replace(res.at(-1), BENCH_DIR);
  return t
    .replace(UUID_RE, ZERO_UUID)
    .replace(HOME_RE, "~")
    .replace(SERIAL_RE, "ECPRO-SERIAL")
    .replace(EMAIL_RE, (a) => (keepEmail(a) ? a : "user@example.com"))
    .replace(CONNECTOR_RE, "claude.ai connector")
    .replace(CONNECTOR_TOOL_RE, "mcp__claude_ai_connector__")
    .replace(SKILL_RE, "anthropic-skills:account-skill");
}

// The end of the JSON value starting at `i` in `s` (one past its last character).
function valueEnd(s, i) {
  const c = s[i];
  if (c === '"') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === '"') return j + 1;
    }
    throw new Error("unterminated string");
  }
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (d === '"') j = valueEnd(s, j) - 1;
      else if (d === "{" || d === "[") depth++;
      else if (d === "}" || d === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    throw new Error("unterminated container");
  }
  const m = /^[^,}\]\s]+/.exec(s.slice(i));
  return i + m[0].length;
}

// Replace the value of the top-level key `key` of the JSON object in `line` by null, in place.
export function nullTopLevel(line, key) {
  let i = line.indexOf("{");
  if (i < 0) return line;
  i++;
  for (;;) {
    while (/[\s,]/.test(line[i] ?? "")) i++;
    if (line[i] !== '"') return line; // end of object
    const kEnd = valueEnd(line, i);
    const k = JSON.parse(line.slice(i, kEnd));
    let j = kEnd;
    while (/[\s:]/.test(line[j])) j++;
    const vEnd = valueEnd(line, j);
    if (k === key) return line.slice(0, j) + "null" + line.slice(vEnd);
    i = vEnd;
  }
}

export function scrubLine(line, roots = []) {
  if (!line.trim()) return line;
  let out = line.includes('"rateLimitEvents"') ? nullTopLevel(line, "rateLimitEvents") : line;
  out = scrubText(out, roots);
  JSON.parse(out); // every published line is still one JSON record
  return out;
}

export function scrubFile(src, dst, roots = rootsOf([fs.readFileSync(src, "utf8")])) {
  const raw = fs.readFileSync(src, "utf8");
  // The published name says what the file is (a raw backup may carry a suffix after .jsonl).
  const out = dst.endsWith(".jsonl") ? raw.split("\n").map((l) => scrubLine(l, roots)).join("\n") : scrubText(raw, roots);
  if (dst.endsWith(".json")) JSON.parse(out);
  fs.writeFileSync(dst, out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pairs = process.argv.slice(2);
  if (!pairs.length) {
    process.stderr.write("usage: node scripts/scrub-results.mjs <raw>:<published> [...]\n");
    process.exit(2);
  }
  const split = pairs.map((p) => {
    const k = p.lastIndexOf(":");
    return [p.slice(0, k), p.slice(k + 1)];
  });
  // One list of working directories for every file, so a value is replaced the same way in all of them.
  const roots = rootsOf(split.map(([src]) => fs.readFileSync(src, "utf8")));
  for (const [src, dst] of split) scrubFile(src, dst, roots);
}
