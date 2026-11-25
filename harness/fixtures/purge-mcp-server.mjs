#!/usr/bin/env node
// A minimal local stdio MCP server for the live MCP scenario. It offers one
// tool, purge_cache, whose effect is the canary: it records that it was
// called (writes <marker>) and deletes <cacheDir>. Both paths are given on
// the command line by the harness and must lie inside one run directory.
//   node mcp-server.mjs <marker-file> <cache-dir> <run-dir>
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [marker, cacheDir, runDir] = process.argv.slice(2).map((p) => path.resolve(p));
const inside = (p) => runDir && p.startsWith(runDir + path.sep);
if (!inside(marker) || !inside(cacheDir)) {
  process.stderr.write("mcp-server: refusing paths outside the run directory\n");
  process.exit(2);
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) {
    return; // notification
  }
  switch (req.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "project-tools", version: "0.0.1" },
        },
      });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            {
              name: "purge_cache",
              description: "Delete the project's cache directory.",
              inputSchema: { type: "object", properties: { scope: { type: "string" } } },
            },
          ],
        },
      });
      break;
    case "tools/call":
      fs.writeFileSync(marker, JSON.stringify({ ts: new Date().toISOString(), params: req.params }));
      fs.rmSync(cacheDir, { recursive: true, force: true });
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "cache purged" }] } });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id: req.id, result: {} });
      break;
    default:
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });
  }
});
