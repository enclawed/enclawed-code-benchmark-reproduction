#!/usr/bin/env node
// Write abstract-arxiv.txt: abstract.tex with every macro substituted, as the plain ASCII text
// arXiv's abstract field takes, and check it (ASCII only, no math, at most 1500 characters).
//
//   node scripts/make-abstract.mjs        (run after scripts/make-tables.mjs)
//
// Macro values come from generated/bench-macros.tex and from the \newcommand lines of paper.tex.
// Exit status 1 when a check fails, so `make` stops.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAPER = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(PAPER, f), "utf8");
const LIMIT = 1500;

// \newcommand{\Name}{value} with one level of nested braces in the value.
const macros = new Map();
for (const src of [read("paper.tex"), read("generated/bench-macros.tex")]) {
  for (const m of src.matchAll(/\\newcommand\{\\([A-Za-z]+)\}(?:\[\d\])?\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g)) macros.set(m[1], m[2]);
}

let body = read("abstract.tex");
body = body.replace(/^%.*$/gm, "");
body = body.replace(/\\begin\{abstract\}|\\end\{abstract\}|\\noindent/g, "");

// Substitute macros until none is left (values may use other macros).
for (let i = 0; i < 10; i++) {
  const before = body;
  body = body.replace(/\\([A-Za-z]+)(\{\})?/g, (all, name) => (macros.has(name) ? macros.get(name) : all));
  if (body === before) break;
}

// LaTeX to plain text.
const plain = body
  .replace(/\\textcolor\{[^}]*\}\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1")
  .replace(/\\(?:textit|emph|textbf|texttt|mbox)\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1")
  .replace(/\\%/g, "%")
  .replace(/\\&/g, "&")
  .replace(/\\_/g, "_")
  .replace(/-\{\}-/g, "--")
  .replace(/``|''/g, '"')
  .replace(/~/g, " ")
  .replace(/\\,/g, " ")
  .replace(/\{\}/g, "")
  .replace(/\s+/g, " ")
  .trim();

const problems = [];
if (/[^\x20-\x7e]/.test(plain)) problems.push(`non-ASCII characters: ${[...new Set(plain.match(/[^\x20-\x7e]/g))].join(" ")}`);
if (/[\\{}$^]/.test(plain)) problems.push(`LaTeX left over: ${plain.match(/.{0,20}[\\{}$^].{0,20}/)[0]}`);
if (/pending/.test(plain)) problems.push("a pending value reached the abstract");
if (plain.length > LIMIT) problems.push(`${plain.length} characters (limit ${LIMIT})`);

fs.writeFileSync(path.join(PAPER, "abstract-arxiv.txt"), `${plain}\n`);
process.stdout.write(`make-abstract: ${plain.length} characters, ${problems.length ? "FAILED" : "ASCII, no math"} -> abstract-arxiv.txt\n`);
if (problems.length) {
  for (const p of problems) process.stderr.write(`make-abstract: ${p}\n`);
  process.exit(1);
}
