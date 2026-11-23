// "Join a KawKaw Hub": this computer connects OUT to a friend's hub (primary on their server,
// backup on Cloudflare) with an invite code. ChatGPT calls the permanent hub link and the hub
// passes each request down this connection to the local ChatGPT endpoint.
import WebSocket from "ws";

const CHUNK = 256 * 1024;
let conns = [];
let info = { invite: null, links: {}, status: {} };

export function readInvite(code) {
  const parts = String(code || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== "kk1") throw new Error("That doesn't look like a KawKaw invite code (it starts with kk1.)");
  const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (!Array.isArray(p.h) || !p.h.length || !p.p) throw new Error("Invite code is incomplete");
  return p;
}

export function hubState() {
  const urls = info.invite?.h || [];
  return {
    name: info.invite?.n || null,
    hub: info.invite?.p || null,
    link: Object.values(info.links)[0] || null,
    connections: urls.map((u, i) => ({ role: i === 0 ? "primary (home server)" : "backup (Cloudflare)", url: u, ...(info.status[u] || { state: "connecting" }) })),
  };
}

export function stopHub() {
  for (const c of conns) { c.stopped = true; clearTimeout(c.retry); clearInterval(c.ping); try { c.ws?.close(); } catch {} }
  conns = [];
  info = { invite: null, links: {}, status: {} };
}

export function startHub({ invite, localUrl, log, onChange }) {
  stopHub();
  const p = readInvite(invite);
  info.invite = p;
  for (const url of p.h) {
    const c = { url, delay: 2000, stopped: false };
    conns.push(c);
    const set = (s) => { info.status[url] = s; onChange?.(); };
    const connect = () => {
      if (c.stopped) return;
      set({ state: "connecting" });
      const ws = new WebSocket(url, { headers: { Authorization: "KawKaw " + invite }, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
      c.ws = ws;
      ws.on("open", () => {
        c.delay = 2000;
        clearInterval(c.ping);
        c.ping = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}'); }, 20000);
      });
      ws.on("unexpected-response", (req, res) => {
        set({ state: "error", error: res.statusCode === 401 ? "Invite not accepted (revoked or wrong code)" : `Hub answered ${res.statusCode}` });
        if (res.statusCode === 401) c.delay = 60 * 1000; // don't hammer the hub with a bad code
      });
      ws.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "welcome") { info.links[url] = msg.url; set({ state: "online" }); log(`hub ${msg.via || ""} connected: ${url}`); return; }
        if (msg.type !== "req") return;
        try {
          const r = await fetch(localUrl, { method: msg.method, headers: msg.headers || {}, body: ["GET", "HEAD"].includes(msg.method) ? undefined : msg.body });
          const text = await r.text();
          const headers = { "content-type": r.headers.get("content-type") || "application/json" };
          if (r.headers.get("mcp-session-id")) headers["mcp-session-id"] = r.headers.get("mcp-session-id");
          if (!text.length) return ws.send(JSON.stringify({ type: "res", rid: msg.rid, status: r.status, headers, last: true }));
          for (let i = 0; i < text.length; i += CHUNK) {
            const first = i === 0, last = i + CHUNK >= text.length;
            ws.send(JSON.stringify({ type: "res", rid: msg.rid, ...(first ? { status: r.status, headers } : {}), chunk: text.slice(i, i + CHUNK), last }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: "res", rid: msg.rid, status: 502, headers: { "content-type": "application/json" }, chunk: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "KawKaw error: " + e.message } }), last: true }));
        }
      });
      ws.on("close", (code) => {
        clearInterval(c.ping);
        if (c.stopped) return;
        if (info.status[url]?.state !== "error") set({ state: "offline", error: code === 4003 ? "Access revoked by the hub owner" : null });
        c.retry = setTimeout(connect, c.delay);
        if (c.delay < 60 * 1000) c.delay = Math.min(c.delay * 2, 30000) + Math.floor(Math.random() * 1000);
      });
      ws.on("error", () => {});
    };
    connect();
  }
  return hubState();
}
