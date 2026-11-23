// Finds the quiet parts of a media file with ffmpeg's silencedetect and returns the parts to KEEP.
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`))));
  });
}

export function parseSilences(stderr, offset = 0, total = Infinity) {
  const silences = [];
  let cur = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) cur = { start: Math.max(0, parseFloat(s[1])) + offset };
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && cur) {
      cur.end = parseFloat(e[1]) + offset;
      silences.push(cur);
      cur = null;
    }
  }
  if (cur) silences.push({ start: cur.start, end: offset + total }); // silence runs to the end
  return silences;
}

/** Turn silences into keep-ranges inside [start, end], with padding, merging tiny pieces. */
export function keepRanges(silences, start, end, paddingSec, minKeepSec = 0.08) {
  const keeps = [];
  let cursor = start;
  for (const s of silences) {
    const cutStart = Math.max(start, s.start + paddingSec);
    const cutEnd = Math.min(end, s.end - paddingSec);
    if (cutEnd - cutStart <= 0.02) continue; // padding swallowed the gap
    if (cutStart > cursor) keeps.push({ start: cursor, end: cutStart });
    cursor = Math.max(cursor, cutEnd);
  }
  if (end > cursor) keeps.push({ start: cursor, end });
  return keeps.filter((k) => k.end - k.start >= minKeepSec);
}

export async function detectSilence({ path, start = 0, end, thresholdDb = -40, minSilenceSec = 0.5, paddingSec = 0.12 }) {
  if (!path) throw new Error("detectSilence: media path is required");
  const args = ["-hide_banner", "-nostats", "-ss", String(start)];
  if (end != null) args.push("-t", String(Math.max(0, end - start)));
  args.push("-i", path, "-vn", "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`, "-f", "null", "-");
  const stderr = await runFfmpeg(args);
  let total = end != null ? end - start : Infinity;
  if (!isFinite(total)) {
    const m = stderr.match(/time=(\d+):(\d+):([\d.]+)/g);
    if (m) {
      const [h, mi, se] = m[m.length - 1].slice(5).split(":").map(Number);
      total = h * 3600 + mi * 60 + se;
    }
  }
  const silences = parseSilences(stderr, start, total);
  const realEnd = start + total;
  const keeps = keepRanges(silences, start, realEnd, paddingSec);
  const kept = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  return { silences, keeps, removedSec: +(total - kept).toFixed(3), totalSec: +total.toFixed(3) };
}
