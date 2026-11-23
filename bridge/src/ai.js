// AI gap-fill generation: Higgsfield API, Kling API, or "manual" (you generate on the website and drop the file in a folder).
import fs from "node:fs";
import path from "node:path";
import { DIRS } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function jsonFetch(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new Error(`Couldn't reach ${new URL(url).host} (${e.cause?.code || e.message}). Check this computer's internet connection or firewall.`); }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (res.status === 401 || res.status === 403) throw new Error(`The API key was rejected (HTTP ${res.status}). Check it in KawKaw settings → Save & test key.`);
  if (res.status === 402 || /balance|insufficient|credit|quota/i.test(text)) throw new Error(`Not enough API credits (HTTP ${res.status}). Buy API credits on the provider's developer site: ${text.slice(0, 200)}`);
  if (!res.ok) throw new Error(`${opts?.method || "GET"} ${url} → ${res.status}: ${text.slice(0, 400)}`);
  return body;
}

// ---------------- Higgsfield ----------------
async function higgsfieldUpload(cfg, filePath) {
  const auth = { Authorization: `Key ${cfg.keyId}:${cfg.keySecret}`, "Content-Type": "application/json" };
  const content_type = mimeFor(filePath);
  const info = await jsonFetch(`${cfg.baseUrl}/files/generate-upload-url`, { method: "POST", headers: auth, body: JSON.stringify({ content_type }) });
  const headers = { ...(info.upload_headers || { "Content-Type": content_type }) };
  const put = await fetch(info.upload_url, { method: "PUT", headers, body: fs.readFileSync(filePath) });
  if (!put.ok) throw new Error(`Higgsfield upload failed ${put.status}`);
  return info.public_url;
}

