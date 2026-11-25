#!/usr/bin/env node
// Renders the data appendix: every long table the paper's table generator exports, as one PDF.
//
//   node scripts/render-report.mjs [--export-dir DIR] [--out FILE] [--html FILE]
//     [--playwright-core DIR] [--markdown-it DIR] [--chromium FILE]
//
// Without --export-dir the script runs the generator's export itself (the command printed on the title
// page) on a temporary copy of paper/, so nothing in the repository is rewritten, and it checks that
// the paper tables of that run are byte-identical to paper/generated/*.tex. The export's Markdown files
// are the source: the PDF holds their text and their tables and nothing else; the CSV files are only
// used to check that every Markdown table has the same rows.
//
// Dependencies (not installed by this repository): playwright-core, with a Chromium build it can
// launch, and markdown-it. Each is found by normal module resolution, or from the directory given by
// --playwright-core / PLAYWRIGHT_CORE_DIR and --markdown-it / MARKDOWN_IT_DIR. --chromium /
// CHROMIUM_PATH names a Chromium executable when playwright-core's own browser is not installed.
//
// Deterministic: the date on the title page and the PDF's creation and modification dates are those of
// the newest result record (or SOURCE_DATE_EPOCH, when set), so two runs with the same inputs, Chromium
// and fonts write the same bytes.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, env) => {
  const i = args.indexOf(name);
  if (i >= 0) {
    if (!args[i + 1]) throw new Error(`${name} needs a value`);
    return args[i + 1];
  }
  return (env && process.env[env]) || null;
};
const OUT = path.resolve(opt("--out") ?? path.join(ROOT, "report", "enclawed-code-benchmark-tables.pdf"));
const HTML_OUT = opt("--html");

// ------------------------------------------------------------------ provenance
const REPO_URL = "https://github.com/enclawed/enclawed-code-benchmark-reproduction";
const TAG = "arxiv-v1";
const TITLE = "Enclawed Code benchmark: full tables";
const SUBTITLE = "Data appendix to the Enclawed Code paper (arXiv)";
const AUTHOR = "Alfredo Metere";
const AFFILIATION = "Enclawed, Inc.";
const ARM_BUILDS = "C2=6329ccd,hostc:C1=a3a1fc4";
const GEN_ARGS = [
  "--bench", "../harness", "--results", "../results",
  "--models", "claude-haiku-4-5,claude-fable-5-1,claude-opus-5-5", "--cz-build", "67a30e7",
];
const GEN_COMMAND = [
  "cd paper",
  `CZ_ARM_BUILDS="${ARM_BUILDS}" \\`,
  "  node scripts/make-tables.mjs --bench ../harness --results ../results \\",
  "    --models claude-haiku-4-5,claude-fable-5-1,claude-opus-5-5 --cz-build 67a30e7 \\",
  "    --export <dir>",
].join("\n");
const RESULTS = path.join(ROOT, "results");
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const DIGESTS = [
  ...fs.readdirSync(RESULTS).filter((f) => f.endsWith(".jsonl")).sort().map((f) => `results/${f}`),
  ...fs.readdirSync(path.join(RESULTS, "replay-input")).filter((f) => f.endsWith(".jsonl")).sort().map((f) => `results/replay-input/${f}`),
  "paper/data/replay-8c2c068aa.json",
].map((rel) => ({ rel, hash: sha256(path.join(ROOT, rel)) }));

