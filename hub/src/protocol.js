// KawKaw Hub protocol (shared by the hub on your server; the Cloudflare Worker has the same logic with WebCrypto).
//
// Invite code:  kk1.<base64url(JSON payload)>.<signature>
//   payload = { v:1, i:id, n:name, h:[agent websocket URLs, primary first], p:public base URL, t:created }
// ChatGPT link: <p>/u/<id>/<linkSecret>      linkSecret = HMAC(hubSecret, "link:"+id)
// Agent <-> hub messages (JSON over WebSocket):
//   hub→agent  {type:"welcome", id, name, url}          {type:"req", rid, method, headers, body}
//   agent→hub  {type:"res", rid, status, headers, chunk, last}   (body split in ≤256 KB chunks)
//   both       {type:"ping"} / {type:"pong"}
import crypto from "node:crypto";

export const b64u = (buf) => Buffer.from(buf).toString("base64url");
export const hmac = (secret, msg) => crypto.createHmac("sha256", secret).update(msg).digest("base64url");
export const linkSecret = (secret, id) => hmac(secret, "link:" + id).slice(0, 32);

export function makeInvite(secret, payload) {
  const body = b64u(JSON.stringify({ v: 1, ...payload }));
  return `kk1.${body}.${hmac(secret, "invite:" + body)}`;
}

export function readInvite(code) {
  const parts = String(code || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== "kk1") throw new Error("This is not a KawKaw invite code");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  return { payload, body: parts[1], sig: parts[2] };
}

export function verifyInvite(secret, code) {
  const { payload, body, sig } = readInvite(code);
  const want = Buffer.from(hmac(secret, "invite:" + body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new Error("bad invite signature");
  return payload;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const CHUNK = 256 * 1024;
// Only these headers travel through the hub (both ways).
export const PASS_REQ = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
export const PASS_RES = ["content-type", "mcp-session-id", "cache-control"];
