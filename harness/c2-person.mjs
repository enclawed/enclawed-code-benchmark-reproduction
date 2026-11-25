// The person's one-time C2 steps, shared by c2-grant.mjs and c2-approve.mjs: their arguments, and
// the broker-client setup both run under (a CLIENT of the host-side owner, never the device itself).
//
// Since the ticket-bound builds (codenclawed src/device-activation.mjs GRANT_TICKET_BINDING), a
// device unlock is bound to ONE unlock ticket, and one for more than one launch or ten minutes to ONE
// job (src/commitments.mjs launchJob: name, measured code, effective policy, project, launch kind).
// With ENCLAWEDER_ROOT=required a launch also needs the device-signed approval of the snapshot's
// measurement (and of the effective policy when a user policy file shapes it).
import fs from "node:fs";
import path from "node:path";
import { WORK } from "./bench-config.mjs";
import { loadC2Framework } from "./c2-framework.mjs";
import { C2_JOB_KIND, C2_JOB_NAME, C2_PROJECT_DIR, C2_SHARED_MINUTES, C2_SHARED_USES } from "./c2-unlock.mjs";

/** The launch kinds a device unlock can name (codenclawed commitments.mjs LAUNCH_KINDS). */
export const LAUNCH_KINDS = ["headless:print", "headless"];
/** A grant without a job: at most one launch within ten minutes (the device's rule). */
export const UNBOUND_MAX_USES = 1;
export const UNBOUND_MAX_MINUTES = 10;

export const GRANT_USAGE =
  "usage: node c2-grant.mjs --build <id> [--work-dir DIR] [--uses N] [--minutes M] [--job NAME] [--project DIR] [--kind headless:print|headless] [--grant-dir DIR] [--bind-ticket FILE]\n" +
  `  shared C2 grant (default): --uses ${C2_SHARED_USES} --minutes ${C2_SHARED_MINUTES} --job ${C2_JOB_NAME} --project ${C2_PROJECT_DIR} --kind ${C2_JOB_KIND}\n` +
  "  hostc attack 7, one repetition: --grant-dir <run state> --uses 1 --minutes 10 --bind-ticket <run state>/claude-code/auth/unlock-ticket.json";

const flagValue = (argv, n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : "") : null;
};

/**
 * c2-grant.mjs's arguments. Without --bind-ticket it is the shared C2 grant: the job and bounds
 * default to the shared ones. With --bind-ticket and no --job it is a one-launch, ten-minute unlock.
 * @returns {{ ok: true, build, uses, minutes, job, project, kind, grantDir, bindTicket } | { ok: false, error: string }}
 */
export function parseGrantArgs(argv) {
  const v = (n) => flagValue(argv, n);
  const bad = (error) => ({ ok: false, error });
  for (const n of ["--build", "--uses", "--minutes", "--job", "--project", "--kind", "--grant-dir", "--bind-ticket", "--work-dir"]) {
    if (v(n) === "") return bad(`${n} needs a value`);
  }
  const build = v("--build");
  if (!build) return bad("--build <id> is required");
  const bindTicket = v("--bind-ticket");
  const shared = !bindTicket;
  const job = v("--job") ?? (shared ? C2_JOB_NAME : null);
  const uses = Number(v("--uses") ?? (job ? C2_SHARED_USES : UNBOUND_MAX_USES));
  const minutes = Number(v("--minutes") ?? (job ? C2_SHARED_MINUTES : UNBOUND_MAX_MINUTES));
  if (!Number.isInteger(uses) || uses < 1 || uses > C2_SHARED_USES) return bad(`--uses: a whole number 1..${C2_SHARED_USES}`);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > C2_SHARED_MINUTES) return bad(`--minutes: a whole number 1..${C2_SHARED_MINUTES}`);
  if (job !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(job)) return bad("--job: 1..64 letters, digits, '.', '_' or '-'");
  if (!job && (uses > UNBOUND_MAX_USES || minutes > UNBOUND_MAX_MINUTES)) {
    return bad(`a grant for more than ${UNBOUND_MAX_USES} launch or ${UNBOUND_MAX_MINUTES} minutes must name one job (--job NAME)`);
  }
  if (!job && (v("--project") !== null || v("--kind") !== null)) return bad("--project and --kind describe a job: they need --job");
  const project = v("--project") ?? C2_PROJECT_DIR;
  if (!path.isAbsolute(project)) return bad("--project: an absolute path (the path the C2 sessions are launched from)");
  const kind = v("--kind") ?? C2_JOB_KIND;
  if (!LAUNCH_KINDS.includes(kind)) return bad(`--kind: one of ${LAUNCH_KINDS.join(", ")}`);
  return { ok: true, build, uses, minutes, job, project: job ? project : null, kind: job ? kind : null, grantDir: v("--grant-dir"), bindTicket };
}

/** c2-approve.mjs's arguments. */
export function parseApproveArgs(argv) {
  const build = flagValue(argv, "--build");
  if (!build) return { ok: false, error: "usage: node c2-approve.mjs --build <id> [--work-dir DIR]" };
  return { ok: true, build };
}

/** True when the ticket at `file` is missing, unreadable, or expires within `minutes` from `now`. */
export function ticketNeedsRenewal(file, minutes, now = Date.now()) {
  try {
    const t = JSON.parse(fs.readFileSync(file, "utf8"));
    const exp = Number((t?.body ?? t)?.expiresAt);
    return !Number.isFinite(exp) || exp < now + minutes * 60_000;
  } catch {
    return true;
  }
}

/**
 * Make this process a client of the running C2 broker, with codenclawed's state in `state`. The
 * device is denied to it from the start. Calls `fail` (which exits) on any mismatch.
 * @returns {Promise<{ snap: string, sock: string }>}
 */
export async function brokerClient({ build, state, fail }) {
  let broker;
  try {
    broker = JSON.parse(fs.readFileSync(path.join(WORK, "c2-broker.json"), "utf8"));
    process.kill(broker.pid, 0);
  } catch {
    fail(`the C2 broker is not running (start: node c2-broker.mjs --build ${build} --work-dir ${WORK})`);
  }
  if (broker.build !== build) fail(`the running broker holds the device for build ${broker.build}, not ${build}`);
  fs.mkdirSync(path.join(state, "ehome"), { recursive: true, mode: 0o700 });
  Object.assign(process.env, {
    ENCLAWED_STATE_DIR: state,
    ENCLAWED_HOME: path.join(state, "ehome"),
    ENCLAWEDER_ROOT: "required",
    ENCLAWEDER_STATE_DIR: state,
    ENCLAWEDER_STATE: path.join(state, "hw-root.state"),
    ENCLAWEDER_DEVICE: "deny",
  });
  delete process.env.ENCLAWEDER_HIDRAW;
  delete process.env.ENCLAWEDER_BROKER;
  const { sock } = await loadC2Framework(build);
  if (broker.socket !== sock) fail(`the running broker is on ${broker.socket}, not the build's canonical ${sock}`);
  process.env.ENCLAWEDER_BROKER = sock;
  return { snap: path.join(WORK, `codenclawed-${build}`), sock };
}
