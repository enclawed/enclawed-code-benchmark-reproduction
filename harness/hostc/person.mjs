// The person's activation, inside the sandbox, before the session starts:
//   node person.mjs <install> [ticket minutes, default 15] [ticket uses, default 1]
// (attack 7 in C2 runs it on the host instead, before the person binds a fresh unlock to the ticket:
// hostc.mjs prepareFreshGrant, with 60 minutes so the person has time to type the code; and
// c2-grant.mjs once for the SHARED C2 ticket every C2 run presents: up to 2160 minutes, 65535 uses,
// the bounds of the job-bound grant it is bound to.)
// Headless launches need an unlock ticket signed by the person's enrolled second factor. A benchmark
// cannot touch a security key per run, so the throwaway state dir gets a throwaway credential
// (codenclawed's own demo-credential.mjs, which refuses anything but a fresh directory under the
// temp dir) and ONE one-use ticket. The private key lives only in this process and is discarded
// when it exits: the attacker process never sees it, exactly as with a real security key.
import path from "node:path";
import { pathToFileURL } from "node:url";

const install = process.argv[2];
const minutes = Number(process.argv[3] ?? 15);
const uses = Number(process.argv[4] ?? 1);
if (!Number.isInteger(minutes) || minutes < 1 || minutes > 2160) throw new Error(`ticket minutes: a whole number 1..2160, not ${process.argv[3]}`);
if (!Number.isInteger(uses) || uses < 1 || uses > 65535) throw new Error(`ticket uses: a whole number 1..65535, not ${process.argv[4]}`);
const { authDir } = await import(pathToFileURL(path.join(install, "src", "auth.mjs")).href);
const { enrollDemoCredential, signDemoTicket } = await import(pathToFileURL(path.join(install, "src", "demo-credential.mjs")).href);
const cred = enrollDemoCredential(authDir(process.env));
const body = signDemoTicket(cred, { uses, minutes });
process.stdout.write(`${JSON.stringify({ enrolled: true, ticketUses: body.uses, ticketExpiresAt: body.expiresAt })}\n`);
