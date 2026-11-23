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
const VERSION = "0.3.2";

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
let APP_VERSION = "?";
let HOSTS = [];

const SLOW = { detectSilence: 600000, aeSendRange: 300000, aeRun: 300000, placeGap: 120000, waitForFile: 60000 };
function bridgeCall(method, params, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("KawKaw daemon is not running"));
    const id = "p" + ++seqNo;
    waiting[id] = { resolve, reject };
    ws.send(JSON.stringify({ type: "call", id, target: target || "bridge", method, params: params || {} }));
    const ms = timeoutMs || SLOW[method] || 20000;
    setTimeout(() => { if (waiting[id]) { delete waiting[id]; reject(new Error(`The KawKaw app didn't answer "${method}" within ${Math.round(ms / 1000)} s. Try closing and reopening the KawKaw app.`)); } }, ms);
  });
}

function connect() {
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}`); } catch (e) { return setTimeout(connect, 3000); }
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "premiere", version: VERSION }));
    $("conn").textContent = "connected"; $("conn").className = "conn on";
    $("offline").className = "banner hidden";
    log("Connected to KawKaw");
    setTimeout(refreshProjectFolder, 300);
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
    if (m.type === "welcome") { setTimeout(refreshChatMode, 0); CONFIG = m.config; APP_VERSION = m.version; $("conn").textContent = "connected · app " + m.version + " · panel " + VERSION; renderConfig(); }
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
      if (m.name === "config") { CONFIG = m.data; renderConfig(); refreshChatMode(); }
      if (m.name === "gap") onGapEvent(m.data);
      if (m.name === "gapDeleted") refreshGaps();
      if (m.name === "hosts") HOSTS = m.data;
      if (m.name === "assistant") onAssistantEvent(m.data);
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
    let projectPath = null;
    try { projectPath = (await ppro.Project.getActiveProject()).path || null; } catch (e) {}
    const gap = await bridgeCall("createGap", { project: projectPath, sequenceName: info.name, sequenceGuid: String(seq.guid || ""), inSec: info.inSec, outSec: info.outSec, firstFrame, lastFrame });
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

  async autoEditFolder({ preset, folder, music, bpm, beatsPerCut, lengthSec, shuffle }) {
    const { project, seq } = await ctx();
    const p = (CONFIG && CONFIG.presets[preset || getPick("presetSelect")]) || {};
    bpm = Number(bpm || p.bpm);
    beatsPerCut = Number(beatsPerCut || p.beatsPerCut || 2);
    lengthSec = lengthSec != null ? Number(lengthSec) : Number(p.lengthSec || 0);
    if (!bpm) throw new Error("Set the BPM in the Presets tab first.");
    if (!folder) {
      toast("Choose the folder with your footage…", "ok");
      const f = await lfs.getFolder();
      if (!f) return { cancelled: true };
      folder = f.nativePath;
    }
    if (!music) {
      toast("Now choose the music…", "ok");
      const m = await lfs.getFileForOpening({ types: ["wav", "mp3", "aif", "aiff", "m4a", "aac", "flac"] });
      if (!m) return { cancelled: true };
      music = m.nativePath;
    }
    const info = await seqInfo(seq);
    const startSec = info.playheadSec;
    toast("Planning the cut…", "ok");
    const plan = await bridgeCall("planAutoEdit", { folder, music, bpm, beatsPerCut, lengthSec, startSec, shuffle: !!shuffle }, null, 120000);
    log(`Auto-edit: ${plan.segments.length} cuts from ${plan.clips} clips, a cut every ${plan.cutEverySec.toFixed(2)} s, ${plan.totalSec.toFixed(1)} s long`);
    const aCount = await seq.getAudioTrackCount();
    // music on A1 (video track index is ignored for audio-only files)
    const song = await findProjectItemByPath(project, plan.music.path);
    await placeRange(project, seq, song, { timeSec: startSec, srcIn: 0, srcOut: plan.totalSec, vTrack: 0, aTrack: 0, insert: false });
    try { tx(project, "Clear in/out", () => [song.createClearInOutPointsAction()]); } catch (e) {}
    const items = {};
    let done = 0, skipped = 0;
    for (const sgm of plan.segments) {
      try {
        const clip = items[sgm.path] || (items[sgm.path] = await findProjectItemByPath(project, sgm.path));
        await placeRange(project, seq, clip, { timeSec: sgm.timeSec, srcIn: sgm.srcIn, srcOut: sgm.srcOut, vTrack: 0, aTrack: aCount > 1 ? 1 : null, insert: false });
        done++;
        if (done % 5 === 0) toast(`Auto-edit: ${done} / ${plan.segments.length} cuts placed…`, "ok");
      } catch (e) { skipped++; log("Skipped " + basename(sgm.path) + ": " + e.message, true); }
    }
    for (const c of Object.values(items)) { try { tx(project, "Clear in/out", () => [c.createClearInOutPointsAction()]); } catch (e) {} }
    toast(`Auto-edit done ✔ ${done} cuts${skipped ? `, ${skipped} skipped` : ""} · ${plan.totalSec.toFixed(1)} s. Undo with Ctrl+Z step by step, or delete the clips.`, skipped ? "err" : "ok");
    return { cuts: done, skipped, totalSec: plan.totalSec, cutEverySec: plan.cutEverySec };
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

// Button-based pickers (Premiere panels don't reliably open <select> dropdowns).
const PICKS = {};
function setPickOptions(id, opts) { const p = PICKS[id] || (PICKS[id] = { opts: [], val: "", on: null }); p.opts = opts; paintPick(id); }
function setPick(id, v) { const p = PICKS[id] || (PICKS[id] = { opts: [], val: "", on: null }); p.val = v; paintPick(id); }
function getPick(id) { return (PICKS[id] && PICKS[id].val) || ""; }
function onPick(id, fn) { const p = PICKS[id] || (PICKS[id] = { opts: [], val: "", on: null }); p.on = fn; }
function paintPick(id) {
  const p = PICKS[id], el = $(id);
  if (!el) return;
  el.innerHTML = "";
  p.opts.forEach((o) => {
    const b = document.createElement("div");
    b.className = "pick" + (o.value === p.val ? " on" : "");
    b.textContent = o.label;
    b.addEventListener("click", () => { p.val = o.value; paintPick(id); if (p.on) p.on(o.value); });
    el.appendChild(b);
  });
}
setPickOptions("provider", [{ value: "manual", label: "Manual" }, { value: "kling", label: "Kling API" }, { value: "higgsfield", label: "Higgsfield API" }]);
window.addEventListener("error", (e) => { try { toast("Panel error: " + (e.message || e), "err"); } catch (x) {} });
async function runAction(action, params) {
  const fn = handlers[action];
  if (!fn) throw new Error("Unknown action: " + action);
  if (action === "autoEditFolder") params = { shuffle: $("pShuffle").checked, ...params };
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
  setPick("provider", CONFIG.ai.defaultProvider);
  const names = Object.keys(CONFIG.presets || {});
  setPickOptions("presetSelect", names.map((n) => ({ value: n, label: n })));
  if (!CONFIG.presets[getPick("presetSelect")]) setPick("presetSelect", names[0] || "");
  renderPreset();
}

setPickOptions("pLen", [{ value: "0", label: "Whole song" }, { value: "15", label: "15 s" }, { value: "30", label: "30 s" }, { value: "60", label: "60 s" }]);
async function savePresetField(field, value) {
  const name = getPick("presetSelect");
  if (!name || !CONFIG.presets[name]) return;
  const pr = Object.assign({}, CONFIG.presets[name]);
  pr[field] = value;
  CONFIG.presets[name] = pr;
  try { await bridgeCall("savePreset", { name, preset: pr }); toast(`${name}: ${({ bpm: "BPM", beatsPerCut: "cut length", beatsPerMarker: "marker spacing", lengthSec: "ad length" })[field] || field} saved`, "ok"); } catch (e) { log(e.message, true); }
  renderPreset();
}
$("pBpm").addEventListener("change", () => savePresetField("bpm", Number($("pBpm").value)));
$("pCut").addEventListener("change", () => savePresetField("beatsPerCut", Number($("pCut").value)));
$("pMark").addEventListener("change", () => savePresetField("beatsPerMarker", Number($("pMark").value)));
onPick("pLen", (v) => savePresetField("lengthSec", Number(v)));
$("autoEdit").addEventListener("click", () => handlers.autoEditFolder({ preset: getPick("presetSelect"), shuffle: $("pShuffle").checked }).catch((e) => log(e.message, true)));
function renderPreset() {
  const p = CONFIG && CONFIG.presets[getPick("presetSelect")];
  if (!p) { $("presetView").textContent = "No presets yet."; return; }
  if (document.activeElement !== $("pBpm")) $("pBpm").value = p.bpm || "";
  if (document.activeElement !== $("pCut")) $("pCut").value = p.beatsPerCut || 2;
  if (document.activeElement !== $("pMark")) $("pMark").value = p.beatsPerMarker || 4;
  setPick("pLen", String(p.lengthSec || 0));
  const lines = Object.keys(p.tracks || {}).map((k) => `${k}  ${p.tracks[k]}`);
  $("presetView").textContent = `${lines.join("\n")}\n\n${p.bpm ? p.bpm + " BPM · marker every " + (p.beatsPerMarker || 4) + " beats\n" : ""}${p.rules || ""}`;
}
onPick("presetSelect", renderPreset);
$("applyTracks").addEventListener("click", () => handlers.applyPresetTracks({ preset: getPick("presetSelect") }).then((r) => log(`Renamed ${r.renamed} tracks`)).catch((e) => log(e.message, true)));
$("beatMarkers").addEventListener("click", () => handlers.addBeatMarkers({ preset: getPick("presetSelect") }).then((r) => log(`Added ${r.added} beat markers`)).catch((e) => log(e.message, true)));
$("openSettings").addEventListener("click", () => uxp.shell.openExternal(`http://127.0.0.1:${PORT}/settings`).catch((e) => log("Open http://127.0.0.1:" + PORT + "/settings in your browser", true)));

