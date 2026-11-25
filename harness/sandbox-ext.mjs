// The benchmark's sandbox: the exact bubblewrap layout of
// test/adversarial/sandbox.mjs (read-only host, empty tmpfs HOME, private /tmp, only the run directory writable, shared
// network so 127.0.0.1 listeners are reachable), plus what the codenclawed arms
// need and the adversarial runner did not:
//   - ~/.claude is NOT an overlay of the real one (that exposed the host's
//     session transcripts to the agent under test): it is an empty directory
//     holding only the real .credentials.json, bound read-only;
//   - extra read-only binds (the frozen codenclawed snapshot lives under /tmp,
//     which the sandbox otherwise replaces with an empty tmpfs);
//   - /run/user hidden, so nothing inside can reach the operator's user systemd
//     or D-Bus (a `systemd-run --user` from inside a PID namespace must never
//     touch host processes);
//   - /sys/class/hidraw hidden unless the arm uses the real device, and the
//     device node bound in (C2 only);
//   - an optional flock (the Enclaweder is shared with other live tests).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./scenarios/sandbox.mjs";
import { loginBindProblem } from "./hostc/login-guard.mjs";

/**
 * How the chosen login reaches the sandbox:
 *   "ro-bind" (default)  the real file, bound read-only at ~/.claude/.credentials.json;
 *   "copy"               a writable COPY only, written into the sandbox's tmpfs HOME at
 *                        `credentialsCopyTo` (bwrap --file from a pipe: the bytes are read here, on the host,
 *                        and the real file is bound nowhere). For a build that seals the login under a
 *                        bound Enclaweder (hostc/login-guard.mjs loginSealWiring): its first launch seals the
 *                        one plaintext login it finds and erases it, which a read-only bind cannot allow, and a
 *                        second plaintext login (the real file beside a copy) is refused. The real file outside
 *                        HOME (--auth credentials-file) is masked with /dev/null, so it is visible nowhere.
 *   "none"               no plaintext login at all, the real file masked as in "copy": a later session of
 *                        a run on such a build, whose one login is the one an earlier session sealed under
 *                        the device (a plaintext copy beside it is refused, as on a real machine).
 */
export const CREDENTIALS_MODES = ["ro-bind", "copy", "none"];

/** The bwrap options that place the login, and the bytes to feed the --file pipe (copy mode). Pure but for the read. */
export function credentialArgs({ credentialsFile, credentialsMode = "ro-bind", credentialsCopyTo = null, home = HOME }) {
  if (!CREDENTIALS_MODES.includes(credentialsMode)) throw new Error(`credentialsMode: ${CREDENTIALS_MODES.join(" or ")}, not ${credentialsMode}`);
  const dotClaude = path.join(home, ".claude");
  if (!credentialsFile) return { args: ["--dir", dotClaude], fd3: null };
  if (credentialsMode === "ro-bind") return { args: ["--dir", dotClaude, "--ro-bind", credentialsFile, path.join(dotClaude, ".credentials.json")], fd3: null };
  const dest = credentialsCopyTo ? path.resolve(credentialsCopyTo) : null;
  if (credentialsMode === "copy" && (!dest || !dest.startsWith(`${home}${path.sep}`))) throw new Error("credentialsMode copy: credentialsCopyTo must be a path under the sandbox HOME (a tmpfs)");
  // HOME and /tmp are fresh tmpfs mounts in the sandbox (runBench): nothing of the host's is visible there.
  const under = (p) => [home, "/tmp"].some((d) => p === d || p.startsWith(`${d}${path.sep}`));
  const real = (() => {
    try {
      return fs.realpathSync(credentialsFile);
    } catch {
      return path.resolve(credentialsFile);
    }
  })();
  // Anywhere else the read-only root shows the real file: mask it.
  const masks = [...new Set([path.resolve(credentialsFile), real])].filter((p) => !under(p)).flatMap((p) => ["--ro-bind", "/dev/null", p]);
  if (credentialsMode === "none") return { args: ["--dir", dotClaude, ...masks], fd3: null };
  return { args: ["--dir", dotClaude, "--dir", path.dirname(dest), "--perms", "0600", "--file", "3", dest, ...masks], fd3: credentialsFile };
}

