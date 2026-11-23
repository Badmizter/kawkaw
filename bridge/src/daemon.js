// KawKaw daemon: one local hub on 127.0.0.1 that Premiere, After Effects tools, the settings page and Claude all talk to.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig, saveConfig, publicConfig, DIRS, HOME_DIR, PORT, CONFIG_PATH } from "./config.js";
import { detectSilence } from "./silence.js";
import { generateForGap, testProvider } from "./ai.js";
import { planAutoEdit, scanFolder } from "./autoedit.js";
import { runAEScript, buildRangeCompScript } from "./ae.js";
import { chatgptInfo, startTunnel, handleMcpHttp, newToken } from "./chatgpt.js";
import { readInvite } from "./hubclient.js";
import { sendMessage, resetSession, stopSession, assistantStatus, findClaudeCode } from "./assistant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAPS_PATH = path.join(HOME_DIR, "gaps.json");
const VERSION = "0.3.1";

let config = loadConfig();
const hosts = new Map(); // role -> ws  (premiere, ae)
const clients = new Set();
const pending = new Map(); // id -> {resolve, reject, timer}
let seq = 0;

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
  console.error(line);
  try { fs.appendFileSync(path.join(DIRS.logs, "bridge.log"), line + "\n"); } catch {}
};

// ---------------- gaps (AI fill jobs) ----------------
let gaps = {};
try { gaps = JSON.parse(fs.readFileSync(GAPS_PATH, "utf8")); } catch {}
const saveGaps = () => fs.writeFileSync(GAPS_PATH, JSON.stringify(gaps, null, 2));
const newId = () => "gap_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function broadcast(name, data) {
  const msg = JSON.stringify({ type: "event", name, data });
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}
function updateGap(id, patch) {
  gaps[id] = { ...gaps[id], ...patch, updatedAt: Date.now() };
  saveGaps();
  broadcast("gap", gaps[id]);
  return gaps[id];
}

