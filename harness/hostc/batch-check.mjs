#!/usr/bin/env node
// C2, between runs, in a sandbox like a run's: is the batch's continuing codenclawed state genuine?
//   node batch-check.mjs   (env: SNAP, the batch state's codenclawed environment: batch-state.mjs batchEnv)
// With the GENUINE snapshot's own code, as a client of the machine's owner socket (never a device node):
//   root    the hardware root booted (its refusal reason when not: e.g. a DIRTY latch);
//   gate    what the next launch's anchor gate would decide on the log as it is (anchor-gate.mjs
//           launchAnchorGate, the launcher's own check, with the root required);
//   verify  `codenclawed audit verify --json` of the log (coarse fields, measure.mjs verifyResult).
// Prints one JSON line. No device data (statuses and codes only).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyResult } from "./measure.mjs";

export async function probe(env = process.env) {
  const SNAP = env.SNAP;
  const imp = (rel) => import(pathToFileURL(path.join(SNAP, "src", rel)).href);
  const out = { root: { booted: false, reason: null }, device: false, gate: null, verify: null };
  const { loadFramework } = await imp("framework.mjs");
  const { boundDevice } = await imp("device.mjs");
  const { launchAnchorGate } = await imp("anchor-gate.mjs");
  const { auditLogPath } = await imp("paths.mjs");
  const { fw } = await loadFramework();
  const quiet = console.error;
  console.error = () => {};
  try {
    try {
      await fw.bootHardwareRoot();
      out.root.booted = true;
    } catch (e) {
      out.root.reason = String(e?.message ?? e).slice(0, 500);
      return out;
    }
    const device = await boundDevice(fw).catch(() => null);
    out.device = Boolean(device?.canAnchor);
    if (device) {
      const g = await launchAnchorGate(fw, device, auditLogPath(env), { rootRequired: env.ENCLAWEDER_ROOT === "required" }).catch((e) => ({ ok: false, status: "error", code: "check-failed", detail: String(e?.message ?? e) }));
      out.gate = { ok: Boolean(g.ok), status: g.status ?? null, code: g.code ?? null };
    }
  } finally {
    console.error = quiet;
    try {
      fw.closeHardwareRootSession?.();
    } catch {
      /* nothing open */
    }
  }
  const r = spawnSync(process.execPath, [path.join(SNAP, "bin", "codenclawed.mjs"), "audit", "verify", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    j = null;
  }
  // A held log: only a device match verifies (measure.mjs). An empty log has nothing to verify.
  out.verify = j?.empty ? { empty: true, ok: true, category: "empty" } : { empty: false, ...verifyResult(r.status, j, { held: true }) };
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  probe().then(
    (o) => {
      process.stdout.write(`${JSON.stringify(o)}\n`);
      process.exit(0);
    },
    (e) => {
      process.stdout.write(`${JSON.stringify({ error: String(e?.message ?? e).slice(0, 300) })}\n`);
      process.exit(0);
    },
  );
}
