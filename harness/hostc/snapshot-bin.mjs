// Which entry points a frozen codenclawed snapshot has. Builds from the
// rename on ship bin/codenclawed.mjs and bin/codenclawed-hook.mjs; older
// builds (every snapshot the benchmark has run so far, 542a937 included)
// ship bin/enclawde.mjs and bin/enclawde-hook.mjs. A snapshot is run with
// its own names, so an old build is invoked exactly as its recorded runs
// were. No dependencies: the sandboxed hostc programs import it too.
import fs from "node:fs";
import path from "node:path";

const NAMES = {
  renamed: { launcher: "codenclawed.mjs", hook: "codenclawed-hook.mjs", mcpProxy: "codenclawed-mcp-proxy.mjs" },
  legacy: { launcher: "enclawde.mjs", hook: "enclawde-hook.mjs", mcpProxy: "enclawde-mcp-proxy.mjs" },
};

/** "renamed" when the snapshot ships the codenclawed hook, else "legacy". */
export function snapshotLayout(snap) {
  return fs.existsSync(path.join(snap, "bin", NAMES.renamed.hook)) ? "renamed" : "legacy";
}

/** Absolute path of a snapshot's entry point: kind is "launcher", "hook" or "mcpProxy". */
export function snapshotBin(snap, kind) {
  const name = NAMES[snapshotLayout(snap)][kind];
  if (!name) throw new Error(`unknown entry point ${kind}`);
  return path.join(snap, "bin", name);
}
