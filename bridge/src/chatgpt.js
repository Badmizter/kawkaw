// ChatGPT / ChatGPT Atlas support.
// ChatGPT only talks to MCP servers on the public internet over HTTPS, so KawKaw:
//   1. serves the same tools over Streamable HTTP at /mcp/<secret>
//   2. opens a Cloudflare tunnel to get a public https:// address (free, no account),
//      or uses your own Cloudflare tunnel token + domain for a link that never changes.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { DIRS } from "./config.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./tools.js";
import { startHub, stopHub, hubState } from "./hubclient.js";

let tunnel = null;
let state = { status: "off", publicUrl: null, error: null };

export function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
}

export const newToken = () => crypto.randomBytes(18).toString("base64url");

export function chatgptInfo(cfg) {
  const c = cfg.chatgpt;
  if (c.mode === "hub") {
    const h = hubState();
    const online = h.connections.filter((x) => x.state === "online").length;
    return {
      enabled: c.enabled, mode: c.mode, hub: h, lanIps: lanIps(), serverPort: c.serverPort, allowedIps: c.allowedIps,
      status: !c.enabled ? "off" : state.error ? "error" : online ? "ready" : "connecting",
      error: state.error || (c.enabled && !online && h.connections.find((x) => x.error)?.error) || null,
      connectorUrl: c.enabled ? h.link : null,
    };
  }
  const own = c.mode === "custom" || c.mode === "server";
  const base = !c.enabled ? null : own ? c.customUrl?.replace(/\/$/, "") || null : state.status === "ready" ? state.publicUrl : null;
  return {
    enabled: c.enabled,
    mode: c.mode,
    status: state.status,
    error: state.error,
    connectorUrl: base ? `${base}/mcp/${c.token}` : null,
    lanIps: lanIps(),
    serverPort: c.serverPort,
    allowedIps: c.allowedIps,
  };
}

export async function startTunnel(cfg, port, log, onChange) {
  await stopTunnel();
  stopHub();
  const c = cfg.chatgpt;
  if (c.enabled && c.mode === "hub") {
    try {
      if (!c.hubInvite) throw new Error("Paste the invite code you got from the hub owner.");
      startHub({ invite: c.hubInvite, localUrl: `http://127.0.0.1:${port}/mcp/${c.token}`, log, onChange });
      state = { status: "ready", publicUrl: null, error: null };
    } catch (e) { state = { status: "error", publicUrl: null, error: e.message }; }
    onChange?.(); return;
  }
  if (!c.enabled) { state = { status: "off", publicUrl: null, error: null }; onChange?.(); return; }
  if (c.mode === "server") {
    const missing = !c.allowedIps?.length ? "Add your server's address (e.g. 10.0.0.9)." : !c.customUrl ? "Add the public URL (e.g. https://kawkaw.nelsonmaita.com)." : null;
    state = { status: missing ? "error" : "ready", publicUrl: null, error: missing };
    onChange?.(); return;
  }
  if (c.mode === "custom" && !c.tunnelToken) { state = { status: "ready", publicUrl: null, error: null }; onChange?.(); return; } // you run your own tunnel/proxy

  state = { status: "starting", publicUrl: null, error: null };
  onChange?.();
  try {
    const cf = await import("cloudflared");
    if (!fs.existsSync(cf.bin)) {
      // the app folder may be read-only (e.g. /Applications), so keep our own copy in ~/KawKaw/bin
      const own = path.join(DIRS.root, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
      if (!fs.existsSync(own)) { log("downloading cloudflared…"); fs.mkdirSync(path.dirname(own), { recursive: true }); await cf.install(own); }
      cf.use(own);
    }
    tunnel = c.mode === "custom" ? cf.Tunnel.withToken(c.tunnelToken) : cf.Tunnel.quick(`http://127.0.0.1:${port}`);
    tunnel.on("url", (url) => { if (c.mode !== "custom" && /^https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com$/.test(url)) { state.publicUrl = url; state.status = "ready"; log("ChatGPT tunnel: " + url); onChange?.(); } });
    tunnel.on("connected", () => { if (c.mode === "custom") { state.status = "ready"; onChange?.(); } });
    tunnel.on("error", (e) => { state.error = String(e?.message || e); log("tunnel error: " + state.error); onChange?.(); });
    tunnel.on("exit", (code) => { if (tunnel) { state.status = "error"; state.publicUrl = null; state.error = `Could not reach Cloudflare (code ${code}). Check your internet connection, then turn ChatGPT off and on.`; tunnel = null; onChange?.(); } });
  } catch (e) {
    state = { status: "error", publicUrl: null, error: e.message };
    log("tunnel failed: " + e.message);
    onChange?.();
  }
}

export async function stopTunnel() {
  const t = tunnel;
  tunnel = null;
  if (t) try { t.stop(); } catch {}
  state.publicUrl = null;
}

/** Handle one HTTP request on /mcp/<token>. Stateless: a fresh server per request. */
export async function handleMcpHttp(req, res, body, call) {
  const server = createServer(call, { client: "chatgpt" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
