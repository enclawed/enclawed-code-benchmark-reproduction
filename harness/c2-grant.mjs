#!/usr/bin/env node
// Issue a C2 device unlock: a grant the Enclaweder keeps and counts, for the C2 runs' headless
// launches. Run it at a terminal, as the person, while benchmarks/c2-broker.mjs holds the device:
//
//   node c2-grant.mjs --build <id> [--work-dir DIR]                     the shared C2 grant (defaults below)
//        [--uses 65535] [--minutes 2160] [--job hostc-c2] [--project <work-dir>/c2-run/proj] [--kind headless:print]
//   node c2-grant.mjs --build <id> [--work-dir DIR] --grant-dir DIR --uses 1 --minutes 10 --bind-ticket FILE
//
// Ticket-bound builds (src/device-activation.mjs GRANT_TICKET_BINDING): every grant is bound to ONE
// unlock ticket, and a grant for more than one launch or ten minutes to ONE job (src/commitments.mjs
// launchJob). The shared form binds to the ONE shared ticket in <C2_GRANT_DIR>/claude-code/auth/
// (made here by the person step, hostc/person.mjs, when missing or expiring before the lease ends:
// a throwaway credential, up to 65535 uses and 2160 minutes) and to the job every C2 session runs
// as (main plan and hostc): the frozen snapshot's measured code, the effective policy under the runs'
// environment (c2RunEnv: the runs' fresh state dirs hold no policy file), the ONE project path every
// C2 session is launched from (C2_PROJECT_DIR, <work-dir>/c2-run/proj: C2 runs are serialized, so one
// fixed path serves them all) and `-p` (headless:print): one grant covers the whole plan. The runners
// copy the grant, the ticket and its credential, and the approvals (c2-approve.mjs) into each C2 run's
// state dir (installShared).
// The second form is hostc attack 7's: a FRESH 1-use, 10-minute unlock per repetition, issued into
// that run's own state dir and bound to the one-use ticket prepared for it (hostc.mjs prepareFreshGrant).
// An older build without ticket binding gets the old unbound grant, and only without --bind-ticket.
//
// It is the device half of `codenclawed codenclawed auth unlock` (the frozen snapshot's own
// src/device-activation.mjs issueGrant over its own framework: kit.issueDeviceUnlock), run as a
// CLIENT of the broker (ENCLAWEDER_DEVICE=deny: it never opens the device; the code is sealed to the
// device, the owner relays ciphertext). The device counts the uses, so a copied or edited record
// gains nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { C2_GRANT_DIR, C2_GRANT_FILE, authDirOf, c2RunEnv, grantInfo, grantRecordPath, ticketPath } from "./c2-unlock.mjs";
import { GRANT_USAGE, brokerClient, parseGrantArgs, ticketNeedsRenewal } from "./c2-person.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fail = (msg, code = 2) => {
  process.stderr.write(`c2-grant: ${msg}\n`);
  process.exit(code);
};
const a = parseGrantArgs(process.argv.slice(2));
if (!a.ok) fail(`${a.error}\n${GRANT_USAGE}`);
if (!process.stdin.isTTY || !process.stdout.isTTY) fail("the authenticator code is typed by a person at a terminal");

// The codenclawed state dir the grant is issued into: the shared one, or (attack 7) one run's own.
const STATE = a.grantDir ? path.resolve(a.grantDir) : C2_GRANT_DIR;
const RECORD = a.grantDir ? grantRecordPath(STATE) : C2_GRANT_FILE;
const { snap } = await brokerClient({ build: a.build, state: STATE, fail });

const { framework: fw } = await import(pathToFileURL(path.join(snap, "src", "kit.mjs")).href);
const activation = await import(pathToFileURL(path.join(snap, "src", "device-activation.mjs")).href);
const { deviceTotpSeam, issueGrant } = activation;
let ticket = null;
let job = null;
if (activation.GRANT_TICKET_BINDING) {
  // The ticket the grant is bound to: the one named, or the shared one (made or renewed here).
  const tfile = a.bindTicket ? path.resolve(a.bindTicket) : ticketPath(STATE);
  if (!a.bindTicket && ticketNeedsRenewal(tfile, a.minutes)) {
    fs.rmSync(authDirOf(STATE), { recursive: true, force: true });
    const r = spawnSync(process.execPath, [path.join(HERE, "hostc", "person.mjs"), snap, String(a.minutes), String(a.uses)], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ENCLAWED_STATE_DIR: STATE, ENCLAWED_HOME: path.join(STATE, "ehome"), ENCLAWEDER_DEVICE: "deny", ENCLAWEDER_BROKER: "off" },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (r.status !== 0) fail(`the shared ticket could not be made: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    process.stdout.write(`c2-grant: a new shared unlock ticket (${a.uses} uses, ${a.minutes} min): ${tfile}\n`);
  }
  try {
    ticket = JSON.parse(fs.readFileSync(tfile, "utf8"));
  } catch (e) {
    fail(`cannot read the ticket ${tfile} (${e.message})`);
  }
  if (a.job) {
    // The job, as the launcher of a hostc C2 session will recompute it (launcher.mjs jobOf).
    const commitments = await import(pathToFileURL(path.join(snap, "src", "commitments.mjs")).href);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2-grant-home-"));
    const policy = commitments.currentEffectivePolicy(fw, c2RunEnv({ state: STATE, home }));
    fs.rmSync(home, { recursive: true, force: true });
    if (policy.needsApproval) process.stdout.write("c2-grant: a user policy file shapes the runs' policy: approve it too (c2-approve.mjs)\n");
    job = commitments.launchJob({ name: a.job, measurementDigest: commitments.measureLaunch().digest, policyDigest: policy.digest, projectDir: a.project, kind: a.kind });
    process.stdout.write(`c2-grant: job ${job.name}: code ${job.measurementDigest.slice(0, 16)}…, policy ${job.policyDigest.slice(0, 16)}…, project ${a.project}, ${job.kind}\n`);
  }
} else if (a.bindTicket || process.argv.includes("--job")) {
  fail(`build ${a.build} cannot bind a device unlock to a ticket or a job (no GRANT_TICKET_BINDING in src/device-activation.mjs); no unbound grant is issued in its place`);
}
const seam = deviceTotpSeam(fw);
if (!seam?.unlock) fail(`the framework of build ${a.build} has no device-counted unlock`);
const before = grantInfo(RECORD);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let code = 0;
try {
  await fw.bootHardwareRoot();
  if (!seam.access()) fail("no CLEAN Enclaweder can be reached through the broker", 4);
  const g = await issueGrant({ seam, readCode: (q) => rl.question(q), minutes: a.minutes, uses: a.uses, env: process.env, ...(ticket ? { ticket } : {}), ...(job ? { job } : {}) });
  const now = grantInfo(RECORD);
  process.stdout.write(`c2-grant: device unlock for ${g.uses} C2 launch(es), ${g.minutes} min, gid ${now?.gid ?? "?"}${ticket ? ", bound to the ticket" : ""}${job ? ` and the job ${job.name}` : ""}${before ? ` (replaces gid ${before.gid})` : ""}: ${RECORD}\n`);
} catch (err) {
  process.stderr.write(`c2-grant: not issued: ${err?.message ?? err}\n`);
  code = 3;
} finally {
  rl.close();
  try {
    await fw.closeHardwareRootSessionAsync?.();
  } catch {
    /* nothing to close */
  }
}
process.exit(code);
