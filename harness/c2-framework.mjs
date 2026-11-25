// The framework C2 runs on: the FINAL codenclawed build's own Enclawed framework (the snapshot
// made after the Enclaweder is reflashed to firmware 0.3), and its ONE canonical broker socket.
//
// The C2 broker used to boot a frozen pre-fix snapshot (codenclawed-47d12cd) and build the socket
// path itself from XDG_RUNTIME_DIR. Both are retired: an old framework opens the device without
// the device-held latch, the broker attestation or the one-owner flock, and a hand-built path
// splits one machine into two owners. Now the snapshot's framework must carry the hardware-root
// fixes (it refuses otherwise), and the socket path is whatever that framework's own
// brokerSocketPath() says (/run/user/<host uid>/enclawed/enclaweder.sock), never hard-coded.
import path from "node:path";
import { pathToFileURL } from "node:url";

// The benchmark's work dir (--work-dir / BENCH_WORK_DIR; see bench-config.mjs).
import { WORK as SCRATCH } from "./bench-config.mjs";

export { SCRATCH };
/** Builds made before the hardware-root fixes and the reflash: never a C2 framework. */
export const PRE_FIX_BUILDS = new Set(["47d12cd"]);
/** Exports only a framework with the H1-H15 fixes has (attestation, test guard, canonical path). */
const REQUIRED = ["bootHardwareRoot", "brokerSocketPath", "attestHardwareRoot", "verifyRootMembers", "verifyRootAttestation", "underTestRunner", "closeHardwareRootSessionAsync", "hardwareRootInfo"];

/** The snapshot's framework and the broker socket it uses. Throws when it is not the final one. */
export async function loadC2Framework(build) {
  if (!build) {
    throw new Error("C2: name the final codenclawed build (--build <id>), the snapshot made after the reflash to firmware 0.3");
  }
  if (PRE_FIX_BUILDS.has(build)) {
    throw new Error(`C2: build ${build} predates the hardware-root fixes; C2 runs only on the final build made after the reflash`);
  }
  const entry = path.join(SCRATCH, `codenclawed-${build}`, ".enclawed-dev", "framework", "framework.js");
  const fw = await import(pathToFileURL(entry).href);
  const missing = REQUIRED.filter((k) => typeof fw[k] !== "function");
  if (missing.length) {
    throw new Error(`C2: the framework of build ${build} lacks ${missing.join(", ")}: it predates the hardware-root fixes; rebuild it after the reflash`);
  }
  // The canonical path, not an override: computed with ENCLAWEDER_BROKER unset.
  const saved = process.env.ENCLAWEDER_BROKER;
  delete process.env.ENCLAWEDER_BROKER;
  let sock;
  try {
    sock = fw.brokerSocketPath();
  } finally {
    if (saved !== undefined) {
      process.env.ENCLAWEDER_BROKER = saved;
    }
  }
  if (!/^\/run\/user\/\d+\/enclawed\/enclaweder\.sock$/.test(sock)) {
    throw new Error(`C2: the framework of build ${build} names ${sock} as the broker socket, not the canonical /run/user/<uid>/enclawed/enclaweder.sock`);
  }
  return { fw, sock, entry };
}