// The date: SOURCE_DATE_EPOCH, else the newest record timestamp in results/*.jsonl.
const DATE = (() => {
  if (process.env.SOURCE_DATE_EPOCH) return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000);
  let max = "";
  for (const f of fs.readdirSync(RESULTS).filter((x) => x.endsWith(".jsonl"))) {
    for (const m of fs.readFileSync(path.join(RESULTS, f), "utf8").matchAll(/"ts":"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/g)) if (m[1] > max) max = m[1];
  }
  if (!max) throw new Error("no record timestamp in results/*.jsonl; set SOURCE_DATE_EPOCH");
  return new Date(max);
})();
const DATE_TEXT = DATE.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

// ------------------------------------------------------------------ the export
function runExport() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ecw-report-"));
  const paper = path.join(tmp, "paper");
  // The generator writes the paper's tables next to its own scripts; run it on a copy.
  for (const d of ["scripts", "data", "generated"]) fs.cpSync(path.join(ROOT, "paper", d), path.join(paper, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "paper", "refs.bib"), path.join(paper, "refs.bib"));
  const exp = path.join(tmp, "export");
  const genArgs = GEN_ARGS.map((a) => (a.startsWith("../") ? path.join(ROOT, a.slice(3)) : a));
  try {
    execFileSync(process.execPath, [path.join(paper, "scripts", "make-tables.mjs"), ...genArgs, "--export", exp], {
      cwd: paper,
      env: { ...process.env, CZ_ARM_BUILDS: ARM_BUILDS, CZ_EXPORT_DIR: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    process.stderr.write(String(e.stderr ?? ""));
    throw new Error("the table generator failed");
  }
  // The run that wrote the export must write the paper's tables exactly as committed.
  const committed = path.join(ROOT, "paper", "generated");
  const names = new Set([...fs.readdirSync(committed), ...fs.readdirSync(path.join(paper, "generated"))]);
  for (const n of [...names].sort()) {
    const a = path.join(committed, n), b = path.join(paper, "generated", n);
    if (!fs.existsSync(a) || !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b)))
      throw new Error(`export run: paper/generated/${n} differs from the committed file; the export would not match the paper`);
  }
  return { dir: exp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

// ------------------------------------------------------------------ dependencies
async function load(name, dirOpt, envName) {
  const dir = opt(dirOpt, envName);
  const req = createRequire(dir ? path.join(path.resolve(dir), "package.json") : import.meta.url);
  const entry = dir ? req.resolve(path.resolve(dir)) : req.resolve(name);
  const mod = await import(pathToFileURL(entry).href);
  return mod.default ?? mod;
}

// ------------------------------------------------------------------ CSV (to cross-check the Markdown)
function parseCsv(t) {
  const rows = [];
  let r = [], c = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { r.push(c); c = ""; }
    else if (ch === "\n") { r.push(c); rows.push(r); r = []; c = ""; }
    else c += ch;
  }
  if (c || r.length) { r.push(c); rows.push(r); }
  return rows;
}

// ------------------------------------------------------------------ layout of each table
// Presentation only: column widths (relative), font size, a column whose runs of equal values become
// group heading rows, and column splits for tables too wide for a portrait page (each part repeats the
// key columns). Columns are named by their header text; an unknown name stops the script.
const LAYOUT = {
  asr: { font: 7.5, widths: { Configuration: 12, Mode: 14.5, Runs: 5, Attempted: 9.5, Successes: 9, Restored: 8.5, "Success rate": 7, "Wilson 95% interval": 12.5, "Success rate when attempted": 8.5, Fallback: 8, "No model": 6 } },
  models: { font: 8.5, widths: { "Model requested": 16, "Answered by": 30 } },
  "per-scenario-N0": { font: 8.5, widths: { Scenario: 40 } },
  "per-scenario-N1": { font: 8.5, widths: { Scenario: 40 } },
  "per-scenario-C1": { font: 8.5, widths: { Scenario: 40 } },
  "per-scenario-C2": { font: 8.5, widths: { Scenario: 40 } },
  "native-findings": {
    font: 8,
    mono: ["Repro"],
    parts: [
      { label: "the scenarios, what happens and the command that reproduces one cell", cols: ["Scenario", "Finding", "What happens", "Repro"], widths: { Scenario: 17, Finding: 18, "What happens": 42, Repro: 23 } },
      { label: "the counts per configuration and permission mode, and the pooled rates", cols: ["Scenario", "N0 default", "N0 acceptEdits", "N0 auto", "N0 bypassPermissions", "N1 acceptEdits", "N1 auto", "Native success rate", "Wilson 95% interval", "C1", "C2"], widths: { Scenario: 22, "N0 default": 7, "N0 acceptEdits": 8, "N0 auto": 7, "N0 bypassPermissions": 10.5, "N1 acceptEdits": 8, "N1 auto": 7, "Native success rate": 8, "Wilson 95% interval": 14, C1: 6, C2: 5 } },
    ],
  },
  attacks: { font: 7.5, groupBy: "Group", widths: { Id: 12.5, Attack: 21, Native: 6, SW: 6, Dev: 6, "Rule that closes it": 25, "Reason, if open software only": 12, Evidence: 11.5 } },
  catalog: { font: 8, groupBy: "Group", widths: { Scenario: 22, Impact: 10, "Top 10": 5, Source: 23, Goal: 40 } },
  "mixed-actions": { font: 8, mono: ["Stopped phrasing", "Let-run phrasing"], widths: { Configuration: 12, Scenario: 16, Action: 13, Label: 12, Calls: 6, "Stopped phrasing": 22, "Let-run phrasing": 22 } },
  incidents: {
    font: 7.5,
    parts: [
      { label: "the incident, the gap it exploited and the verdict", cols: ["#", "Date", "Incident", "Gap", "Prevented", "Evidence", "Scenarios"], widths: { "#": 4, Date: 9, Incident: 21, Gap: 27, Prevented: 10, Evidence: 10, Scenarios: 19 } },
      { label: "the deciding rule and the source", cols: ["#", "Incident", "Decided by", "Source"], widths: { "#": 4, Incident: 22, "Decided by": 48, Source: 26 } },
    ],
  },
};
const ORDER_FALLBACK = ["asr", "models", "per-scenario-N0", "per-scenario-N1", "per-scenario-C1", "per-scenario-C2", "native-findings", "attacks", "catalog", "mixed-actions", "incidents"];

// Abbreviations, listed only when they occur in the export's text.
const ABBREVIATIONS = [
  ["AI", "artificial intelligence"],
  ["API", "application programming interface"],
  ["AWS", "Amazon Web Services"],
  ["CDN", "content delivery network"],
  ["CI", "continuous integration"],
  ["CLI", "command-line interface"],
  ["CSV", "comma-separated values"],
  ["CVE", "Common Vulnerabilities and Exposures (an identifier of a published vulnerability)"],
  ["DB", "database"],
  ["DNS", "Domain Name System"],
  ["FIDO2", "Fast IDentity Online 2 (a hardware-key and passkey standard)"],
  ["GHSA", "GitHub Security Advisory"],
  ["HTML", "HyperText Markup Language"],
  ["JSON", "JavaScript Object Notation"],
  ["KB", "kilobyte"],
  ["MCP", "Model Context Protocol"],
  ["NFC", "Unicode Normalization Form C"],
  ["OIDC", "OpenID Connect"],
  ["PDF", "Portable Document Format"],
  ["PI", "prompt injection"],
  ["POST", "the Hypertext Transfer Protocol (HTTP) request method that sends data to a server"],
  ["PR", "pull request"],
  ["RCE", "remote code execution"],
  ["RFC", "Request for Comments (an Internet standards document)"],
  ["SHA-256", "Secure Hash Algorithm 256"],
  ["SQL", "Structured Query Language"],
  ["SSH", "Secure Shell"],
  ["URL", "Uniform Resource Locator"],
  ["UTC", "Coordinated Universal Time"],
];

// ------------------------------------------------------------------ HTML
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NUMERIC = /^(--|n\/a|pending|closed|open|[0-9][0-9.,/%]*|\[[0-9.]+%?, ?[0-9.]+%?\])$/;
// Header text: allow breaks at camelCase boundaries (bypass|Permissions).
const headerHtml = (h) => h.replace(/([a-z])(?=[A-Z])/g, "$1<wbr>");

function readTable(md, dir, name) {
  // The generator writes two adjacent code spans as `a``b`, which Markdown reads as one span holding
  // the backticks; join them into the single span `ab` they denote (same text, no backtick shown).
  const src = fs.readFileSync(path.join(dir, `${name}.md`), "utf8").replace(/(?<=[^`\s])``(?=[^`\s])/g, "");
  const tokens = md.parse(src, {});
  const out = { name, title: null, notes: [], header: [], rows: [] };
  let row = null, inHead = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open" && t.tag === "h1") { out.title = tokens[i + 1].content; i += 2; continue; }
    if (t.type === "paragraph_open" && !row) { out.notes.push(md.renderer.renderInline(tokens[i + 1].children, md.options, {})); i += 2; continue; }
    if (t.type === "thead_open") inHead = true;
    if (t.type === "thead_close") inHead = false;
    if (t.type === "tr_open") row = [];
    if ((t.type === "th_open" || t.type === "td_open") && row) {
      const inl = tokens[i + 1];
      row.push({ html: inl.type === "inline" ? md.renderer.renderInline(inl.children, md.options, {}) : "", text: inl.type === "inline" ? inl.content : "" });
    }
    if (t.type === "tr_close") { if (inHead) out.header = row.map((c) => c.text); else out.rows.push(row); row = null; }
  }
  // Every Markdown row must match the CSV row by row, cell count and text (code marks aside).
  const csv = parseCsv(fs.readFileSync(path.join(dir, `${name}.csv`), "utf8"));
  if (csv.length - 1 !== out.rows.length) throw new Error(`${name}: ${out.rows.length} Markdown rows, ${csv.length - 1} CSV rows`);
  if (csv[0].join("\u0000") !== out.header.join("\u0000")) throw new Error(`${name}: Markdown and CSV headers differ`);
  out.rows.forEach((r, k) => {
    if (r.length !== out.header.length) throw new Error(`${name}: row ${k + 1} has ${r.length} cells`);
    r.forEach((c, j) => {
      const a = c.text.replace(/\\\|/g, "|").replace(/`/g, ""), b = csv[k + 1][j];
      if (a !== b) throw new Error(`${name}: row ${k + 1}, column ${out.header[j]}: Markdown ${JSON.stringify(a)} vs CSV ${JSON.stringify(b)}`);
    });
  });
  return out;
}

// Links of the export point to its own files: a table's .md becomes a link to its section, a .csv a file name.
function fixLinks(html) {
  return html
    .replace(/<a href="README\.md">([\s\S]*?)<\/a>/g, '<a href="#sec-about">$1</a>')
    .replace(/<a href="([\w.-]+)\.md">([\s\S]*?)<\/a>/g, '<a href="#sec-$1">$2</a>')
    .replace(/<a href="([\w.-]+)\.csv">([\s\S]*?)<\/a>/g, '<span class="file">$2</span>');
}

// The columns every part of a split table repeats, in words.
function keyText(parts) {
  const keys = parts[0].cols.filter((c) => parts.every((p) => p.cols.includes(c)));
  const q = keys.map((k) => `&ldquo;${esc(k)}&rdquo;`);
  return q.length === 1 ? `the column ${q[0]}` : `the columns ${q.slice(0, -1).join(", ")} and ${q.at(-1)}`;
}

function tableHtml(t, cols, widths, groupBy, mono = []) {
  const idx = cols.map((c) => {
    const j = t.header.indexOf(c);
    if (j < 0) throw new Error(`${t.name}: no column ${JSON.stringify(c)}`);
    return j;
  });
  const g = groupBy ? t.header.indexOf(groupBy) : -1;
  const shown = idx.filter((j) => j !== g);
  // Default width (in characters): wide enough for the longest word of the header and of the cells
  // (capped), growing with the average text length; LAYOUT overrides by header name.
  const longestWord = (s) => Math.max(0, ...s.split(/\s+/).map((x) => x.length));
  const w = shown.map((j) => {
    const h = t.header[j];
    if (widths?.[h] != null) return widths[h];
    const lens = t.rows.map((r) => r[j].text.length);
    const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
    const word = Math.max(longestWord(h.replace(/([a-z])(?=[A-Z])/g, "$1 ")) * 1.3, Math.min(18, Math.max(...t.rows.map((r) => longestWord(r[j].text)))));
    // A numeric cell ("[8.9%, 15.0%]", "15/90") is never wrapped.
    const whole = t.rows.every((r) => NUMERIC.test(r[j].text.trim())) ? Math.max(...t.rows.map((r) => r[j].text.length)) * 0.95 : 0;
    // A short column (at most 16 characters) is never wrapped either.
    const max = Math.max(...t.rows.map((r) => r[j].text.length));
    const short = max <= 16 ? max * 0.95 : 0;
    return Math.max(word + 2, whole + 2, short + 2, Math.min(60, avg * 0.6 + 4));
  });
  const sum = w.reduce((a, b) => a + b, 0);
  const numeric = shown.map((j) => t.rows.every((r) => NUMERIC.test(r[j].text.trim())));
  let body = "", prevGroup = null, z = 0;
  for (const r of t.rows) {
    if (g >= 0 && r[g].text !== prevGroup) {
      prevGroup = r[g].text;
      z = 0;
      body += `<tr class="group"><th colspan="${shown.length}" scope="colgroup">${fixLinks(r[g].html)}</th></tr>\n`;
    }
    body += `<tr class="${z++ % 2 ? "even" : "odd"}">${shown.map((j, k) => `<td${numeric[k] ? ' class="num"' : mono.includes(t.header[j]) ? ' class="mono"' : ""}>${fixLinks(r[j].html)}</td>`).join("")}</tr>\n`;
  }
  return `<table>
<colgroup>${w.map((x) => `<col style="width:${((100 * x) / sum).toFixed(2)}%">`).join("")}</colgroup>
<thead><tr>${shown.map((j, k) => `<th scope="col"${numeric[k] ? ' class="num"' : ""}>${headerHtml(esc(t.header[j]))}</th>`).join("")}</tr></thead>
<tbody>
${body}</tbody>
</table>`;
}

function buildHtml(dir, md, pages) {
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  // The order of the export's README file list; any table it does not list follows.
  const listed = [...readme.matchAll(/^- \[([\w.-]+)\.md\]/gm)].map((m) => m[1]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.slice(0, -3));
  const order = [...listed.filter((n) => files.includes(n)), ...files.filter((n) => !listed.includes(n)).sort((a, b) => (ORDER_FALLBACK.indexOf(a) - ORDER_FALLBACK.indexOf(b)) || a.localeCompare(b))];
  const tables = order.map((n) => readTable(md, dir, n));

  // The export README, without its title and file list (the contents below replace it).
  const sections = readme.split(/^(?=## )/m);
  const aboutMd = sections.filter((s) => /^## /.test(s) && !/^## Files\b/.test(s)).join("");
  const aboutHtml = fixLinks(md.render(aboutMd.replace(/^## /gm, "### ")));

  const allText = [readme, ...tables.map((t) => fs.readFileSync(path.join(dir, `${t.name}.md`), "utf8"))].join("\n");
  const abbr = ABBREVIATIONS.filter(([a]) => ["PDF", "SHA-256", "CSV"].includes(a) || new RegExp(`(^|[^A-Za-z0-9-])${a.replace("-", "\\-")}s?([^A-Za-z0-9]|$)`).test(allText));

  const entries = [
    { id: "sec-abbreviations", title: "Abbreviations" },
    { id: "sec-about", title: "About these tables" },
    ...tables.map((t, k) => ({ id: `sec-${t.name}`, title: `${k + 1}. ${t.title}`, rows: t.rows.length })),
  ];
  const pg = (id) => (pages ? String(pages.get(id) ?? "?") : "00");

  const tableSections = tables.map((t, k) => {
    const L = LAYOUT[t.name] ?? {};
    const notes = t.notes.map((n) => `<p class="${/^Rows: \d+\./.test(n) ? "meta" : "note"}">${fixLinks(n)}</p>`).join("\n");
    const groupNote = L.groupBy ? `<p class="layout">Rows are grouped by the column &ldquo;${esc(L.groupBy)}&rdquo;; each group's value heads its rows.</p>` : "";
    let body;
    if (L.parts) {
      const covered = new Set(L.parts.flatMap((p) => p.cols));
      const missing = t.header.filter((h) => !covered.has(h));
      if (missing.length) throw new Error(`${t.name}: columns in no part: ${missing.join(", ")}`);
      body = L.parts.map((p, i) => `<h2 id="sec-${t.name}-${i + 1}"${i ? ' class="newpage"' : ""}>Part ${i + 1} of ${L.parts.length}: ${esc(p.label)}</h2>\n` +
        `<p class="layout">The table is split in ${L.parts.length} parts to fit the page; each part repeats ${keyText(L.parts)}.</p>\n` +
        tableHtml(t, p.cols, p.widths, null, L.mono)).join("\n");
    } else body = tableHtml(t, t.header, L.widths, L.groupBy ?? null, L.mono);
    return `<section class="table-section" id="sec-${t.name}" style="--tfont:${L.font ?? 8.5}pt">
<h1>${k + 1}. ${esc(t.title)}</h1>
${notes}
${groupNote}
${body}
</section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<title>${esc(TITLE)}</title>
<meta name="author" content="${esc(AUTHOR)}">
<style>
@page {
  size: 8.5in 11in;
  margin: 0.8in 0.6in 0.75in 0.6in;
  @top-left { content: "${TITLE}"; font: 8pt "Lato", "DejaVu Sans", sans-serif; color: #555; vertical-align: bottom; padding-bottom: 8pt; }
  @top-right { content: "${DATE_TEXT}"; font: 8pt "Lato", "DejaVu Sans", sans-serif; color: #555; vertical-align: bottom; padding-bottom: 8pt; }
  @bottom-center { content: "Page " counter(page) " of " counter(pages); font: 8pt "Lato", "DejaVu Sans", sans-serif; color: #555; vertical-align: top; padding-top: 8pt; }
}
@page :first {
  @top-left { content: none; }
  @top-right { content: none; }
  @bottom-center { content: none; }
}
:root { --ink: #1b1f24; --muted: #57606a; --rule: #c9d1d9; --head: #e8eef5; --zebra: #f5f7fa; --accent: #0284c7; --group: #dbe9f4; }
html { font-family: "Lato", "Noto Sans", "Liberation Sans", "DejaVu Sans", sans-serif; font-size: 10pt; color: var(--ink); background: #fff; line-height: 1.38; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; }
code, .mono, pre { font-family: "Ubuntu Mono", "DejaVu Sans Mono", "Noto Mono", monospace; }
code { font-size: 0.98em; overflow-wrap: anywhere; }
a { color: var(--accent); text-decoration: none; }
h1 { font-size: 15pt; font-weight: 700; margin: 0 0 8pt; line-height: 1.2; break-after: avoid; }
h2 { font-size: 11pt; font-weight: 700; margin: 14pt 0 4pt; break-after: avoid; }
h3 { font-size: 11pt; font-weight: 700; margin: 12pt 0 4pt; break-after: avoid; }
p { margin: 0 0 6pt; }
.cover { break-after: page; padding-top: 1.4in; }
.cover .t { font-size: 26pt; font-weight: 700; line-height: 1.15; margin: 0 0 10pt; }
.cover .st { font-size: 14pt; color: var(--muted); margin: 0 0 28pt; }
.cover .au { font-size: 12pt; margin: 0 0 2pt; }
.cover .dt { font-size: 11pt; color: var(--muted); margin: 0 0 36pt; }
.cover .prov { border-top: 1.5pt solid var(--accent); padding-top: 10pt; font-size: 9pt; }
.cover .prov .ph { font-size: 10pt; font-weight: 700; margin: 0 0 4pt; }
.cover table.dig { width: 100%; border-collapse: collapse; font-size: 8pt; table-layout: fixed; }
.cover table.dig td { padding: 2pt 4pt; border-bottom: 0.5pt solid var(--rule); vertical-align: top; overflow-wrap: anywhere; }
.cover table.dig td:first-child { width: 36%; }
pre { font-size: 8.5pt; background: var(--zebra); border: 0.5pt solid var(--rule); padding: 6pt 8pt; white-space: pre-wrap; overflow-wrap: anywhere; margin: 4pt 0 8pt; break-inside: avoid; }
.toc { break-after: page; }
.toc ol { list-style: none; padding: 0; margin: 0; }
.toc li { display: flex; align-items: baseline; padding: 3.5pt 0; break-inside: avoid; }
.toc li a { color: var(--ink); }
.toc li .rows { color: var(--muted); font-size: 8.5pt; margin-left: 5pt; white-space: nowrap; }
.toc li .dots { flex: 1; border-bottom: 1pt dotted #9aa4ae; margin: 0 6pt; transform: translateY(-3pt); }
.toc li .pg { font-variant-numeric: tabular-nums; min-width: 2.2em; text-align: right; }
.abbr dl { display: grid; grid-template-columns: 6em 1fr; gap: 2pt 10pt; margin: 0 0 8pt; }
.abbr dt { font-weight: 700; }
.abbr dd { margin: 0; }
.front { break-after: page; }
.about ul { padding-left: 14pt; margin: 0 0 6pt; }
.about li { margin-bottom: 3pt; }
.table-section { break-before: page; }
.table-section p.note { font-size: 9pt; }
.table-section p.meta, .table-section p.layout { font-size: 8.5pt; color: var(--muted); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: var(--tfont, 8.5pt); line-height: 1.3; margin: 6pt 0 10pt; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { padding: 3pt 4pt; text-align: left; vertical-align: top; overflow-wrap: break-word; word-break: normal; hyphens: manual; }
thead th { background: var(--head); border-bottom: 1pt solid #8c959f; font-weight: 700; }
h2.newpage { break-before: page; margin-top: 0; }
td.mono { font-family: "Ubuntu Mono", "DejaVu Sans Mono", "Noto Mono", monospace; overflow-wrap: anywhere; }
tbody td { border-bottom: 0.5pt solid var(--rule); }
tbody tr.even td { background: var(--zebra); }
tr.group th { background: var(--group); text-align: left; font-weight: 700; padding: 4pt 4pt; border-bottom: 0.5pt solid #8c959f; break-after: avoid; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td a { overflow-wrap: anywhere; }
.file { font-family: "Ubuntu Mono", "DejaVu Sans Mono", monospace; }
</style>
</head>
<body>
<section class="cover">
<div class="t">${esc(TITLE)}</div>
<div class="st">${esc(SUBTITLE)}</div>
<div class="au">${esc(AUTHOR)} (${esc(AFFILIATION)})</div>
<div class="dt">${esc(DATE_TEXT)}</div>
<div class="prov">
<div class="ph">Provenance</div>
<p>Every table in this document is a long table that the paper's table generator exports as Markdown and comma-separated values (CSV), typeset here without change. The generator, the harness and the result files are in the reproduction repository <a href="${REPO_URL}">${REPO_URL.replace("https://", "")}</a>, tag <code>${TAG}</code>.</p>
<p>The result files, identified by their Secure Hash Algorithm 256 (SHA-256) digests:</p>
<table class="dig"><tbody>
${DIGESTS.map((d) => `<tr><td><code>${esc(d.rel)}</code></td><td><code>${d.hash}</code></td></tr>`).join("\n")}
</tbody></table>
<p style="margin-top:8pt">The generator command that writes the export (from the repository root):</p>
<pre>${esc(GEN_COMMAND)}</pre>
<p>This Portable Document Format (PDF) file is rendered from that export by <code>scripts/render-report.mjs</code>.</p>
</div>
</section>
<nav class="toc">
<h1>Contents</h1>
<ol>
${entries.map((e) => `<li><a href="#${e.id}">${esc(e.title)}</a>${e.rows != null ? `<span class="rows">(${e.rows} rows)</span>` : ""}<span class="dots"></span><span class="pg">${pg(e.id)}</span></li>`).join("\n")}
</ol>
</nav>
<section class="front">
<section class="abbr" id="sec-abbreviations">
<h1>Abbreviations</h1>
<dl>
${abbr.map(([a, d]) => `<dt>${esc(a)}</dt><dd>${esc(d)}</dd>`).join("\n")}
</dl>
<p>The configurations N0, N1, C1 and C2 and the permission modes are defined in the next section.</p>
</section>
<section class="about" id="sec-about">
<h1>About these tables</h1>
${aboutHtml}
</section>
</section>
${tableSections}
</body>
</html>
`;
}

// ------------------------------------------------------------------ PDF
// Page index of each top-level outline entry (Chromium writes one per h1, in document order).
function outlinePages(buf) {
  const s = buf.toString("latin1");
  const xref = s.lastIndexOf("\nxref");
  if (xref < 0) throw new Error("PDF: no classic xref table");
  const offs = new Map();
  let pos = xref + 5;
  const lines = s.slice(pos, s.indexOf("trailer", pos)).split(/\r?\n/).filter(Boolean);
  let num = 0;
  for (const l of lines) {
    const sec = l.match(/^(\d+) (\d+)$/);
    if (sec) { num = Number(sec[1]); continue; }
    const e = l.match(/^(\d{10}) (\d{5}) n/);
    if (e) offs.set(num, Number(e[1]));
    num++;
  }
  const obj = (n) => { const o = offs.get(n); return s.slice(o, s.indexOf("endobj", o)); };
  const ref = (body, key) => { const m = body.match(new RegExp(`/${key} (\\d+) 0 R`)); return m ? Number(m[1]) : null; };
  const trailer = s.slice(s.indexOf("trailer", xref));
  const root = obj(ref(trailer, "Root"));
  const pages = [];
  const walk = (n) => {
    const b = obj(n);
    if (/\/Type\s*\/Pages\b/.test(b)) for (const m of b.match(/\/Kids\s*\[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)) walk(Number(m[1]));
    else pages.push(n);
  };
  walk(ref(root, "Pages"));
  const outl = ref(root, "Outlines");
  if (outl == null) throw new Error("PDF: no outline");
  const out = [];
  for (let n = ref(obj(outl), "First"); n != null; n = ref(obj(n), "Next")) {
    const d = obj(n).match(/\/Dest\s*\[\s*(\d+) 0 R/);
    if (!d) throw new Error("PDF: outline entry without an explicit destination");
    out.push(pages.indexOf(Number(d[1])) + 1);
  }
  return { pages: out, count: pages.length };
}

// Chromium stamps the time of printing; replace it, byte for byte, with the fixed date.
function fixDates(buf) {
  const d = DATE.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const s = buf.toString("latin1").replace(/\/(CreationDate|ModDate) \(D:[^)]*\)/g, (m, k) => {
    const inner = m.slice(m.indexOf("(") + 1, -1);
    let v = `D:${d}+00'00'`;
    if (v.length > inner.length) v = `D:${d}Z`.slice(0, inner.length);
    return `/${k} (${v.padEnd(inner.length, " ")})`;
  });
  return Buffer.from(s, "latin1");
}

async function main() {
  const MarkdownIt = await load("markdown-it", "--markdown-it", "MARKDOWN_IT_DIR");
  const pw = await load("playwright-core", "--playwright-core", "PLAYWRIGHT_CORE_DIR");
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false }); // only explicit URLs; README.md is a file name, not a host
  const given = opt("--export-dir", "CZ_REPORT_EXPORT_DIR");
  const exp = given ? { dir: path.resolve(given), cleanup: () => {} } : runExport();
  const chromium = opt("--chromium", "CHROMIUM_PATH");
  const browser = await pw.chromium.launch(chromium ? { executablePath: chromium } : {});
  try {
    const page = await browser.newPage();
    let pages = null, pdf = null, last = "";
    for (let pass = 0; pass < 5; pass++) {
      const html = buildHtml(exp.dir, md, pages);
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
      // Outline order: Contents, Abbreviations, About, then one entry per table section.
      const ids = ["sec-contents", ...[...html.matchAll(/<section class="(?:abbr|about|table-section)" id="([\w.-]+)"/g)].map((m) => m[1])];
      const { pages: op, count } = outlinePages(pdf);
      if (op.length !== ids.length) throw new Error(`PDF outline has ${op.length} entries, expected ${ids.length}`);
      pages = new Map(ids.map((id, i) => [id, op[i]]));
      const key = JSON.stringify(op);
      if (key === last) {
        if (HTML_OUT) fs.writeFileSync(HTML_OUT, html);
        process.stdout.write(`render-report: ${count} pages\n${ids.map((id) => `  ${id} p. ${pages.get(id)}`).join("\n")}\n`);
        break;
      }
      last = key;
      if (pass === 4) throw new Error("table of contents did not converge");
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, fixDates(pdf));
    process.stdout.write(`render-report: wrote ${path.relative(process.cwd(), OUT) || OUT}\n`);
  } finally {
    await browser.close();
    exp.cleanup();
  }
}

main().catch((e) => {
  process.stderr.write(`render-report: ${e.message}\n`);
  process.exit(1);
});
