#!/usr/bin/env node
// Approve the frozen snapshot for C2, once per snapshot: the device-signed approval of its measured
// code (codenclawed `codenclawed measurement approve`) and, when a user policy file shapes the runs'
// effective policy, of that policy (`codenclawed policy approve`). With ENCLAWEDER_ROOT=required a
// launch without them is refused. Run it at a terminal, as the person, while c2-broker.mjs holds the
// device; one authenticator code each:
//
//   node c2-approve.mjs --build <id> [--work-dir DIR]
//
// It runs the snapshot's own src/commitments.mjs approveCurrent as a CLIENT of the broker (never the
// device itself). The approvals land in <C2_GRANT_DIR>/claude-code/approvals.json; the runners copy
// them into each C2 run's state dir with the shared grant and ticket (c2-unlock.mjs installShared).
// The policy is computed under the runs' environment (c2RunEnv), as the launcher of a run computes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { C2_GRANT_DIR, approvalsPath, c2RunEnv } from "./c2-unlock.mjs";
import { brokerClient, parseApproveArgs } from "./c2-person.mjs";

const fail = (msg, code = 2) => {
  process.stderr.write(`c2-approve: ${msg}\n`);
  process.exit(code);
};
const a = parseApproveArgs(process.argv.slice(2));
if (!a.ok) fail(a.error);
if (!process.stdin.isTTY || !process.stdout.isTTY) fail("the authenticator code is typed by a person at a terminal");
const { snap } = await brokerClient({ build: a.build, state: C2_GRANT_DIR, fail });
const { framework: fw } = await import(pathToFileURL(path.join(snap, "src", "kit.mjs")).href);
let commitments;
try {
  commitments = await import(pathToFileURL(path.join(snap, "src", "commitments.mjs")).href);
} catch {
  fail(`build ${a.build} has no measured launch (src/commitments.mjs): nothing to approve`);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2-approve-home-"));
const env = c2RunEnv({ state: C2_GRANT_DIR, home });
const kinds = ["measurement", ...(commitments.currentEffectivePolicy(fw, env).needsApproval ? ["policy"] : [])];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let code = 0;
try {
  for (const kind of kinds) {
    const r = await commitments.approveCurrent({ kind, fw, env, readCode: (q) => rl.question(q) });
    process.stdout.write(`c2-approve: ${kind} ${r.digest.slice(0, 16)}… approved: ${approvalsPath(C2_GRANT_DIR)}\n`);
  }
} catch (err) {
  process.stderr.write(`c2-approve: not approved: ${err?.message ?? err}\n`);
  code = 3;
} finally {
  rl.close();
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(code);