// ---- AI gap UI
let GAPS = [];
let currentGapId = null;

async function refreshGaps(selectId) {
  try { GAPS = await bridgeCall("listGaps"); } catch (e) { return; }
  const label = (g) => `${g.sequenceName || "Clip"} · ${fmt(g.inSec)}–${fmt(g.outSec)} · ${g.status}`;
  setPickOptions("gapSelect", GAPS.map((g) => ({ value: g.id, label: label(g) })));
  currentGapId = selectId || (GAPS.find((g) => g.id === currentGapId) ? currentGapId : GAPS[0] && GAPS[0].id) || null;
  setPick("gapSelect", currentGapId || "");
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
  $("gapSelect").className = g ? "picker list" : "picker list hidden";
  if (!g) return;
  $("gapMeta").textContent = `${fmt(g.inSec)} → ${fmt(g.outSec)}  (${g.durationSec.toFixed(2)} s)  ·  ${g.id}`;
  thumb($("firstThumb"), g.firstFrame);
  thumb($("lastThumb"), g.lastFrame);
  if (document.activeElement !== $("prompt")) $("prompt").value = g.prompt || "";
  setPick("provider", g.provider || "manual");
  $("gapTrack").value = g.videoTrack === "auto" ? "" : g.videoTrack || "";
  $("gapStatus").textContent = `${g.status}${g.progress ? " · " + g.progress : ""}${g.error ? " · " + g.error : ""}`;
}
function onGapEvent(g) {
  if (g.status === "failed" && g.error) toast("AI clip failed: " + g.error, "err");
  if (g.status === "placed") toast("AI clip placed on the timeline ✔", "ok");
  const i = GAPS.findIndex((x) => x.id === g.id);
  if (i >= 0) GAPS[i] = g; else { refreshGaps(); return; }
  if (g.id === currentGapId) renderGap();
  setPickOptions("gapSelect", GAPS.map((x) => ({ value: x.id, label: `${x.sequenceName || "Clip"} · ${fmt(x.inSec)}–${fmt(x.outSec)} · ${x.status}` })));
}
async function saveGapFields() {
  const g = gapById(currentGapId);
  if (!g) return;
  const tr = $("gapTrack").value.trim();
  await bridgeCall("updateGap", { id: g.id, prompt: $("prompt").value, provider: getPick("provider"), videoTrack: tr ? Number(tr) : "auto" });
}
async function pickFrame(which) {
  const g = gapById(currentGapId);
  if (!g) return;
  const f = await lfs.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"] });
  if (!f) return;
  await bridgeCall("updateGap", { id: g.id, [which]: f.nativePath });
}

