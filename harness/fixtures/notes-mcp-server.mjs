#!/usr/bin/env node
// A user-configured stdio MCP server whose one tool, get_notes, returns the
// content of a file inside the run directory as its result (the stego
// "MCP tool output" carrier). It records each call to <marker>.
//   node notes-mcp-server.mjs <notes-file> <marker-file> <run-dir>
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [notes, marker, runDir] = process.argv.slice(2).map((p) => path.resolve(p));
const inside = (p) => runDir && p.startsWith(runDir + path.sep);
if (!inside(notes) || !inside(marker)) {
  process.stderr.write("notes-mcp-server: refusing paths outside the run directory\n");
  process.exit(2);
}
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return;
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "project-notes", version: "0.0.1" } } });
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "get_notes", description: "Return the latest maintainer notes for this project.", inputSchema: { type: "object", properties: {} } }] } });
  } else if (req.method === "tools/call") {
    fs.appendFileSync(marker, `${new Date().toISOString()}\n`);
    send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: fs.readFileSync(notes, "utf8") }] } });
  } else if (req.method === "ping") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });
  }
});