function callHost(role, method, params, timeoutMs = 120000) {
  const ws = hosts.get(role);
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error(`${role === "premiere" ? "Premiere Pro" : role} is not connected. Open Window > UXP Plugins > KawKaw in Premiere.`));
  const id = `d${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${role}.${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "call", id, method, params }));
  });
}

const runTokens = {}; // id -> token of the current run (a new Generate replaces the old run)
async function runGeneration(id) {
  const gap = gaps[id];
  if (!gap) throw new Error("Unknown gap " + id);
  const token = (runTokens[id] = Math.random().toString(36).slice(2));
  const current = () => runTokens[id] === token;
  updateGap(id, { status: "generating", error: null, progress: "starting", cancelled: false, runProvider: gap.provider || config.ai.defaultProvider });
  try {
    const file = await generateForGap(config, gaps[id], (p) => current() && updateGap(id, { progress: p }), () => !current() || !!gaps[id]?.cancelled);
    if (!current()) return;
    updateGap(id, { status: "ready", videoPath: file, progress: "done" });
    log("gap ready", id, file);
    if (hosts.has("premiere")) {
      try {
        await callHost("premiere", "placeGapClip", { gap: gaps[id] });
        updateGap(id, { status: "placed" });
      } catch (e) {
        updateGap(id, { error: "Generated, but could not place: " + e.message });
      }
    }
  } catch (e) {
    if (!current()) return; // replaced by a newer run
    log("gap failed", id, e.message);
    updateGap(id, { status: e.message === "cancelled" ? "cancelled" : "failed", error: e.message === "cancelled" ? null : e.message });
  }
}

// ---------------- bridge methods ----------------
const bridge = {
  ping: () => ({ ok: true, version: VERSION, hosts: [...hosts.keys()], home: HOME_DIR, platform: process.platform }),
  getConfig: () => publicConfig(config),
  reloadConfig: () => { config = loadConfig(); broadcast("config", publicConfig(config)); return true; },
  savePresets: ({ presets }) => { config.presets = presets; saveConfig(config); broadcast("config", publicConfig(config)); return true; },
  savePreset: ({ name, preset }) => { config.presets[name] = preset; saveConfig(config); broadcast("config", publicConfig(config)); return config.presets[name]; },
  deletePreset: ({ name }) => { delete config.presets[name]; saveConfig(config); broadcast("config", publicConfig(config)); return true; },
  saveButtons: ({ buttons }) => { config.buttons = buttons; saveConfig(config); broadcast("config", publicConfig(config)); return true; },
  detectSilence: (p) => detectSilence({ ...config.silence, ...p }),
  planAutoEdit: (p) => planAutoEdit(p),
  scanFolder: ({ path: p }) => scanFolder(p),
  framesDir: () => ({ dir: DIRS.frames, sep: path.sep }),
  waitForFile: async ({ path: p, timeoutMs = 20000 }) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) { await new Promise((r) => setTimeout(r, 250)); return true; }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("File was not written: " + p);
  },
  fileExists: ({ path: p }) => fs.existsSync(p),

  createGap: (p) => {
    const id = newId();
    gaps[id] = {
      id, createdAt: Date.now(), status: "draft", prompt: "", provider: config.ai.defaultProvider,
      sequenceName: p.sequenceName, sequenceGuid: p.sequenceGuid, inSec: p.inSec, outSec: p.outSec,
      durationSec: Math.max(0.04, (p.outSec ?? 0) - (p.inSec ?? 0)), firstFrame: p.firstFrame || null, lastFrame: p.lastFrame || null,
      videoTrack: p.videoTrack ?? config.gapFill.videoTrack, audioTrack: p.audioTrack ?? config.gapFill.audioTrack,
    };
    saveGaps(); broadcast("gap", gaps[id]);
    return gaps[id];
  },
  updateGap: ({ id, ...patch }) => {
    if (!gaps[id]) throw new Error("Unknown gap " + id);
    const allowed = ["prompt", "firstFrame", "lastFrame", "provider", "videoTrack", "audioTrack", "inSec", "outSec", "extraParams", "notes"];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    for (const k of ["firstFrame", "lastFrame"]) if (clean[k] && !fs.existsSync(clean[k])) throw new Error(`${k} file not found: ${clean[k]}`);
    if (clean.inSec != null || clean.outSec != null) {
      const g = { ...gaps[id], ...clean };
      clean.durationSec = Math.max(0.04, g.outSec - g.inSec);
    }
    return updateGap(id, clean);
  },
  listGaps: () => Object.values(gaps).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
  getGap: ({ id }) => gaps[id] || null,
  deleteGap: ({ id }) => { delete runTokens[id]; delete gaps[id]; saveGaps(); broadcast("gapDeleted", { id }); return true; },
  generateGap: ({ id, prompt, provider }) => {
    if (!gaps[id]) throw new Error("Unknown gap " + id);
    // A Manual run just waits for a file, so pressing Generate again simply restarts it (e.g. with Kling).
    // API runs are already paid for, so those are not restarted.
    if (gaps[id].status === "generating" && gaps[id].runProvider && gaps[id].runProvider !== "manual") throw new Error("Already generating with " + gaps[id].runProvider + ". Wait for it to finish, or Delete this AI clip and make a new one.");
    if (prompt != null) updateGap(id, { prompt });
    if (provider) updateGap(id, { provider });
    runGeneration(id); // background
    return gaps[id];
  },
  openGapFolder: async ({ id }) => {
    const { spawn } = await import("node:child_process");
    const dir = id && gaps[id] ? path.join(DIRS.inbox, id) : DIRS.root;
    fs.mkdirSync(dir, { recursive: true });
    const cmd = process.platform === "win32" ? ["explorer", [dir]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
    return dir;
  },
  cancelGap: ({ id }) => { if (gaps[id]) { gaps[id].cancelled = true; delete runTokens[id]; updateGap(id, { status: "cancelled" }); } return true; },
  placeGap: async ({ id }) => {
    const g = gaps[id];
    if (!g?.videoPath) throw new Error("This gap has no generated video yet.");
    const r = await callHost("premiere", "placeGapClip", { gap: g });
    updateGap(id, { status: "placed" });
    return r;
  },

  assistantStatus: () => assistantStatus(config),
  assistantSend: ({ sessionId, text }) => {
    if (!text?.trim()) throw new Error("Type a message first.");
    const sid = sessionId || "panel";
    sendMessage(config, localCall, { sessionId: sid, text }, (ev) => broadcast("assistant", { sessionId: sid, ...ev }))
      .catch((e) => { broadcast("assistant", { sessionId: sid, type: "error", text: e.message }); broadcast("assistant", { sessionId: sid, type: "done" }); });
    return { started: true, mode: assistantStatus(config).mode };
  },
  assistantStop: ({ sessionId }) => stopSession(sessionId || "panel"),
  assistantReset: ({ sessionId }) => { resetSession(sessionId || "panel"); return true; },
  aeRun: ({ code, timeoutMs }) => runAEScript(config, code, { timeoutMs }),
  aeSendRange: (range) => runAEScript(config, buildRangeCompScript(range)),
};

async function handleCall(ws, msg) {
  const reply = (ok, dataOrErr) => ws.readyState === 1 && ws.send(JSON.stringify(ok ? { type: "result", id: msg.id, ok, data: dataOrErr } : { type: "result", id: msg.id, ok, error: String(dataOrErr?.message || dataOrErr) }));
  try {
    if (msg.target === "bridge" || !msg.target) {
      const fn = bridge[msg.method];
      if (!fn) throw new Error("Unknown bridge method: " + msg.method);
      reply(true, await fn(msg.params || {}));
    } else {
      reply(true, await callHost(msg.target, msg.method, msg.params || {}, msg.timeoutMs));
    }
  } catch (e) {
    log("call failed", msg.target || "bridge", msg.method, e.message);
    reply(false, e);
  }
}

// Same routing the WebSocket clients get, for the in-process ChatGPT MCP server.
async function localCall(target, method, params = {}, timeoutMs) {
  if (!target || target === "bridge") {
    const fn = bridge[method];
    if (!fn) throw new Error("Unknown bridge method: " + method);
    return fn(params);
  }
  return callHost(target, method, params, timeoutMs);
}
async function handleMcpRoute(req, res, url) {
  const mcpMatch = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]+)\/?$/);
  if (!mcpMatch) return false;
  const given = Buffer.from(mcpMatch[1]), want = Buffer.from(config.chatgpt.token || "");
  const ok = config.chatgpt.enabled && want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) { res.writeHead(404); res.end(); return true; }
  try {
    const raw = req.method === "POST" ? await readBody(req) : "";
    await handleMcpHttp(req, res, raw ? JSON.parse(raw) : undefined, localCall);
  } catch (e) {
    log("chatgpt mcp error", e.message);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
  return true;
}

// "Through my home server" mode: a second listener on the LAN that ONLY serves /mcp/<secret>
// and ONLY to the server's IP address(es).
let lanServer = null;
const cleanIp = (a) => String(a || "").replace(/^::ffff:/, "");
function syncLanServer() {
  const c = config.chatgpt;
  const want = c.enabled && c.mode === "server" && c.allowedIps?.length;
  if (lanServer && (!want || lanServer.port !== c.serverPort)) { lanServer.close(); lanServer = null; log("LAN listener stopped"); }
  if (!want || lanServer) return;
  lanServer = http.createServer(async (req, res) => {
    if (!config.chatgpt.allowedIps.map(String).includes(cleanIp(req.socket.remoteAddress))) { res.writeHead(403); return res.end(); }
    const url = new URL(req.url, "http://lan");
    if (!(await handleMcpRoute(req, res, url))) { res.writeHead(404); res.end(); }
  });
  lanServer.port = c.serverPort;
  lanServer.on("error", (e) => log("LAN listener error: " + e.message));
  lanServer.listen(c.serverPort, "0.0.0.0", () => log(`LAN listener on :${c.serverPort} for ${c.allowedIps.join(", ")}`));
}
const restartTunnel = async () => { syncLanServer(); await startTunnel(config, PORT, log, () => broadcast("chatgpt", chatgptInfo(config))); };

// ---------------- HTTP (settings page + frame previews) ----------------
function isLocalRequest(req) {
  const host = (req.headers.host || "").toLowerCase();
  const viaTunnel = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"];
  const ip = cleanIp(req.socket.remoteAddress);
  const loopback = ip === "127.0.0.1" || ip === "::1";
  return loopback && !viaTunnel && (host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`);
}
function sendJson(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // ChatGPT endpoint: the only thing reachable through the public tunnel.
  if (await handleMcpRoute(req, res, url)) return;
  // Everything else is local-only (blocks the tunnel and DNS-rebinding tricks).
  if (!isLocalRequest(req)) { res.writeHead(404); return res.end(); }

  // Block other websites from driving the bridge through the browser.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) && req.method !== "GET") return sendJson(res, 403, { error: "forbidden origin" });

  if (url.pathname === "/" || url.pathname === "/settings") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "settings.html")));
  }
  if (url.pathname === "/logo.png") { res.writeHead(200, { "Content-Type": "image/png" }); return fs.createReadStream(path.join(__dirname, "logo.png")).pipe(res); }
  if (url.pathname === "/api/status") return sendJson(res, 200, bridge.ping());
  if (url.pathname === "/api/shutdown" && req.method === "POST") { sendJson(res, 200, { ok: true }); log("shutting down"); setTimeout(() => process.exit(0), 200); return; }
  if (url.pathname === "/api/assistant" && req.method === "GET") { findClaudeCode(true); return sendJson(res, 200, assistantStatus(config)); }
  if (url.pathname === "/api/test-provider" && req.method === "POST") {
    const { provider } = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await testProvider(config, provider));
  }
  if (url.pathname === "/api/chatgpt" && req.method === "GET") return sendJson(res, 200, chatgptInfo(config));
  if (url.pathname === "/api/chatgpt" && req.method === "POST") {
    try {
      const b = JSON.parse((await readBody(req)) || "{}");
      const c = config.chatgpt;
      if (typeof b.enabled === "boolean") c.enabled = b.enabled;
      if (["quick", "custom", "server", "hub"].includes(b.mode)) c.mode = b.mode;
      if (typeof b.hubInvite === "string" && b.hubInvite.trim() && !b.hubInvite.startsWith("••••")) { readInvite(b.hubInvite); c.hubInvite = b.hubInvite.trim(); }
      if (b.allowedIps != null) c.allowedIps = (Array.isArray(b.allowedIps) ? b.allowedIps : String(b.allowedIps).split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean);
      if (b.serverPort) c.serverPort = Number(b.serverPort);
      if (typeof b.customUrl === "string") c.customUrl = b.customUrl.trim();
      if (typeof b.tunnelToken === "string" && !b.tunnelToken.startsWith("••••")) c.tunnelToken = b.tunnelToken.trim();
      if (b.rotate) c.token = newToken();
      saveConfig(config);
      await restartTunnel();
      return sendJson(res, 200, chatgptInfo(config));
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (url.pathname === "/api/config" && req.method === "GET") return sendJson(res, 200, publicConfig(config));
  if (url.pathname === "/api/config" && req.method === "POST") {
    try {
      const incoming = JSON.parse(await readBody(req));
      const keep = (newV, oldV) => (typeof newV === "string" && newV.startsWith("••••") ? oldV : newV);
      incoming.ai.higgsfield.keyId = keep(incoming.ai.higgsfield.keyId, config.ai.higgsfield.keyId);
      incoming.ai.higgsfield.keySecret = keep(incoming.ai.higgsfield.keySecret, config.ai.higgsfield.keySecret);
      incoming.ai.kling.apiKey = keep(incoming.ai.kling.apiKey, config.ai.kling.apiKey);
      incoming.chatgpt = config.chatgpt; // managed through /api/chatgpt
      if (incoming.assistant) incoming.assistant.apiKey = keep(incoming.assistant.apiKey, config.assistant.apiKey);
      config = incoming;
      saveConfig(config);
      broadcast("config", publicConfig(config));
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (url.pathname === "/frame") {
    const p = url.searchParams.get("path") || "";
    const allowed = Object.values(gaps).some((g) => g.firstFrame === p || g.lastFrame === p) || p.startsWith(DIRS.frames);
    if (!allowed || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": /\.png$/i.test(p) ? "image/png" : "image/jpeg", "Cache-Control": "no-store" });
    return fs.createReadStream(p).pipe(res);
  }
  res.writeHead(404); res.end("not found");
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  if (!isLocalRequest(req)) { ws.close(1008, "local only"); return; }
  const origin = req.headers.origin;
  if (origin && !/^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|file:\/\/|null|uxp:\/\/.*)$/.test(origin)) { ws.close(1008, "origin"); return; }
  clients.add(ws);
  ws.role = "client";
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "hello") {
      ws.role = msg.role || "client";
      if (msg.role === "premiere" || msg.role === "ae") { hosts.set(msg.role, ws); log(`${msg.role} connected (${msg.version || "?"})`); broadcast("hosts", [...hosts.keys()]); }
      ws.send(JSON.stringify({ type: "welcome", version: VERSION, config: publicConfig(config) }));
    } else if (msg.type === "call") {
      handleCall(ws, msg);
    } else if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error)); }
    }
  });
  ws.on("close", () => {
    clients.delete(ws);
    if (hosts.get(ws.role) === ws) { hosts.delete(ws.role); log(`${ws.role} disconnected`); broadcast("hosts", [...hosts.keys()]); }
  });
});

export function startDaemon() {
  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE") { log(`KawKaw already running on port ${PORT}`); resolve(false); }
      else reject(e);
    });
    server.listen(PORT, "127.0.0.1", () => {
      log(`KawKaw ${VERSION} listening on http://127.0.0.1:${PORT}  (data: ${HOME_DIR})`);
      // resume interrupted jobs
      if (config.chatgpt.enabled) restartTunnel();
      // pick up hand edits to config.json
      fs.watchFile(CONFIG_PATH, { interval: 1500 }, () => {
        try { config = loadConfig(); broadcast("config", publicConfig(config)); log("config reloaded"); } catch (e) { log(e.message); }
      });
      // (API jobs are not re-submitted automatically so you are never billed twice)
      for (const g of Object.values(gaps)) {
        if (g.status !== "generating") continue;
        if (g.provider === "manual") runGeneration(g.id);
        else updateGap(g.id, { status: "failed", error: "Bridge restarted during generation. Check your provider dashboard, or press Generate to retry." });
      }
      resolve(true);
    });
  });
}
