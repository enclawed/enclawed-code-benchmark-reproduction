#!/usr/bin/env node
// Write a copy of a results file with the paper's run marks applied (scripts/run-marks.mjs), for
// Enclawed's ground-truth replay, which skips records marked invalid. Every other line is copied
// byte for byte; a marked line is the record re-serialized with its `invalid` field set.
//
//   node scripts/mark-results.mjs <in.jsonl> <out.jsonl>

import fs from "node:fs";
import { markRecord } from "./run-marks.mjs";

const [IN, OUT] = process.argv.slice(2);
if (!IN || !OUT) throw new Error("usage: mark-results.mjs <in.jsonl> <out.jsonl>");
let marked = 0;
const lines = fs
  .readFileSync(IN, "utf8")
  .split("\n")
  .map((line) => {
    if (!line.trim()) return line;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return line;
    }
    const had = r.invalid;
    markRecord(r);
    if (r.invalid === had) return line;
    marked++;
    return JSON.stringify(r);
  });
fs.writeFileSync(OUT, lines.join("\n"));
process.stdout.write(`mark-results: ${OUT}: ${marked} records marked\n`);
