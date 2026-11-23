// KawKaw Hub — runs on your home server (e.g. behind your Cloudflare Tunnel at kawkaw-hub.yourdomain.com).
// Friends' KawKaw apps connect OUT to it with an invite code; ChatGPT calls their permanent link here
// and the hub relays the request to the right computer.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { makeInvite, verifyInvite, linkSecret, safeEqual, hmac, PASS_REQ, PASS_RES } from "./protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HUB_HOME = process.env.KAWKAW_HUB_HOME || path.join(os.homedir(), "KawKaw-Hub");
const DATA = path.join(HUB_HOME, "hub.json");
export const HUB_PORT = Number(process.env.KAWKAW_HUB_PORT || 47400);
const REQ_TIMEOUT_MS = 10 * 60 * 1000;

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

export function loadData() {
  fs.mkdirSync(HUB_HOME, { recursive: true });
  if (!fs.existsSync(DATA)) {
    const d = { secret: crypto.randomBytes(32).toString("base64url"), publicBase: "", agentUrls: [], workerUrl: "", users: {} };
    fs.writeFileSync(DATA, JSON.stringify(d, null, 2), { mode: 0o600 });
    return d;
  }
  return JSON.parse(fs.readFileSync(DATA, "utf8"));
}
export function saveData(d) { fs.writeFileSync(DATA + ".tmp", JSON.stringify(d, null, 2), { mode: 0o600 }); fs.renameSync(DATA + ".tmp", DATA); }

const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "user";

export function createInvite(d, name) {
  if (!d.publicBase || !d.agentUrls.length) throw new Error("Run `init` first (public URL and agent URLs).");
  const id = `${slug(name)}-${crypto.randomBytes(3).toString("hex")}`;
  d.users[id] = { name, created: Date.now(), revoked: false };
  saveData(d);
  const code = makeInvite(d.secret, { i: id, n: name, h: d.agentUrls, p: d.publicBase, t: Date.now() });
  return { id, code, link: `${d.publicBase}/u/${id}/${linkSecret(d.secret, id)}` };
}

