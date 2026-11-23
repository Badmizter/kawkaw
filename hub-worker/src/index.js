// KawKaw Hub — Cloudflare Worker "front door" + backup relay.
//
// It answers ChatGPT on your public hostname (e.g. https://kawkaw.yourdomain.com):
//   1. If your home-server hub (ORIGIN) is up, the request goes there.
//   2. If the server is down (power cut, internet down, tunnel down), the Worker relays the
//      request itself to the friend's KawKaw, which keeps a backup connection open to this Worker.
// Runs on Cloudflare's network, so it keeps working when your power is out.

import { homePage } from "./home.js";
import LOGO from "./logo.js";

const PASS_REQ = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const PASS_RES = ["content-type", "mcp-session-id", "cache-control"];
const enc = new TextEncoder();

function b64url(buf) {
  let s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)));
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function safeEqual(a, b) {
  a = enc.encode(String(a)); b = enc.encode(String(b));
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}
async function verifyInvite(secret, code) {
  const p = String(code || "").trim().split(".");
  if (p.length !== 3 || p[0] !== "kk1") throw new Error("bad invite");
  if (!safeEqual(p[2], await hmac(secret, "invite:" + p[1]))) throw new Error("bad signature");
  return JSON.parse(fromB64url(p[1]));
}
const linkSecret = async (secret, id) => (await hmac(secret, "link:" + id)).slice(0, 32);
const rpcError = (status, message) => new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }), { status, headers: { "Content-Type": "application/json" } });

// Is the home server answering? Cached for a few seconds per Worker instance.
let health = { at: 0, up: false };
async function originUp(env) {
  if (!env.ORIGIN) return false;
  if (Date.now() - health.at < 5000) return health.up;
  let up = false;
  try {
    const r = await fetch(env.ORIGIN.replace(/\/$/, "") + "/health", { signal: AbortSignal.timeout(3500), cf: { cacheTtl: 0 } });
    up = r.ok && (await r.json()).hub === "kawkaw";
  } catch {}
  health = { at: Date.now(), up };
  return up;
}

async function revokedList(env) {
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  return (await reg.fetch("https://do/revoked")).json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(homePage(env), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    if (url.pathname === "/logo.png") return new Response(Uint8Array.from(atob(LOGO), (c) => c.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    if (url.pathname === "/health") return Response.json({ ok: true, hub: "kawkaw-backup", originUp: await originUp(env) });
    if (!env.HUB_SECRET) return new Response("HUB_SECRET is not set (wrangler secret put HUB_SECRET)", { status: 500 });

    // Friend's KawKaw opens its backup connection here.
    if (url.pathname === "/agent") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      let p;
      try { p = await verifyInvite(env.HUB_SECRET, (request.headers.get("Authorization") || "").replace(/^KawKaw\s+/i, "")); }
      catch { return new Response("unauthorized", { status: 401 }); }
      if ((await revokedList(env)).includes(p.i)) return new Response("revoked", { status: 401 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(p.i));
      const h = new Headers(request.headers);
      h.set("x-kk-id", p.i); h.set("x-kk-name", encodeURIComponent(p.n || p.i));
      h.set("x-kk-url", `${p.p}/u/${p.i}/${await linkSecret(env.HUB_SECRET, p.i)}`);
      return room.fetch(new Request("https://do/connect", { headers: h }));
    }

    // ChatGPT → friend
    const m = url.pathname.match(/^\/u\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)\/?$/);
    if (m) {
      const [, id, secret] = m;
      if (!safeEqual(secret, await linkSecret(env.HUB_SECRET, id))) return new Response(null, { status: 404 });
      const body = ["GET", "HEAD"].includes(request.method) ? null : await request.text();
      const headers = {};
      for (const k of PASS_REQ) if (request.headers.get(k)) headers[k] = request.headers.get(k);

      // 1) home server first
      if (await originUp(env)) {
        try {
          const r = await fetch(env.ORIGIN.replace(/\/$/, "") + url.pathname, { method: request.method, headers, body });
          // 503 = friend not connected to the server (maybe only to us); 5xx from Cloudflare = tunnel down.
          if (![502, 503, 520, 521, 522, 523, 524, 525, 526, 530].includes(r.status)) return r;
        } catch {}
        health = { at: Date.now(), up: false };
      }
      // 2) backup relay
      if ((await revokedList(env)).includes(id)) return new Response(null, { status: 404 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(id));
      return room.fetch(new Request("https://do/relay", { method: "POST", body: JSON.stringify({ method: request.method, headers, body: body || "" }) }));
    }

    // Revocations pushed from the home-server hub
    if (url.pathname === "/admin/sync" && request.method === "POST") {
      const raw = await request.text();
      if (!safeEqual(request.headers.get("X-KawKaw-Sync") || "", await hmac(env.HUB_SECRET, "sync:" + raw))) return new Response("forbidden", { status: 403 });
      const { revoked = [] } = JSON.parse(raw);
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
      await reg.fetch("https://do/revoked", { method: "PUT", body: JSON.stringify(revoked) });
      for (const id of revoked) await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch("https://do/kick", { method: "POST" });
      return Response.json({ ok: true, revoked: revoked.length });
    }
    return new Response("KawKaw", { status: 404 });
  },
};

// One Durable Object per friend: holds their backup WebSocket and relays ChatGPT requests to it.
export class AgentRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.pending = new Map();
    this.seq = 0;
    // answer keep-alive pings without waking the object up
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      for (const old of this.ctx.getWebSockets()) try { old.close(4000, "replaced"); } catch {}
      this.ctx.acceptWebSocket(server);
      const id = request.headers.get("x-kk-id");
      server.send(JSON.stringify({ type: "welcome", id, name: decodeURIComponent(request.headers.get("x-kk-name") || id), url: request.headers.get("x-kk-url"), via: "backup" }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/kick") {
      for (const ws of this.ctx.getWebSockets()) try { ws.close(4003, "revoked"); } catch {}
      return new Response("ok");
    }
    if (url.pathname === "/relay") {
      const ws = this.ctx.getWebSockets()[0];
      if (!ws) return rpcError(503, "This KawKaw is offline (the computer is off or not connected to the internet).");
      const req = await request.json();
      const rid = `b${++this.seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(rid); resolve(rpcError(504, "KawKaw took too long to answer")); }, 10 * 60 * 1000);
        this.pending.set(rid, { resolve, timer, chunks: [] });
        ws.send(JSON.stringify({ type: "req", rid, ...req }));
      });
    }
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (msg.type !== "res") return;
    const p = this.pending.get(msg.rid);
    if (!p) return;
    if (msg.status) { p.status = msg.status; p.headers = msg.headers || {}; }
    if (msg.chunk) p.chunks.push(msg.chunk);
    if (msg.last) {
      clearTimeout(p.timer);
      this.pending.delete(msg.rid);
      const h = new Headers();
      for (const k of PASS_RES) if (p.headers[k]) h.set(k, p.headers[k]);
      p.resolve(new Response(p.chunks.join(""), { status: p.status || 200, headers: h }));
    }
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
  }
}

// Stores the revoked list pushed from your server.
export class Registry {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (request.method === "PUT") { await this.ctx.storage.put("revoked", await request.json()); return new Response("ok"); }
    return Response.json((await this.ctx.storage.get("revoked")) || []);
  }
}
