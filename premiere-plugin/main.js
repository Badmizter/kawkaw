/* KawKaw — Premiere Pro UXP panel.
 * - Connects to the local KawKaw daemon (ws://127.0.0.1:47321)
 * - Executes timeline commands for Claude (MCP) and for the panel buttons
 * - AI gap fill UI (frames from the timeline or from your drives)
 */
const ppro = require("premierepro");
const uxp = require("uxp");
const lfs = uxp.storage.localFileSystem;

const PORT = 47321;
const TICKS_PER_SEC = 254016000000;
const VERSION = "0.2.2";

// ---------------------------------------------------------------- utils
const $ = (id) => document.getElementById(id);
const T = (sec) => ppro.TickTime.createWithSeconds(Math.max(0, sec));
const secs = (tt) => (tt && typeof tt.seconds === "number" ? tt.seconds : 0);
const basename = (p) => String(p).split(/[\\/]/).pop();

let toastTimer = null;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast hidden"; }, kind === "err" ? 12000 : 6000);
}
function log(msg, isErr) {
  if (isErr) toast(msg, "err");
  const d = document.createElement("div");
  d.textContent = new Date().toLocaleTimeString() + "  " + msg;
  if (isErr) d.className = "err";
  const l = $("log");
  l.insertBefore(d, l.firstChild);
  while (l.childNodes.length > 40) l.removeChild(l.lastChild);
}

async function ctx() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No project open");
  const seq = await project.getActiveSequence();
  if (!seq) throw new Error("No active sequence");
  return { project, seq };
}

/** One undo step. build() returns an array of actions (created inside the transaction). */
function tx(project, name, build) {
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((ca) => {
      for (const a of build() || []) if (a) ca.addAction(a);
    }, "KawKaw: " + name);
  });
  if (!ok) throw new Error(name + " failed in Premiere");
  return ok;
}

async function seqInfo(seq) {
  const tb = Number(await seq.getTimebase());
  const fps = tb ? TICKS_PER_SEC / tb : 25;
  const size = await seq.getFrameSize();
  return {
    name: seq.name,
    fps: Math.round(fps * 1000) / 1000,
    width: size ? size.width : 1920,
    height: size ? size.height : 1080,
    inSec: secs(await seq.getInPoint()),
    outSec: secs(await seq.getOutPoint()),
    endSec: secs(await seq.getEndTime()),
    playheadSec: secs(await seq.getPlayerPosition()),
  };
}