async function higgsfieldGenerate(cfg, gap, onUpdate) {
  if (!cfg.keyId || !cfg.keySecret) throw new Error("Add your Higgsfield API key ID and secret in KawKaw Settings.");
  if (!gap.firstFrame) throw new Error("This Higgsfield model needs at least a first frame.");
  onUpdate("uploading frames");
  const body = {
    prompt: gap.prompt || "Seamless cinematic continuation between the two shots.",
    first_frame_url: await higgsfieldUpload(cfg, gap.firstFrame),
    duration: Math.min(15, Math.max(3, Math.ceil(gap.durationSec))),
    mode: cfg.mode,
    sound: cfg.sound,
  };
  if (gap.lastFrame) body.last_frame_url = await higgsfieldUpload(cfg, gap.lastFrame);
  if (cfg.aspectRatio) body.aspect_ratio = cfg.aspectRatio;
  Object.assign(body, gap.extraParams || {});
  const auth = { Authorization: `Key ${cfg.keyId}:${cfg.keySecret}`, "Content-Type": "application/json", "Idempotency-Key": gap.id };
  onUpdate("submitted");
  const sub = await jsonFetch(cfg.baseUrl + cfg.endpoint, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const statusUrl = sub.status_url || `${cfg.baseUrl}/requests/${sub.request_id}/status`;
  for (let i = 0; i < 360; i++) {
    await sleep(5000);
    const st = await jsonFetch(statusUrl, { headers: auth });
    onUpdate(st.status);
    if (st.status === "completed") return st.video?.url || st.videos?.[0]?.url;
    if (["failed", "nsfw", "canceled"].includes(st.status)) throw new Error(`Higgsfield: ${st.status} ${st.error || ""}`);
  }
  throw new Error("Higgsfield: timed out after 30 min");
}

// ---------------- Kling (official API) ----------------
async function klingGenerate(cfg, gap, onUpdate) {
  if (!cfg.apiKey) throw new Error("Add your Kling API key in KawKaw Settings.");
  if (!gap.firstFrame) throw new Error("Kling image-to-video needs a first frame.");
  const b64 = (p) => fs.readFileSync(p).toString("base64");
  const contents = [{ type: "prompt", text: gap.prompt || "Seamless cinematic continuation between the two shots." }, { type: "first_frame", url: b64(gap.firstFrame) }];
  if (gap.lastFrame) contents.push({ type: "last_frame", url: b64(gap.lastFrame) });
  const body = {
    contents,
    settings: { duration: gap.durationSec > 5 ? 10 : 5, resolution: gap.lastFrame ? "1080p" : cfg.resolution },
    options: { external_task_id: gap.id },
  };
  const headers = { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
  onUpdate("submitted");
  const sub = await jsonFetch(`${cfg.baseUrl}/image-to-video/${cfg.model}`, { method: "POST", headers, body: JSON.stringify(body) });
  const taskId = sub.data?.id;
  if (!taskId) throw new Error("Kling: no task id returned: " + JSON.stringify(sub).slice(0, 300));
  for (let i = 0; i < 360; i++) {
    await sleep(5000);
    const st = await jsonFetch(`${cfg.baseUrl}/tasks?task_ids=${encodeURIComponent(taskId)}`, { headers });
    const t = st.data?.[0];
    if (!t) continue;
    onUpdate(t.status);
    if (t.status === "succeeded") return t.outputs?.find((o) => o.type === "video")?.url;
    if (t.status === "failed") throw new Error(`Kling failed: ${t.message || ""}`);
  }
  throw new Error("Kling: timed out after 30 min");
}

// ---------------- Manual (website + watch folder) ----------------
async function manualGenerate(gap, onUpdate, isCancelled) {
  const dir = path.join(DIRS.inbox, gap.id);
  fs.mkdirSync(dir, { recursive: true });
  if (gap.firstFrame) fs.copyFileSync(gap.firstFrame, path.join(dir, "FIRST_FRAME" + path.extname(gap.firstFrame)));
  if (gap.lastFrame) fs.copyFileSync(gap.lastFrame, path.join(dir, "LAST_FRAME" + path.extname(gap.lastFrame)));
  fs.writeFileSync(
    path.join(dir, "PROMPT.txt"),
    `${gap.prompt || "(no prompt yet)"}\n\nDuration needed: ${gap.durationSec.toFixed(2)} s\n\nGenerate this in Kling / Higgsfield, then save the video file into this folder. KawKaw will place it on the timeline automatically.\n`
  );
  onUpdate(`waiting for a video file in ${dir}`);
  for (;;) {
    if (isCancelled()) throw new Error("cancelled");
    const vid = fs.readdirSync(dir).find((f) => VIDEO_EXT.test(f));
    if (vid) {
      const full = path.join(dir, vid);
      // wait until the file stops growing (download finished)
      let size = -1;
      while (size !== fs.statSync(full).size) { if (isCancelled()) throw new Error("cancelled"); size = fs.statSync(full).size; await sleep(1500); }
      return "file://" + full;
    }
    await sleep(2000);
  }
}

export async function generateForGap(config, gap, onUpdate = () => {}, isCancelled = () => false) {
  const provider = gap.provider || config.ai.defaultProvider;
  let url;
  if (provider === "higgsfield") url = await higgsfieldGenerate(config.ai.higgsfield, gap, onUpdate);
  else if (provider === "kling") url = await klingGenerate(config.ai.kling, gap, onUpdate);
  else url = await manualGenerate(gap, onUpdate, isCancelled);
  if (!url) throw new Error("Provider finished but returned no video URL");
  const dest = path.join(DIRS.generated, `${gap.id}.mp4`);
  if (url.startsWith("file://")) {
    const src = url.slice(7);
    const ext = path.extname(src) || ".mp4";
    const d = dest.replace(/\.mp4$/, ext);
    fs.copyFileSync(src, d);
    return d;
  }
  onUpdate("downloading");
  return download(url, dest);
}

/** Check that an API key works without generating anything (no cost). */
export async function testProvider(config, provider) {
  const call = async (url, headers) => {
    try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); return r.status; }
    catch (e) { return "network: " + e.message; }
  };
  if (provider === "kling") {
    const c = config.ai.kling;
    if (!c.apiKey) return { ok: false, message: "No Kling API key saved yet." };
    const st = await call(`${c.baseUrl}/tasks?task_ids=kawkaw-key-test`, { Authorization: `Bearer ${c.apiKey}` });
    if (st === 401 || st === 403) return { ok: false, message: `Kling rejected the key (HTTP ${st}). Copy it again from kling.ai/dev/api-key, and make sure the API account has credits.` };
    if (typeof st === "string") return { ok: false, message: `Couldn't reach Kling (${st}). Check the internet connection or the API host.` };
    return { ok: true, message: `Kling accepted the key ✔ (HTTP ${st}).` };
  }
  if (provider === "higgsfield") {
    const c = config.ai.higgsfield;
    if (!c.keyId || !c.keySecret) return { ok: false, message: "Higgsfield key ID and secret are not both saved." };
    const st = await call(`${c.baseUrl}/requests/00000000-0000-0000-0000-000000000000/status`, { Authorization: `Key ${c.keyId}:${c.keySecret}` });
    if (st === 401 || st === 403) return { ok: false, message: `Higgsfield rejected the key (HTTP ${st}).` };
    if (typeof st === "string") return { ok: false, message: `Couldn't reach Higgsfield (${st}).` };
    return { ok: true, message: `Higgsfield accepted the key ✔ (HTTP ${st}).` };
  }
  return { ok: true, message: "Manual mode needs no key." };
}