onPick("gapSelect", (v) => { currentGapId = v; renderGap(); });
$("gapFromInOut").addEventListener("click", () => handlers.createGapFromInOut({ useFrames: true }).catch((e) => log(e.message, true)));
$("gapEmpty").addEventListener("click", () => handlers.createGapFromInOut({ atPlayhead: true, durationSec: Number($("gapDur").value) }).catch((e) => log(e.message, true)));
$("pickFirst").addEventListener("click", () => pickFrame("firstFrame").catch((e) => log(e.message, true)));
$("pickLast").addEventListener("click", () => pickFrame("lastFrame").catch((e) => log(e.message, true)));
$("clearFirst").addEventListener("click", () => bridgeCall("updateGap", { id: currentGapId, firstFrame: null }).catch((e) => log(e.message, true)));
$("clearLast").addEventListener("click", () => bridgeCall("updateGap", { id: currentGapId, lastFrame: null }).catch((e) => log(e.message, true)));
$("prompt").addEventListener("blur", () => saveGapFields().catch((e) => log(e.message, true)));
onPick("provider", () => saveGapFields().then(() => toast("Provider: " + getPick("provider") + ". Press Generate to start.", "ok")).catch((e) => log(e.message, true)));
$("gapTrack").addEventListener("change", () => saveGapFields().catch((e) => log(e.message, true)));
$("generate").addEventListener("click", async () => {
  const btn = $("generate");
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Starting…";
  const step = (msg) => { $("gapStatus").textContent = msg; log(msg); };
  try {
    const g = gapById(currentGapId);
    if (!g) throw new Error("Create an AI clip first (From In/Out or At playhead).");
    if (!$("prompt").value.trim() && !g.firstFrame) throw new Error("Write a prompt or choose a first frame before generating.");
    const prov = getPick("provider") || "manual";
    toast("Generate pressed: starting with " + (prov === "kling" ? "Kling API" : prov === "higgsfield" ? "Higgsfield API" : "Manual mode") + "…", "ok");
    step("1/2 Saving prompt and settings…");
    await saveGapFields();
    step("2/2 Asking the KawKaw app to start…");
    const r = await bridgeCall("generateGap", { id: g.id, prompt: $("prompt").value, provider: prov });
    step(r.status + (r.progress ? " · " + r.progress : ""));
    toast(prov === "manual"
      ? (PROJECT_FOLDER
          ? "Manual mode: make the video on the Kling/Higgsfield website (frames + prompt: press 'Open folder' → or use the images shown here), then save the download into your AI videos folder. KawKaw places it automatically."
          : "Manual mode: press 'Open folder', make the video on the Kling/Higgsfield website with these frames and prompt, and save it into that folder. KawKaw places it on the timeline automatically. Tip: set an AI videos folder for this project at the top.")
      : "Sent to " + (prov === "kling" ? "Kling" : "Higgsfield") + ". Usually 1–5 minutes; watch the status line below. The clip appears on the timeline by itself.", "ok");
  } catch (e) {
    $("gapStatus").textContent = "Error: " + e.message;
    log(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});
$("openFolder").addEventListener("click", () => bridgeCall("openGapFolder", { id: currentGapId }).catch((e) => log(e.message, true)));
// ---------------------------------------------------------------- AI videos folder per project
let PROJECT_PATH = null, PROJECT_FOLDER = null;
async function refreshProjectFolder() {
  try {
    const pr = await ppro.Project.getActiveProject();
    PROJECT_PATH = pr ? pr.path || null : null;
  } catch (e) { PROJECT_PATH = null; }
  try { PROJECT_FOLDER = PROJECT_PATH ? await bridgeCall("getProjectFolder", { project: PROJECT_PATH }) : null; } catch (e) { PROJECT_FOLDER = null; }
  $("projFolder").textContent = PROJECT_FOLDER
    ? PROJECT_FOLDER + "  ·  new videos saved here are placed automatically"
    : PROJECT_PATH ? "Not set: choose where this project's AI videos (e.g. Kling downloads) will go" : "Save your Premiere project first, then choose its AI videos folder";
}
$("projFolderPick").addEventListener("click", async () => {
  try {
    await refreshProjectFolder();
    if (!PROJECT_PATH) throw new Error("Save your Premiere project first.");
    const f = await lfs.getFolder();
    if (!f) return;
    await bridgeCall("setProjectFolder", { project: PROJECT_PATH, folder: f.nativePath });
    await refreshProjectFolder();
    toast("AI videos folder set for this project ✔ Save Kling downloads there and KawKaw places them on the timeline.", "ok");
  } catch (e) { log(e.message, true); }
});
$("projFolderOpen").addEventListener("click", () => (PROJECT_FOLDER ? bridgeCall("openFolder", { path: PROJECT_FOLDER }) : bridgeCall("openGapFolder", {})).catch((e) => log(e.message, true)));
setInterval(refreshProjectFolder, 15000); // follows you when you switch projects

// ---------------------------------------------------------------- Chat with Claude
const CHAT_SESSION = "panel";
let chatBusy = false, thinkingEl = null;
function chatAdd(kind, text) {
  const d = document.createElement("div");
  d.className = "msg " + kind;
  d.textContent = text;
  const log = $("chatLog");
  if (thinkingEl && thinkingEl.parentNode) log.insertBefore(d, thinkingEl); else log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}
function setChatBusy(b) {
  chatBusy = b;
  $("chatSend").disabled = b;
  $("chatSend").textContent = b ? "Working…" : "Send";
  if (b && !thinkingEl) thinkingEl = chatAdd("thinking", "Claude is working…");
  if (!b && thinkingEl) { if (thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl); thinkingEl = null; }
}
const TOOL_LABELS = { premiere_get_timeline: "reading the timeline", premiere_export_frame: "looking at a frame", premiere_add_markers: "adding markers", premiere_add_beat_markers: "adding beat markers", premiere_apply_preset_tracks: "naming tracks", premiere_trim_item: "trimming a clip", premiere_move_item: "moving a clip", premiere_remove_items: "removing clips", premiere_place_media: "placing media", premiere_place_clip_segments: "cutting segments", premiere_remove_audio_gaps: "removing audio gaps", premiere_set_in_out: "setting In/Out", gap_generate: "starting AI generation", gap_update: "updating the AI clip", gap_get: "looking at the AI clip frames", ae_run_script: "working in After Effects", ae_send_in_out_range: "sending to After Effects" };
function onAssistantEvent(ev) {
  if (ev.sessionId !== CHAT_SESSION) return;
  if (ev.type === "text") chatAdd("claude", ev.text);
  else if (ev.type === "tool") chatAdd("tool", "• " + (TOOL_LABELS[ev.name] || ev.name));
  else if (ev.type === "error") chatAdd("err", ev.text);
  else if (ev.type === "done") { if (ev.stopped) chatAdd("tool", "• stopped"); setChatBusy(false); }
}
async function refreshChatMode() {
  try {
    const a = await bridgeCall("assistantStatus");
    $("chatMode").textContent = a.mode === "claude-code" ? "Claude · using your Claude login (Claude Code)" : a.mode === "api" ? "Claude · API key · " + a.model : "Not set up yet: install Claude Code (and log in once) or add an API key in Settings → Assistant.";
  } catch (e) {}
}
async function chatSend() {
  const text = $("chatInput").value.trim();
  if (!text || chatBusy) return;
  chatAdd("you", text);
  $("chatInput").value = "";
  setChatBusy(true);
  try { await bridgeCall("assistantSend", { sessionId: CHAT_SESSION, text }); }
  catch (e) { chatAdd("err", e.message); setChatBusy(false); }
}
$("chatSend").addEventListener("click", chatSend);
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); chatSend(); } });
$("chatStop").addEventListener("click", () => bridgeCall("assistantStop", { sessionId: CHAT_SESSION }).catch((e) => log(e.message, true)));
$("chatNew").addEventListener("click", async () => {
  try { await bridgeCall("assistantReset", { sessionId: CHAT_SESSION }); } catch (e) {}
  $("chatLog").innerHTML = ""; setChatBusy(false);
  chatAdd("claude", "New chat. What should we work on?");
});
chatAdd("claude", "Hi! I can read and edit your timeline, name tracks with your presets, add beat markers, remove audio gaps, set up AI clips and work in After Effects. What should we do?");

$("place").addEventListener("click", () => bridgeCall("placeGap", { id: currentGapId }).then(() => log("Placed")).catch((e) => log(e.message, true)));
$("deleteGap").addEventListener("click", () => bridgeCall("deleteGap", { id: currentGapId }).then(() => { currentGapId = null; refreshGaps(); }).catch((e) => log(e.message, true)));


