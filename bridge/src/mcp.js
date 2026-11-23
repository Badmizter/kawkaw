// MCP server Claude launches (stdio). It forwards everything to the KawKaw daemon, starting it if needed.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createServer } from "./tools.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PORT } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let ws = null;
let seq = 0;
const pending = new Map();

function connectOnce() {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}`);
    s.once("open", () => { s.send(JSON.stringify({ type: "hello", role: "mcp" })); resolve(s); });
    s.once("error", reject);
    s.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "result" && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.ok ? p.resolve(m.data) : p.reject(new Error(m.error));
      }
    });
    s.on("close", () => { if (ws === s) ws = null; for (const p of pending.values()) p.reject(new Error("bridge connection closed")); pending.clear(); });
  });
}

async function ensureConnected() {
  if (ws && ws.readyState === 1) return ws;
  try { ws = await connectOnce(); return ws; } catch {}
  // start the daemon in the background and retry
  const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "daemon"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { ws = await connectOnce(); return ws; } catch {}
  }
  throw new Error("Could not start the KawKaw daemon.");
}

async function call(target, method, params = {}, timeoutMs) {
  const s = await ensureConnected();
  const id = `m${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    s.send(JSON.stringify({ type: "call", id, target, method, params, timeoutMs }));
  });
}

export async function startMcp() {
  const server = createServer(call, { client: "claude" });
  await server.connect(new StdioServerTransport());
}