async function getTrack(seq, kind, i) {
  const t = kind === "audio" ? await seq.getAudioTrack(i) : await seq.getVideoTrack(i);
  if (!t) throw new Error(`${kind === "audio" ? "A" : "V"}${i + 1} does not exist`);
  return t;
}
async function trackClips(track) {
  return (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
}
async function itemInfo(item, i) {
  let mediaPath = null;
  try {
    const pi = await item.getProjectItem();
    const clip = ppro.ClipProjectItem.cast(pi);
    if (clip) mediaPath = await clip.getMediaFilePath();
  } catch (e) {}
  return {
    index: i,
    name: await item.getName(),
    startSec: secs(await item.getStartTime()),
    endSec: secs(await item.getEndTime()),
    sourceInSec: secs(await item.getInPoint()),
    sourceOutSec: secs(await item.getOutPoint()),
    speed: await item.getSpeed(),
    disabled: await item.isDisabled(),
    mediaPath,
  };
}
async function getItem(seq, ref) {
  const clips = await trackClips(await getTrack(seq, ref.kind, ref.track));
  const it = clips[ref.index];
  if (!it) throw new Error(`No clip #${ref.index} on ${ref.kind === "audio" ? "A" : "V"}${ref.track + 1}`);
  return it;
}

/** Find (or import) the project item for a media file. */
async function findProjectItemByPath(project, mediaPath) {
  const target = mediaPath.replace(/\\/g, "/").toLowerCase();
  async function walk(folder, depth) {
    const items = (await folder.getItems()) || [];
    for (const it of items) {
      const clip = ppro.ClipProjectItem.cast(it);
      if (clip) {
        try {
          const p = await clip.getMediaFilePath();
          if (p && p.replace(/\\/g, "/").toLowerCase() === target) return clip;
        } catch (e) {}
      }
      const f = ppro.FolderItem.cast(it);
      if (f && depth < 8) {
        const r = await walk(f, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
  const root = await project.getRootItem();
  let found = await walk(root, 0);
  if (found) return found;
  const ok = await project.importFiles([mediaPath], true, null, false);
  if (!ok) throw new Error("Import failed: " + mediaPath);
  found = await walk(root, 0);
  if (!found) throw new Error("Imported but could not find in project: " + basename(mediaPath));
  return found;
}

/** Lay a source range of a clip at a timeline time. */
async function placeRange(project, seq, clip, { timeSec, srcIn, srcOut, vTrack, aTrack, insert }) {
  const editor = ppro.SequenceEditor.getEditor(seq);
  if (srcIn != null && srcOut != null) tx(project, "Set source in/out", () => [clip.createSetInOutPointsAction(T(srcIn), T(srcOut))]);
  const a = aTrack == null ? -1 : aTrack;
  const build = (at) => [insert ? editor.createInsertProjectItemAction(clip, T(timeSec), vTrack, at, false) : editor.createOverwriteItemAction(clip, T(timeSec), vTrack, at)];
  try {
    tx(project, insert ? "Insert" : "Overwrite", () => build(a));
  } catch (e) {
    if (a !== -1) throw e;
    // some builds don't accept -1 for "no audio": use the last audio track instead
    const n = await seq.getAudioTrackCount();
    tx(project, insert ? "Insert" : "Overwrite", () => build(Math.max(0, n - 1)));
  }
}

// ---------------------------------------------------------------- bridge connection
let ws = null;
let seqNo = 0;
const waiting = {};
let CONFIG = null;
let HOSTS = [];

function bridgeCall(method, params, target) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("KawKaw daemon is not running"));
    const id = "p" + ++seqNo;
    waiting[id] = { resolve, reject };
    ws.send(JSON.stringify({ type: "call", id, target: target || "bridge", method, params: params || {} }));
    setTimeout(() => { if (waiting[id]) { delete waiting[id]; reject(new Error(method + " timed out")); } }, 600000);
  });
}

function connect() {
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}`); } catch (e) { return setTimeout(connect, 3000); }
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "premiere", version: VERSION }));
    $("conn").textContent = "connected"; $("conn").className = "conn on";
    $("offline").className = "banner hidden";
    log("Connected to KawKaw");
    refreshGaps();
  };
  ws.onclose = () => {
    $("conn").textContent = "offline"; $("conn").className = "conn off";
    $("offline").className = "banner";
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {};
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "welcome") { CONFIG = m.config; renderConfig(); }
    else if (m.type === "result" && waiting[m.id]) {
      const w = waiting[m.id]; delete waiting[m.id];
      m.ok ? w.resolve(m.data) : w.reject(new Error(m.error));
    } else if (m.type === "call") {
      const fn = handlers[m.method];
      try {
        if (!fn) throw new Error("Unknown Premiere command: " + m.method);
        const data = await fn(m.params || {});
        ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: data === undefined ? null : data }));
        log("✓ " + m.method);
      } catch (e) {
        ws.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: String(e.message || e) }));
        log("✗ " + m.method + ": " + (e.message || e), true);
      }
    } else if (m.type === "event") {
      if (m.name === "config") { CONFIG = m.data; renderConfig(); }
      if (m.name === "gap") onGapEvent(m.data);
      if (m.name === "gapDeleted") refreshGaps();
      if (m.name === "hosts") HOSTS = m.data;
    }
  };
}

// ---------------------------------------------------------------- commands (used by Claude and by buttons)
const handlers = {
  async getTimeline({ includeAudio = true }) {
    const { seq } = await ctx();
    const info = await seqInfo(seq);
    info.videoTracks = [];
    info.audioTracks = [];
    const vc = await seq.getVideoTrackCount();
    for (let i = 0; i < vc; i++) {
      const t = await seq.getVideoTrack(i);
      const clips = await trackClips(t);
      const items = [];
      for (let j = 0; j < clips.length; j++) items.push(await itemInfo(clips[j], j));
      info.videoTracks.push({ track: i, label: "V" + (i + 1), name: t.name, muted: await t.isMuted(), clips: items });
    }
    if (includeAudio) {
      const ac = await seq.getAudioTrackCount();
      for (let i = 0; i < ac; i++) {
        const t = await seq.getAudioTrack(i);
        const clips = await trackClips(t);
        const items = [];
        for (let j = 0; j < clips.length; j++) items.push(await itemInfo(clips[j], j));
        info.audioTracks.push({ track: i, label: "A" + (i + 1), name: t.name, muted: await t.isMuted(), clips: items });
      }
    }
    return info;
  },

  async exportFrame({ timeSec, name }) {
    const { seq } = await ctx();
    const info = await seqInfo(seq);
    const { dir, sep } = await bridgeCall("framesDir");
    const file = (name || `frame_${Date.now()}`) + ".png";
    const w = (CONFIG && CONFIG.gapFill.frameWidth) || info.width;
    const h = Math.round(w * (info.height / info.width));
    await ppro.Exporter.exportSequenceFrame(seq, T(timeSec), file, dir, w, h);
    const full = dir + sep + file;
    await bridgeCall("waitForFile", { path: full });
    return { path: full };
  },

  async setInOut({ inSec, outSec }) {
    const { project, seq } = await ctx();
    tx(project, "Set In/Out", () => [seq.createSetInPointAction(T(inSec)), seq.createSetOutPointAction(T(outSec))]);
    return { inSec, outSec };
  },

  async setInOutAroundSelection() {
    const { project, seq } = await ctx();
    const items = await (await seq.getSelection()).getTrackItems();
    if (!items.length) throw new Error("Select clips first");
    let a = Infinity, b = 0;
    for (const it of items) { a = Math.min(a, secs(await it.getStartTime())); b = Math.max(b, secs(await it.getEndTime())); }
    return handlers.setInOut({ inSec: a, outSec: b });
  },

  async setPlayhead({ timeSec }) {
    const { seq } = await ctx();
    await seq.setPlayerPosition(T(timeSec));
    return true;
  },

  async addMarkers({ markers }) {
    const { project, seq } = await ctx();
    const mk = await ppro.Markers.getMarkers(seq);
    tx(project, `Add ${markers.length} markers`, () =>
      markers.map((m) => mk.createAddMarkerAction(m.name || "", "Comment", T(m.timeSec), T(m.durationSec || 0), m.comment || ""))
    );
    return { added: markers.length };
  },

  async addBeatMarkers({ bpm, beatsPerMarker, startSec, endSec, offsetSec = 0, preset }) {
    const { seq } = await ctx();
    const p = (preset && CONFIG && CONFIG.presets[preset]) || {};
    bpm = bpm || p.bpm;
    beatsPerMarker = beatsPerMarker || p.beatsPerMarker || 4;
    if (!bpm) throw new Error("No BPM given (set one in the preset)");
    const info = await seqInfo(seq);
    const a = startSec != null ? startSec : info.outSec > info.inSec ? info.inSec : 0;
    const b = endSec != null ? endSec : info.outSec > info.inSec ? info.outSec : info.endSec;
    const step = (60 / bpm) * beatsPerMarker;
    const markers = [];
    let n = 1;
    for (let t = a + offsetSec; t <= b + 1e-6 && markers.length < 2000; t += step, n++) markers.push({ timeSec: t, name: `Bar ${Math.ceil((n * beatsPerMarker) / 4)}`, comment: `${bpm} BPM` });
    await handlers.addMarkers({ markers });
    return { added: markers.length, everySec: step };
  },

  async applyPresetTracks({ preset }) {
    const { project, seq } = await ctx();
    const p = CONFIG && CONFIG.presets[preset];
    if (!p) throw new Error("Unknown preset: " + preset);
    const actions = [];
    const vc = await seq.getVideoTrackCount();
    const ac = await seq.getAudioTrackCount();
    const tracks = [];
    for (const key of Object.keys(p.tracks || {})) {
      const m = key.match(/^([VA])(\d+)$/i);
      if (!m) continue;
      const i = Number(m[2]) - 1;
      const isV = m[1].toUpperCase() === "V";
      if (i < 0 || i >= (isV ? vc : ac)) continue;
      tracks.push({ t: isV ? await seq.getVideoTrack(i) : await seq.getAudioTrack(i), name: p.tracks[key] });
    }
    tx(project, "Name tracks: " + preset, () => tracks.map((x) => x.t.createSetNameAction(x.name)));
    return { renamed: tracks.length, preset };
  },

  async trimItem({ kind, track, index, startSec, endSec, sourceInSec, sourceOutSec }) {
    const { project, seq } = await ctx();
    const it = await getItem(seq, { kind, track, index });
    tx(project, "Trim clip", () => [
      sourceInSec != null ? it.createSetInPointAction(T(sourceInSec)) : null,
      sourceOutSec != null ? it.createSetOutPointAction(T(sourceOutSec)) : null,
      startSec != null ? it.createSetStartAction(T(startSec)) : null,
      endSec != null ? it.createSetEndAction(T(endSec)) : null,
    ]);
    return itemInfo(await getItem(seq, { kind, track, index }), index);
  },

  async moveItem({ kind, track, index, startSec }) {
    const { project, seq } = await ctx();
    const it = await getItem(seq, { kind, track, index });
    const cur = secs(await it.getStartTime());
    const offset = ppro.TickTime.createWithSeconds(startSec).subtract(ppro.TickTime.createWithSeconds(cur));
    tx(project, "Move clip", () => [it.createMoveAction(offset)]);
    return { movedBySec: startSec - cur };
  },

  async removeItems({ items, ripple = false }) {
    const { project, seq } = await ctx();
    const sel = await ppro.TrackItemSelection.createEmptySelection();
    for (const r of items) sel.addItem(await getItem(seq, r), true);
    const editor = ppro.SequenceEditor.getEditor(seq);
    tx(project, ripple ? "Ripple delete" : "Delete", () => [editor.createRemoveItemsAction(sel, ripple, ppro.Constants.MediaType.ANY, false)]);
    return { removed: items.length };
  },

  async placeMedia({ path, timeSec, videoTrack, audioTrack, sourceInSec, sourceOutSec, insert = false }) {
    const { project, seq } = await ctx();
    const clip = await findProjectItemByPath(project, path);
    await placeRange(project, seq, clip, { timeSec, srcIn: sourceInSec, srcOut: sourceOutSec, vTrack: videoTrack, aTrack: audioTrack, insert });
    return { placed: basename(path), atSec: timeSec };
  },

  async placeSegments({ mediaPath, videoTrack, audioTrack, segments }) {
    const { project, seq } = await ctx();
    const clip = await findProjectItemByPath(project, mediaPath);
    for (const s of segments) await placeRange(project, seq, clip, { timeSec: s.timeSec, srcIn: s.sourceInSec, srcOut: s.sourceOutSec, vTrack: videoTrack, aTrack: audioTrack, insert: false });
    tx(project, "Clear source in/out", () => [clip.createClearInOutPointsAction()]);
    return { placed: segments.length };
  },

  /** Remove the silent parts of the selected clip(s). Works clip by clip, last clip first so times stay valid. */
  async removeAudioGaps({ thresholdDb, minSilenceSec, paddingSec, dryRun = false, ripple = true }) {
    const { project, seq } = await ctx();
    const selItems = await (await seq.getSelection()).getTrackItems();
    if (!selItems.length) throw new Error("Select the clip(s) to clean up first");

    // group linked video+audio parts by media file + start time
    const groups = {};
    for (const it of selItems) {
      const info = await itemInfo(it, 0);
      if (!info.mediaPath) continue;
      if (Math.abs(info.speed - 1) > 0.001) { log(`Skipped ${info.name}: speed ≠ 100%`, true); continue; }
      const isAudio = (await it.getMediaType()) === ppro.Constants.MediaType.AUDIO;
      const key = info.mediaPath + "@" + info.startSec.toFixed(3);
      const g = groups[key] || (groups[key] = { info, video: null, audio: null });
      g[isAudio ? "audio" : "video"] = it;
      if (isAudio) g.info = info;
    }
    const list = Object.values(groups).sort((a, b) => b.info.startSec - a.info.startSec);
    if (!list.length) throw new Error("No usable clips in the selection");

    const editor = ppro.SequenceEditor.getEditor(seq);
    const report = [];
    for (const g of list) {
      const { info } = g;
      const det = await bridgeCall("detectSilence", {
        path: info.mediaPath, start: info.sourceInSec, end: info.sourceOutSec,
        ...(thresholdDb != null ? { thresholdDb } : {}), ...(minSilenceSec != null ? { minSilenceSec } : {}), ...(paddingSec != null ? { paddingSec } : {}),
      });
      report.push({ clip: info.name, startSec: info.startSec, removedSec: det.removedSec, segments: det.keeps.length });
      if (dryRun || det.keeps.length === 0 || det.removedSec < 0.05) continue;

      const vTrack = g.video ? await g.video.getTrackIndex() : 0;
      const aTrack = g.audio ? await g.audio.getTrackIndex() : -1;
      const clip = ppro.ClipProjectItem.cast(await (g.audio || g.video).getProjectItem());

      // 1) remove the original (ripple closes its space)
      const sel = await ppro.TrackItemSelection.createEmptySelection();
      if (g.video) sel.addItem(g.video, true);
      if (g.audio) sel.addItem(g.audio, true);
      tx(project, "Remove original for gap cut", () => [editor.createRemoveItemsAction(sel, ripple, ppro.Constants.MediaType.ANY, false)]);

      // 2) lay the kept parts back one after another
      let t = info.startSec;
      for (const k of det.keeps) {
        await placeRange(project, seq, clip, { timeSec: t, srcIn: k.start, srcOut: k.end, vTrack, aTrack: g.audio ? aTrack : null, insert: ripple });
        t += k.end - k.start;
      }
      tx(project, "Clear source in/out", () => [clip.createClearInOutPointsAction()]);
    }
    const total = report.reduce((a, r) => a + r.removedSec, 0);
    log(`${dryRun ? "Would remove" : "Removed"} ${total.toFixed(2)} s of silence`);
    return { dryRun, totalRemovedSec: +total.toFixed(3), clips: report };
  },

  // ---- AI gap
  async createGapFromInOut({ useFrames = true, atPlayhead = false, durationSec = 5 }) {
    const { seq } = await ctx();
    const info = await seqInfo(seq);
    if (atPlayhead) { info.inSec = info.playheadSec; info.outSec = info.playheadSec + Math.max(1, Number(durationSec) || 5); useFrames = false; }
    if (!(info.outSec > info.inSec)) throw new Error("Set In and Out points on the timeline first (press I and O), or use At playhead.");
    let firstFrame = null, lastFrame = null;
    if (useFrames) {
      const stamp = Date.now();
      firstFrame = (await handlers.exportFrame({ timeSec: Math.max(0, info.inSec - 1 / info.fps), name: `gap_${stamp}_first` })).path;
      lastFrame = (await handlers.exportFrame({ timeSec: info.outSec, name: `gap_${stamp}_last` })).path;
    }
    const gap = await bridgeCall("createGap", { sequenceName: info.name, sequenceGuid: String(seq.guid || ""), inSec: info.inSec, outSec: info.outSec, firstFrame, lastFrame });
    showTab("ai");
    await refreshGaps(gap.id);
    toast(`AI clip ready to set up: ${gap.durationSec.toFixed(1)} s at ${fmt(gap.inSec)}. Add frames or a prompt, then press Generate.`, "ok");
    return gap;
  },

  async placeGapClip({ gap }) {
    const { project, seq } = await ctx();
    if (!gap.videoPath) throw new Error("Gap has no video yet");
    const clip = await findProjectItemByPath(project, gap.videoPath);
    let vTrack;
    if (gap.videoTrack !== "auto" && gap.videoTrack != null && gap.videoTrack !== "") vTrack = Number(gap.videoTrack) - 1;
    else {
      // first track above everything that overlaps the gap
      const vc = await seq.getVideoTrackCount();
      let highest = -1;
      for (let i = 0; i < vc; i++) {
        for (const it of await trackClips(await seq.getVideoTrack(i))) {
          const s = secs(await it.getStartTime()), e = secs(await it.getEndTime());
          if (s < gap.outSec - 1e-3 && e > gap.inSec + 1e-3) highest = i;
        }
      }
      vTrack = Math.min(vc - 1, highest + 1);
      if (highest + 1 >= vc) log("No free track above the gap — placed on the top track. Add a track for a clean overlay.", true);
    }
    const aTrack = gap.audioTrack ? Number(gap.audioTrack) - 1 : null;
    await placeRange(project, seq, clip, { timeSec: gap.inSec, srcIn: 0, srcOut: gap.durationSec, vTrack, aTrack, insert: false });
    log(`AI clip placed on V${vTrack + 1}`);
    return { videoTrack: vTrack + 1, atSec: gap.inSec };
  },

  async getRangeForAE() {
    const { seq } = await ctx();
    const tl = await handlers.getTimeline({ includeAudio: true });
    const a = tl.outSec > tl.inSec ? tl.inSec : 0;
    const b = tl.outSec > tl.inSec ? tl.outSec : tl.endSec;
    const layers = [];
    const collect = (tracks, kind) => {
      for (const t of tracks) for (const c of t.clips) {
        if (!c.mediaPath || c.disabled || c.endSec <= a || c.startSec >= b) continue;
        const start = Math.max(a, c.startSec);
        layers.push({ path: c.mediaPath, name: c.name, kind, track: t.track, start, end: Math.min(b, c.endSec), sourceIn: c.sourceInSec + (start - c.startSec) });
      }
    };
    collect(tl.videoTracks, "video");
    collect(tl.audioTracks, "audio");
    return { name: `${tl.name} ${a.toFixed(2)}-${b.toFixed(2)}`, width: tl.width, height: tl.height, fps: tl.fps, duration: b - a, rangeIn: a, layers };
  },

  async sendRangeToAE() {
    const range = await handlers.getRangeForAE();
    log(`Sending ${range.layers.length} layers to After Effects…`);
    const r = await bridgeCall("aeSendRange", range);
    log(`AE comp "${r.comp}" created (${r.layers} layers)`);
    return r;
  },

  async macro({ steps }) {
    const out = [];
    for (const s of steps || []) out.push(await runAction(s.action, s.params || {}));
    return out;
  },
};

// Connect to the KawKaw app FIRST, so a UI problem can never stop the connection.
try { connect(); } catch (e) { console.error("KawKaw connect failed", e); }
// ---------------------------------------------------------------- UI
window.addEventListener("error", (e) => { try { toast("Panel error: " + (e.message || e), "err"); } catch (x) {} });
async function runAction(action, params) {
  const fn = handlers[action];
  if (!fn) throw new Error("Unknown action: " + action);
  if (action === "removeAudioGaps") {
    params = { thresholdDb: Number($("siDb").value), minSilenceSec: Number($("siMin").value), ripple: $("siRipple").checked, ...params };
  }
  return fn(params);
}

function showTab(name) {
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), (t) => { t.className = "tab" + (t.getAttribute("data-tab") === name ? " active" : ""); });
  Array.prototype.forEach.call(document.querySelectorAll(".page"), (p) => { p.className = "page" + (p.id === "page-" + name ? "" : " hidden"); });
}
Array.prototype.forEach.call(document.querySelectorAll(".tab"), (t) => t.addEventListener("click", () => showTab(t.getAttribute("data-tab"))));

function renderConfig() {
  if (!CONFIG) return;
  const grid = $("buttonGrid");
  grid.innerHTML = "";
  for (const b of CONFIG.buttons || []) {
    const el = document.createElement("button");
    el.textContent = b.label;
    el.style.backgroundColor = b.color || "#3a3a3e";
    el.addEventListener("click", async () => {
      el.disabled = true;
      log("▶ " + b.label);
      try {
        const r = await runAction(b.action, b.params || {});
        if (r && r.totalRemovedSec != null) log(`Done: removed ${r.totalRemovedSec}s`);
        else log("Done: " + b.label);
      } catch (e) { log(b.label + ": " + e.message, true); }
      el.disabled = false;
    });
    grid.appendChild(el);
  }
  $("siDb").value = CONFIG.silence.thresholdDb;
  $("siMin").value = CONFIG.silence.minSilenceSec;
  $("provider").value = CONFIG.ai.defaultProvider;
  const ps = $("presetSelect");
  const cur = ps.value;
  ps.innerHTML = "";
  for (const name of Object.keys(CONFIG.presets || {})) {
    const o = document.createElement("option"); o.value = name; o.textContent = name; ps.appendChild(o);
  }
  if (cur && CONFIG.presets[cur]) ps.value = cur;
  renderPreset();
}

function renderPreset() {
  const p = CONFIG && CONFIG.presets[$("presetSelect").value];
  if (!p) { $("presetView").textContent = "No presets yet."; return; }
  const lines = Object.keys(p.tracks || {}).map((k) => `${k}  ${p.tracks[k]}`);
  $("presetView").textContent = `${lines.join("\n")}\n\n${p.bpm ? p.bpm + " BPM · marker every " + (p.beatsPerMarker || 4) + " beats\n" : ""}${p.rules || ""}`;
}
$("presetSelect").addEventListener("change", renderPreset);
$("applyTracks").addEventListener("click", () => handlers.applyPresetTracks({ preset: $("presetSelect").value }).then((r) => log(`Renamed ${r.renamed} tracks`)).catch((e) => log(e.message, true)));
$("beatMarkers").addEventListener("click", () => handlers.addBeatMarkers({ preset: $("presetSelect").value }).then((r) => log(`Added ${r.added} beat markers`)).catch((e) => log(e.message, true)));
$("openSettings").addEventListener("click", () => uxp.shell.openExternal(`http://127.0.0.1:${PORT}/settings`).catch((e) => log("Open http://127.0.0.1:" + PORT + "/settings in your browser", true)));

// ---- AI gap UI
let GAPS = [];
let currentGapId = null;

async function refreshGaps(selectId) {
  try { GAPS = await bridgeCall("listGaps"); } catch (e) { return; }
  const s = $("gapSelect");
  s.innerHTML = "";
  if (!GAPS.length) { const o = document.createElement("option"); o.textContent = "No gaps yet"; o.value = ""; s.appendChild(o); }
  for (const g of GAPS) {
    const o = document.createElement("option");
    o.value = g.id;
    o.textContent = `${g.sequenceName || "Gap"} · ${fmt(g.inSec)}–${fmt(g.outSec)} · ${g.status}`;
    s.appendChild(o);
  }
  currentGapId = selectId || (GAPS.find((g) => g.id === currentGapId) ? currentGapId : GAPS[0] && GAPS[0].id) || null;
  if (currentGapId) s.value = currentGapId;
  renderGap();
}
function fmt(t) { if (t == null) return "?"; const m = Math.floor(t / 60); return m + ":" + (t % 60).toFixed(2).padStart(5, "0"); }
function gapById(id) { return GAPS.find((g) => g.id === id); }
function thumb(el, p) {
  el.innerHTML = "";
  if (!p) { const s = document.createElement("span"); s.textContent = "empty"; el.appendChild(s); return; }
  const img = document.createElement("img");
  img.src = `http://127.0.0.1:${PORT}/frame?path=${encodeURIComponent(p)}&t=${Date.now()}`;
  el.appendChild(img);
}
function renderGap() {
  const g = gapById(currentGapId);
  $("gapEditor").className = g ? "" : "hidden";
  $("gapEmptyState").className = g ? "hint hidden" : "hint";
  $("gapSelect").className = g ? "" : "hidden";
  if (!g) return;
  $("gapMeta").textContent = `${fmt(g.inSec)} → ${fmt(g.outSec)}  (${g.durationSec.toFixed(2)} s)  ·  ${g.id}`;
  thumb($("firstThumb"), g.firstFrame);
  thumb($("lastThumb"), g.lastFrame);
  if (document.activeElement !== $("prompt")) $("prompt").value = g.prompt || "";
  $("provider").value = g.provider || "manual";
  $("gapTrack").value = g.videoTrack === "auto" ? "" : g.videoTrack || "";
  $("gapStatus").textContent = `${g.status}${g.progress ? " · " + g.progress : ""}${g.error ? " · " + g.error : ""}`;
}
function onGapEvent(g) {
  if (g.status === "failed" && g.error) toast("AI clip failed: " + g.error, "err");
  if (g.status === "placed") toast("AI clip placed on the timeline ✔", "ok");
  const i = GAPS.findIndex((x) => x.id === g.id);
  if (i >= 0) GAPS[i] = g; else { refreshGaps(); return; }
  if (g.id === currentGapId) renderGap();
  let o = null;
  try { o = Array.prototype.find.call($("gapSelect").options, (x) => x.value === g.id); } catch (e) {}
  if (o) o.textContent = `${g.sequenceName || "Gap"} · ${fmt(g.inSec)}–${fmt(g.outSec)} · ${g.status}`;
}
async function saveGapFields() {
  const g = gapById(currentGapId);
  if (!g) return;
  const tr = $("gapTrack").value.trim();
  await bridgeCall("updateGap", { id: g.id, prompt: $("prompt").value, provider: $("provider").value, videoTrack: tr ? Number(tr) : "auto" });
}
async function pickFrame(which) {
  const g = gapById(currentGapId);
  if (!g) return;
  const f = await lfs.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"] });
  if (!f) return;
  await bridgeCall("updateGap", { id: g.id, [which]: f.nativePath });
}

$("gapSelect").addEventListener("change", () => { currentGapId = $("gapSelect").value; renderGap(); });
$("gapFromInOut").addEventListener("click", () => handlers.createGapFromInOut({ useFrames: true }).catch((e) => log(e.message, true)));
$("gapEmpty").addEventListener("click", () => handlers.createGapFromInOut({ atPlayhead: true, durationSec: Number($("gapDur").value) }).catch((e) => log(e.message, true)));
$("pickFirst").addEventListener("click", () => pickFrame("firstFrame").catch((e) => log(e.message, true)));
$("pickLast").addEventListener("click", () => pickFrame("lastFrame").catch((e) => log(e.message, true)));
$("clearFirst").addEventListener("click", () => bridgeCall("updateGap", { id: currentGapId, firstFrame: null }).catch((e) => log(e.message, true)));
$("clearLast").addEventListener("click", () => bridgeCall("updateGap", { id: currentGapId, lastFrame: null }).catch((e) => log(e.message, true)));
$("prompt").addEventListener("blur", () => saveGapFields().catch((e) => log(e.message, true)));
$("provider").addEventListener("change", () => saveGapFields().catch((e) => log(e.message, true)));
$("gapTrack").addEventListener("change", () => saveGapFields().catch((e) => log(e.message, true)));
$("generate").addEventListener("click", async () => {
  try {
    await saveGapFields();
    const g = gapById(currentGapId);
    if (!g) return toast("Create an AI clip first (From In/Out or At playhead).", "err");
    if (!$("prompt").value.trim() && !g.firstFrame) return toast("Write a prompt or choose a first frame before generating.", "err");
    await bridgeCall("generateGap", { id: currentGapId });
    const prov = $("provider").value;
    toast(prov === "manual"
      ? "Manual mode: open your KawKaw folder → inbox → " + g.id + ". Make the video on the Kling/Higgsfield website and save it there. It's placed on the timeline automatically."
      : "Sent to " + (prov === "kling" ? "Kling" : "Higgsfield") + ". This usually takes 1–5 minutes; the clip appears on the timeline by itself.", "ok");
  } catch (e) { log(e.message, true); }
});
$("place").addEventListener("click", () => bridgeCall("placeGap", { id: currentGapId }).then(() => log("Placed")).catch((e) => log(e.message, true)));
$("deleteGap").addEventListener("click", () => bridgeCall("deleteGap", { id: currentGapId }).then(() => { currentGapId = null; refreshGaps(); }).catch((e) => log(e.message, true)));


