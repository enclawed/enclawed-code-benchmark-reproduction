// The OS sandbox every live run happens in (bubblewrap).
//
// Inside the sandbox:
//   - the whole filesystem is read-only;
//   - HOME is an empty tmpfs, so nothing in the real home directory is
//     visible except what is bound below;
//   - ~/.claude is an overlay of the real one with a throwaway upper layer:
//     Claude Code can read its login and write sessions, checkpoints and
//     settings, and every write is discarded when the run ends;
//   - Claude Code's own install (~/.local/share/claude, ~/.local/bin) and
//     this repository are bound read-only;
//   - /tmp is an empty tmpfs; the run directory (under the work dir) is the
//     only writable host path;
//   - the network namespace is shared: Claude Code must reach the Anthropic
//     API, and the localhost listener the exfiltration scenarios target runs
//     on the host. Payloads only ever name 127.0.0.1.
//
// Because ~/.claude is a throwaway overlay, a refresh of the OAuth token
// inside the sandbox would be lost; preflight() therefore refuses to start
// when the stored token expires too soon.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();

export function bwrapAvailable() {
  const r = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Minutes until the stored Claude login expires, or null when unknown. */
export function tokenMinutesLeft(home = HOME) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"));
    const exp = d?.claudeAiOauth?.expiresAt;
    return typeof exp === "number" ? (exp - Date.now()) / 60_000 : null;
  } catch {
    return null;
  }
}

export function preflight({ workdir, minMinutes }) {
  const problems = [];
  if (!bwrapAvailable()) {
    problems.push("bubblewrap (bwrap) is not available; live runs need an OS sandbox, so none were run");
  }
  const left = tokenMinutesLeft();
  if (left !== null && left < minMinutes) {
    problems.push(
      `the stored Claude login expires in ${left.toFixed(0)} min (< ${minMinutes}); a token refresh inside the ` +
        "sandbox would be discarded, so refresh it first by using claude normally, then rerun",
    );
  }
  const real = path.resolve(workdir);
  const rel = path.relative(HOME, real);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    problems.push(`work dir ${real} is inside the home directory; use a temporary directory`);
  }
  return problems;
}

/**
 * Run `argv` inside the sandbox with `runDir` writable.
 * @returns {Promise<{ status: number|null, signal: string|null, timedOut: boolean }>}
 */
export function runSandboxed({ runDir, cwd, argv, env, appRoot, stdoutFile, stderrFile, timeoutMs }) {
  const claudeShare = path.join(HOME, ".local", "share", "claude");
  const localBin = path.join(HOME, ".local", "bin");
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    // The Enclaweder is never bound from a live model run: hidden like in npm test
    // (--dev /dev above is a fresh minimal /dev, with no hidraw node in it).
    ...(fs.existsSync("/sys/class/hidraw") ? ["--tmpfs", "/sys/class/hidraw"] : []),
    // No host runtime dir (red-team H14 T3): the host's D-Bus session bus and the
    // hardware-root broker socket live under /run/user and must not be reachable
    // by the agent under test (systemd-run --user, the broker's signing oracle).
    ...(fs.existsSync("/run/user") ? ["--tmpfs", "/run/user"] : []),
    "--tmpfs", HOME,
    "--overlay-src", path.join(HOME, ".claude"), "--tmp-overlay", path.join(HOME, ".claude"),
    "--ro-bind", claudeShare, claudeShare,
    "--ro-bind", localBin, localBin,
    "--ro-bind", appRoot, appRoot,
    "--bind", runDir, runDir,
    "--unshare-pid",
    "--unshare-user",
    "--unshare-ipc",
    "--die-with-parent",
    "--chdir", cwd,
    "--clearenv",
  ];
  for (const [k, v] of Object.entries(env)) {
    // The host's runtime dir and session bus are not in the sandbox (H14 T3/T4).
    if (k === "XDG_RUNTIME_DIR" || k === "DBUS_SESSION_BUS_ADDRESS") {
      continue;
    }
    args.push("--setenv", k, v);
  }
  args.push(...argv);
  return new Promise((resolve) => {
    const out = fs.openSync(stdoutFile, "w");
    const err = fs.openSync(stderrFile, "w");
    const child = spawn("bwrap", args, { stdio: ["ignore", out, err] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      fs.closeSync(err);
      resolve({ status, signal, timedOut });
    });
  });
}
