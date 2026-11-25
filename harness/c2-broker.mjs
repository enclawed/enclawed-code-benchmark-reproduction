#!/usr/bin/env node
// The ONE owner of the Enclaweder for a C2 batch. Runs on the host as the real uid, OUTSIDE any
// namespace, started once and held for the whole batch:
//
//   node benchmarks/c2-broker.mjs --build <final id>   (prints "ready <socket> <pid>", then holds)
//
// It boots the hardware root through the FINAL codenclawed build's own framework
// (c2-framework.mjs: the snapshot made after the reflash to firmware 0.3, carrying the
// hardware-root fixes) on that framework's one canonical broker socket, with the host's real
// device-held latch. If another process already owns the device, this process becomes its
// (attesting) client instead of a second owner; if the latch is DIRTY, or the framework refuses
// the firmware ("device latch unsupported: update firmware"), it refuses to start. It never
// clears or routes around a latch. Inside the C2 sandboxes there is no /dev/hidraw0 and no
// /sys/class/hidraw: they reach the device only through this socket.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadC2Framework, SCRATCH } from "./c2-framework.mjs";

const PIDFILE = path.join(SCRATCH, "c2-broker.json");
const bi = process.argv.indexOf("--build");
const build = bi >= 0 ? process.argv[bi + 1] : null;

let fw;
let sock;
try {
  ({ fw, sock } = await loadC2Framework(build));
} catch (err) {
  process.stderr.write(`c2-broker: ${err.message}\n`);
  process.exit(2);
}
if (fw.underTestRunner()) {
  process.stderr.write("c2-broker: refusing to run under a test runner\n");
  process.exit(2);
}
process.env.ENCLAWEDER_ROOT = "required";
delete process.env.ENCLAWEDER_BROKER; // the canonical socket only
delete process.env.ENCLAWEDER_HIDRAW; // detection, never a pin
try {
  await fw.bootHardwareRoot();
} catch (err) {
  const msg = err?.message ?? String(err);
  if (/device latch unsupported|update firmware/i.test(msg)) {
    process.stderr.write(`c2-broker: the framework refuses the Enclaweder's firmware (${msg}); C2 waits for the reflash to firmware 0.3\n`);
    process.exit(5);
  }
  process.stderr.write(`c2-broker: the hardware root refused to boot: ${msg}\n`);
  process.exit(4);
}
// The device itself must answer: every member's signed latch read over a fresh nonce.
try {
  const nonce = randomBytes(32);
  const att = await fw.attestHardwareRoot(nonce);
  if (!att) {
    throw new Error("no device is bound");
  }
  const members = fw.verifyRootMembers(att.members);
  for (const [uid, st] of fw.verifyRootAttestation(members, nonce, att)) {
    if (st.state !== "CLEAR") {
      throw new Error(`member ${uid} holds a DIRTY latch (${st.reason})`);
    }
  }
} catch (err) {
  process.stderr.write(`c2-broker: the Enclaweder did not prove itself: ${err?.message ?? err}\n`);
  await fw.closeHardwareRootSessionAsync().catch(() => {});
  process.exit(4);
}
const info = (() => {
  try {
    return fw.hardwareRootInfo();
  } catch {
    return null;
  }
})();
fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, build, socket: sock, startedAt: new Date().toISOString(), info }, null, 2));
process.stdout.write(`ready ${sock} ${process.pid}\n`);
const stop = async () => {
  try {
    await fw.closeHardwareRootSessionAsync();
  } catch {}
  try {
    fs.rmSync(PIDFILE, { force: true });
  } catch {}
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1 << 30);
