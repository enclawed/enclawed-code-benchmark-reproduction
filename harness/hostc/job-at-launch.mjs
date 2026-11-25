#!/usr/bin/env node
// C2, inside the sandbox, after the attacker's pre phase and right before the launch:
//   node job-at-launch.mjs > $OUT/job-at-launch.json
// What the launcher is about to recompute as its job (codenclawed launcher.mjs jobOf): the measured
// code of the run's install (which a pre-launch attacker may have rewritten) and the effective policy
// under the run's environment (which a policy the attacker wrote may shape). Measured with the
// GENUINE snapshot's own code (commitments.mjs, never the install's), over the install's files.
// hostc compares it with the job the shared unlock is bound to: a launch refused at the device unlock
// because the attacker changed the job is the defense working, not a misconfigured launch.
// Digests only. A build without a measured launch: { available: false }.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotBin } from "./snapshot-bin.mjs";

/** The install-side paths of what the launcher measures (commitments.mjs measuredEntries options). */
export function installEntries(snap, install, frameworkEntry) {
  return { appRoot: install, hookBin: snapshotBin(install, "hook"), frameworkEntry: path.join(install, path.relative(snap, frameworkEntry)) };
}

async function main() {
  const { SNAP, INSTALL } = process.env;
  if (!fs.existsSync(path.join(SNAP, "src", "commitments.mjs"))) {
    return { available: false };
  }
  const { FRAMEWORK_ENTRY } = await import(pathToFileURL(path.join(SNAP, "src", "framework.mjs")).href);
  const { framework: fw } = await import(pathToFileURL(path.join(SNAP, "src", "kit.mjs")).href);
  const c = await import(pathToFileURL(path.join(SNAP, "src", "commitments.mjs")).href);
  const out = { available: true, measurementDigest: null, policyDigest: null };
  try {
    out.measurementDigest = c.measureLaunch(installEntries(SNAP, INSTALL, FRAMEWORK_ENTRY)).digest;
  } catch (e) {
    out.measurementError = String(e?.code ?? "unreadable");
  }
  try {
    out.policyDigest = c.currentEffectivePolicy(fw, process.env).digest;
  } catch (e) {
    out.policyError = String(e?.code ?? "unreadable");
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().then(
    (o) => {
      process.stdout.write(`${JSON.stringify(o)}\n`);
      process.exit(0);
    },
    (e) => {
      process.stdout.write(`${JSON.stringify({ available: false, error: String(e?.message ?? e).slice(0, 200) })}\n`);
      process.exit(0);
    },
  );
}
