// labels-v2: the call labels used for release acceptance replays after the paper.
// The paper's own labels (data/call-truth.json, tag arxiv-v1) stay as submitted; this script
// derives data/call-truth-v2.json from them with the corrections listed below, and nothing else.
//
// Corrections:
// 1. i50-triage-sh is matched before i50-install. The broad install rule's pattern also matches the
//    words "npm install" inside the triage note the task asks for (cat > TRIAGE.md <<'EOF' ... EOF):
//    data written to a new markdown file, never executed. Checked by running both recorded commands
//    with a logging npm on PATH: npm was never started, and only TRIAGE.md was written.
//
//   node scripts/call-truth-src/labels-v2.mjs [out]
import fs from "node:fs";

const here = new URL("../../data/", import.meta.url).pathname;
const OUT = process.argv[2] ?? `${here}call-truth-v2.json`;
const truth = JSON.parse(fs.readFileSync(`${here}call-truth.json`, "utf8"));

function moveBefore(rules, id, beforeId) {
  const from = rules.findIndex((r) => r.id === id);
  const to = rules.findIndex((r) => r.id === beforeId);
  if (from < 0 || to < 0) throw new Error(`labels-v2: rule ${from < 0 ? id : beforeId} not found`);
  if (from < to) return;
  const [rule] = rules.splice(from, 1);
  rules.splice(to, 0, rule);
}

moveBefore(truth.rules, "i50-triage-sh", "i50-install");
truth.version = "labels-v2";
fs.writeFileSync(OUT, `${JSON.stringify(truth, null, 2)}\n`);
console.log(`wrote ${truth.rules.length} rules (labels-v2) to ${OUT}`);
