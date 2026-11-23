// Auto-edit: take a folder of footage + a music track and build a cut-to-the-beat edit plan.
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./silence.js";

const VIDEO = /\.(mp4|mov|m4v|mxf|avi|mkv|webm|mts|m2ts|r3d|braw)$/i;
const IMAGE = /\.(jpg|jpeg|png|tif|tiff|webp|psd)$/i;
const AUDIO = /\.(wav|mp3|aif|aiff|m4a|aac|flac)$/i;

export async function probeDuration(file) {
  let out = "";
  try { out = await runFfmpeg(["-hide_banner", "-i", file]); } catch (e) { out = String(e.message); } // ffmpeg exits 1 without an output; stderr still has the info
  const m = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : null;
}

export async function scanFolder(dir) {
  if (!dir || !fs.existsSync(dir)) throw new Error("Folder not found: " + dir);
  const names = fs.readdirSync(dir).filter((f) => !f.startsWith(".") && (VIDEO.test(f) || IMAGE.test(f))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!names.length) throw new Error("No video or image files in that folder.");
  const files = [];
  for (const n of names.slice(0, 300)) {
    const full = path.join(dir, n);
    const isImage = IMAGE.test(n);
    files.push({ path: full, name: n, isImage, durationSec: isImage ? null : await probeDuration(full) });
  }
  return files;
}

/**
 * Plan: one cut every `beatsPerCut` beats, cycling through the clips in name order (or shuffled).
 * Each cut takes a fresh part of its clip (skipping the first/last half second, where takes are usually messy).
 */
export async function planAutoEdit({ folder, files: fileList, music, bpm, beatsPerCut = 2, lengthSec = 0, startSec = 0, shuffle = false, offsetSec = 0 }) {
  if (!bpm || bpm < 30 || bpm > 300) throw new Error("Set a BPM between 30 and 300.");
  if (!music || !fs.existsSync(music)) throw new Error("Choose a music file.");
  if (!AUDIO.test(music) && !VIDEO.test(music)) throw new Error("The music file should be WAV, MP3, AIFF, M4A, AAC or FLAC.");
  const musicDur = await probeDuration(music);
  if (!musicDur) throw new Error("Couldn't read the music file's length.");
  let files = (fileList ? await scanFiles(fileList) : await scanFolder(folder)).filter((f) => f.isImage || (f.durationSec && f.durationSec > 0.3));
  if (!files.length) throw new Error("No usable clips in that folder.");
  if (shuffle) files = files.map((f) => [Math.random(), f]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

  const total = Math.min(lengthSec > 0 ? lengthSec : musicDur, musicDur);
  const slot = (60 / bpm) * beatsPerCut;
  const longEnough = files.filter((f) => f.isImage || f.durationSec >= slot);
  if (longEnough.length) files = longEnough; // clips shorter than one cut would leave holes
  const used = new Map(); // path -> next source time
  const segments = [];
  let t = offsetSec > 0 ? Math.min(offsetSec, total) : 0;
  // intro before the first beat (if any) is filled by the first clip
  let i = 0;
  if (t > 0) { const s0 = pick(files[0], t); segments.push({ ...s0, timeSec: startSec }); t = s0.srcOut - s0.srcIn; i = 1; }
  while (t < total - 0.04 && segments.length < 2000) {
    const len = Math.min(slot, total - t);
    const f = files[i % files.length];
    const seg = pick(f, len);
    segments.push({ ...seg, timeSec: +(startSec + t).toFixed(4) });
    t += seg.srcOut - seg.srcIn; i++;
  }
  return { music: { path: music, durationSec: musicDur }, totalSec: total, cutEverySec: slot, clips: files.length, segments };

  function pick(f, len) {
    if (f.isImage) return { path: f.path, isImage: true, srcIn: 0, srcOut: len };
    const margin = f.durationSec > len + 1.2 ? 0.5 : 0;
    let start = used.get(f.path) ?? margin;
    if (start + len > f.durationSec - margin) start = margin; // wrap around
    if (start + len > f.durationSec) { start = 0; len = Math.min(len, f.durationSec); }
    used.set(f.path, start + len);
    return { path: f.path, isImage: false, srcIn: +start.toFixed(3), srcOut: +(start + len).toFixed(3) };
  }
}

/** Same as scanFolder but for an explicit list of files (e.g. the clips in a Premiere bin). */
export async function scanFiles(paths) {
  const out = [];
  for (const p of (paths || []).slice(0, 400)) {
    if (!p || !fs.existsSync(p)) continue;
    const isImage = IMAGE.test(p);
    out.push({ path: p, name: path.basename(p), isImage, durationSec: isImage ? null : await probeDuration(p) });
  }
  return out;
}

/**
 * Rough tempo estimate: onset-strength envelope + autocorrelation, 70–180 BPM.
 * Good enough as a starting point; the editor can type the exact value.
 */
export async function detectBpm(file, { maxSec = 90 } = {}) {
  const { spawn } = await import("node:child_process");
  const ffmpegPath = (await import("ffmpeg-static")).default;
  const rate = 11025, hop = 256;
  const pcm = await new Promise((resolve, reject) => {
    const chunks = [];
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", "15", "-t", String(maxSec), "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { windowsHide: true });
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", reject);
    p.on("close", () => resolve(Buffer.concat(chunks)));
  });
  let samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
  if (samples.length < rate * 8) throw new Error("Song too short to detect BPM.");
  // energy per hop, then half-wave-rectified difference = onset strength
  const n = Math.floor(samples.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let e = 0; for (let j = 0; j < hop; j++) { const v = samples[i * hop + j]; e += v * v; } env[i] = Math.log1p(e); }
  const on = new Float32Array(n);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, env[i] - env[i - 1]);
  const mean = on.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) on[i] -= mean;
  const fps = rate / hop;
  let best = { bpm: 0, score: -Infinity };
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (const mult of [1, 2]) {
      const L = lag * mult, l0 = Math.floor(L), f = L - l0;
      let acc = 0;
      for (let i = 0; i + l0 + 1 < n; i++) acc += on[i] * (on[i + l0] * (1 - f) + on[i + l0 + 1] * f);
      s += acc / mult;
    }
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2)); // most songs sit near 120
    s *= prior;
    if (s > best.score) best = { bpm, score: s };
  }
  return { bpm: Math.round(best.bpm * 2) / 2 };
}
