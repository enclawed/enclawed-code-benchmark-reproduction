#!/usr/bin/env node
// Marks the C2 cells of one build whose last record was taken while device activation could not
// work over the broker: the framework of that build gives a client of the device's owner no
// device-verified second factor ("no TOTP relay over the broker"), and the harness issued no
// device unlock, so every C2 session either refused at activation or was refused earlier on its
// way there. None of them ran C2 as designed. Like invalidate-connector.mjs it appends a copy of
// the cell's last record with `invalid: "c2-activation-unavailable"`; the originals stay, and the
// runner re-runs the cell. The mark depends only on the build and the arm, never on the verdict.
//
//   node invalidate-c2-activation.mjs --build <id> [--results DIR] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { RESULTS } from "./bench-config.mjs";

export const C2_ACTIVATION_INVALID = "c2-activation-unavailable";
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : null;
};
const build = arg("--build");
const dry = process.argv.includes("--dry-run");
if (!build) {
  console.error("usage: node invalidate-c2-activation.mjs --build <id> [--results DIR] [--dry-run]");
  process.exit(2);
}
const file = path.join(arg("--results") ?? RESULTS, "codenclawed-main.jsonl");
const last = new Map();
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (r.arm === "C2" && r.build === build && r.key) last.set(r.key, r);
}
let marked = 0;
for (const r of last.values()) {
  if (r.invalid || r.harnessError) continue;
  marked++;
  if (!dry) fs.appendFileSync(file, `${JSON.stringify({ ...r, invalid: C2_ACTIVATION_INVALID, invalidated: { at: new Date().toISOString(), reason: "device activation unavailable to a broker client; no device unlock issued" } })}\n`);
}
console.log(`${dry ? "[dry-run] " : ""}C2 cells of build ${build} marked ${C2_ACTIVATION_INVALID}: ${marked}`);