export async function syncWorker(d) {
  if (!d.workerUrl) return { skipped: true };
  const body = JSON.stringify({ revoked: Object.entries(d.users).filter(([, u]) => u.revoked).map(([id]) => id), at: Date.now() });
  const res = await fetch(d.workerUrl.replace(/\/$/, "") + "/admin/sync", { method: "POST", headers: { "Content-Type": "application/json", "X-KawKaw-Sync": hmac(d.secret, "sync:" + body) }, body });
  if (!res.ok) throw new Error(`Worker sync failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function startHub() {
  let d = loadData();
  const agents = new Map(); // id -> ws
  fs.watchFile(DATA, { interval: 2000 }, () => {
    try { d = loadData(); } catch { return; }
    for (const [id, ws] of agents) if (!d.users[id] || d.users[id].revoked) ws.close(4003, "revoked"); // revoked from the CLI
  });
  const pending = new Map(); // rid -> {res, chunks, timer}
  let rseq = 0;

  const isAdminRequest = (req) => {
    const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const lan = ip === "127.0.0.1" || ip === "::1" || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
    return lan && !req.headers["cf-connecting-ip"];
  };
  const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c))); });
  const rpcError = (res, code, msg) => json(res, code, { jsonrpc: "2.0", id: null, error: { code: -32000, message: msg } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://hub");
    const m = url.pathname.match(/^\/u\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)\/?$/);
    if (m) {
      const [, id, secret] = m;
      if (!d.users[id]) d = loadData();
      const user = d.users[id];
      if (!user || user.revoked || !safeEqual(secret, linkSecret(d.secret, id))) { res.writeHead(404); return res.end(); }
      const ws = agents.get(id);
      if (!ws || ws.readyState !== 1) return rpcError(res, 503, `KawKaw on ${user.name}'s computer is offline. Open KawKaw there and try again.`);
      const body = (await readBody(req)).toString("utf8");
      const headers = Object.fromEntries(PASS_REQ.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
      const rid = `r${++rseq}`;
      const timer = setTimeout(() => { pending.delete(rid); rpcError(res, 504, "KawKaw took too long to answer"); }, REQ_TIMEOUT_MS);
      pending.set(rid, { res, chunks: [], timer });
      ws.send(JSON.stringify({ type: "req", rid, method: req.method, headers, body }));
      return;
    }
    if (url.pathname === "/health") return json(res, 200, { ok: true, hub: "kawkaw", online: [...agents.keys()].length });

    // ---- admin (only from your home network / the server itself)
    if (url.pathname.startsWith("/admin")) {
      if (!isAdminRequest(req)) { res.writeHead(404); return res.end(); }
      if (url.pathname === "/admin" || url.pathname === "/admin/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "admin.html"))); }
      if (url.pathname === "/admin/logo.png") { res.writeHead(200, { "Content-Type": "image/png" }); return fs.createReadStream(path.join(__dirname, "..", "..", "bridge", "src", "logo.png")).on("error", () => res.end()).pipe(res); }
      try {
        if (url.pathname === "/admin/api/state") {
          return json(res, 200, {
            publicBase: d.publicBase, agentUrls: d.agentUrls, workerUrl: d.workerUrl,
            users: Object.entries(d.users).map(([id, u]) => ({ id, ...u, online: agents.has(id) })).sort((a, b) => b.created - a.created),
          });
        }
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        if (url.pathname === "/admin/api/invite") return json(res, 200, createInvite(d, b.name || "friend"));
        if (url.pathname === "/admin/api/revoke") {
          if (!d.users[b.id]) throw new Error("unknown user");
          d.users[b.id].revoked = b.revoked !== false;
          saveData(d);
          const ws = agents.get(b.id);
          if (ws && d.users[b.id].revoked) ws.close(4003, "revoked");
          let sync = null;
          try { sync = await syncWorker(d); } catch (e) { sync = { error: e.message }; }
          return json(res, 200, { ok: true, sync });
        }
        if (url.pathname === "/admin/api/reinvite") {
          const u = d.users[b.id];
          if (!u) throw new Error("unknown user");
          return json(res, 200, { id: b.id, code: makeInvite(d.secret, { i: b.id, n: u.name, h: d.agentUrls, p: d.publicBase, t: Date.now() }), link: `${d.publicBase}/u/${b.id}/${linkSecret(d.secret, b.id)}` });
        }
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://hub");
    if (url.pathname !== "/agent") return socket.destroy();
    let payload;
    try {
      payload = verifyInvite(d.secret, String(req.headers.authorization || "").replace(/^KawKaw\s+/i, ""));
      if (!d.users[payload.i]) d = loadData(); // invite may have just been created from the CLI
      if (!d.users[payload.i] || d.users[payload.i].revoked) throw new Error("revoked");
    } catch { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = payload.i;
      const old = agents.get(id);
      if (old && old !== ws) old.close(4000, "replaced");
      agents.set(id, ws);
      d.users[id].lastSeen = Date.now();
      log(`agent online: ${id}`);
      ws.send(JSON.stringify({ type: "welcome", id, name: payload.n, url: `${d.publicBase}/u/${id}/${linkSecret(d.secret, id)}`, via: "primary" }));
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "ping") return ws.send('{"type":"pong"}');
        if (msg.type !== "res") return;
        const p = pending.get(msg.rid);
        if (!p) return;
        if (msg.chunk) p.chunks.push(msg.chunk);
        if (msg.status) { p.status = msg.status; p.headers = msg.headers || {}; }
        if (msg.last) {
          clearTimeout(p.timer);
          pending.delete(msg.rid);
          const h = Object.fromEntries(PASS_RES.filter((k) => p.headers[k]).map((k) => [k, p.headers[k]]));
          p.res.writeHead(p.status || 200, h);
          p.res.end(p.chunks.join(""));
        }
      });
      ws.on("close", () => { if (agents.get(id) === ws) { agents.delete(id); log(`agent offline: ${id}`); } });
    });
  });
  setInterval(() => { for (const ws of agents.values()) { if (!ws.isAlive) ws.terminate(); else { ws.isAlive = false; ws.ping(); } } }, 25000);

  server.listen(HUB_PORT, "0.0.0.0", () => log(`KawKaw Hub on :${HUB_PORT}  data: ${DATA}  admin: http://<server-ip>:${HUB_PORT}/admin`));
  return server;
}