export function runBench({ runDir, cwd, argv, env, credentialsFile = null, credentialsMode = "ro-bind", credentialsCopyTo = null, roBinds = [], devBinds = [], showHidraw = false, lockFile = null, before = null, gate = null, abortIf = null, stdoutFile, stderrFile, timeoutMs }) {
  // The person's login is only ever bound read-only: never under a path the sandbox can write
  // (the run dir, a --dev-bind, or a --bind among the caller's leading bwrap options).
  const rwFromArgv = argv.flatMap((a, i) => (a === "--bind" || a === "--dev-bind" ? [argv[i + 1]] : []));
  const bindProblem = loginBindProblem(credentialsFile, [runDir, ...devBinds, ...rwFromArgv]);
  if (bindProblem) throw new Error(`refusing to run: ${bindProblem}`);
  const cred = credentialArgs({ credentialsFile, credentialsMode, credentialsCopyTo });
  const claudeShare = path.join(HOME, ".local", "share", "claude");
  const localBin = path.join(HOME, ".local", "bin");
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run/user",
    "--tmpfs", HOME,
    // ~/.claude holds ONLY the login: an empty tmpfs directory with the chosen
    // credentials file (the runner's own subscription login, or another file it
    // named) bound read-only; none with --auth api-key. No projects/,
    // transcripts, history, todos, shell snapshots, plugins or skills of the
    // host are visible. In "copy" mode (credentialArgs) the real file is bound
    // nowhere: a writable copy is written into the tmpfs at credentialsCopyTo.
    ...cred.args,
    "--ro-bind", claudeShare, claudeShare,
    "--ro-bind", localBin, localBin,
  ];
  if (!showHidraw && fs.existsSync("/sys/class/hidraw")) {
    args.push("--tmpfs", "/sys/class/hidraw");
  }
  for (const b of roBinds) args.push("--ro-bind", b, b);
  for (const d of devBinds) args.push("--dev-bind", d, d);
  args.push("--bind", runDir, runDir, "--unshare-pid", "--die-with-parent", "--chdir", cwd, "--clearenv");
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  args.push(...argv);
  return (async () => {
    const lock = lockFile ? await acquireLock(lockFile) : null;
    try {
      // A wait that must end before the launch (the login guard: hostc/login-guard.mjs). It returns
      // false to refuse the run (the runner was told to stop while waiting): nothing is launched.
      if (gate && !(await gate())) throw Object.assign(new Error("not launched: the runner was stopped while the login guard waited"), { loginGuardStop: true });
      // A check that must hold while the lock is held (e.g. a single device owner); it throws to refuse the run.
      const beforeResult = before ? before() : null;
      // Copy mode: the login's bytes, read here at launch (after any login-guard wait; a read failure
      // throws before anything starts), go through a pipe that bwrap drains into the tmpfs and closes
      // before the sandboxed program starts: nothing inside holds a descriptor of the real file.
      const bytes = cred.fd3 ? fs.readFileSync(cred.fd3) : null;
      return await new Promise((resolve) => {
        const out = fs.openSync(stdoutFile, "w");
        const err = fs.openSync(stderrFile, "w");
        const started = Date.now();
        const child = spawn("bwrap", args, { stdio: ["ignore", out, err, ...(bytes ? ["pipe"] : [])] });
        if (bytes) {
          child.stdio[3].on("error", () => bytes.fill(0));
          child.stdio[3].end(bytes, () => bytes.fill(0));
        }
        let timedOut = false;
        let aborted = null;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        // A hard guard polled on the live output (e.g. the account-connector check): kill the run at once.
        const poll = abortIf
          ? setInterval(() => {
              if (aborted) return;
              const why = abortIf();
              if (why) {
                aborted = why;
                child.kill("SIGKILL");
              }
            }, 250)
          : null;
        child.on("close", (status, signal) => {
          clearTimeout(timer);
          if (poll) clearInterval(poll);
          if (!aborted && abortIf) aborted = abortIf();
          fs.closeSync(out);
          fs.closeSync(err);
          resolve({ status, signal, timedOut, aborted, wallS: Math.round((Date.now() - started) / 100) / 10, lockWaitS: lock?.waitS ?? null, beforeResult });
        });
      });
    } finally {
      lock?.release();
    }
  })();
}

/** Hold an flock(1) on lockFile through a holder process; release kills it. */
function acquireLock(lockFile) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const holder = spawn("flock", ["-o", "-w", "7200", lockFile, "-c", "echo held; exec cat > /dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
    let done = false;
    holder.stdout.on("data", (d) => {
      if (!done && String(d).includes("held")) {
        done = true;
        resolve({ waitS: Math.round((Date.now() - t0) / 100) / 10, release: () => { holder.stdin.end(); setTimeout(() => holder.kill("SIGKILL"), 2000).unref(); } });
      }
    });
    holder.on("close", (code) => {
      if (!done) reject(new Error(`could not take the device lock ${lockFile} (flock exit ${code})`));
    });
  });
}
