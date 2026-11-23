// All KawKaw tools, shared by the Claude (stdio) server and the ChatGPT (HTTP) server.
// `call(target, method, params, timeoutMs)` is injected so each transport can route calls its own way.
import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const VERSION = "0.3.3";

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: "Error: " + e.message }], isError: true });
function image(p) {
  const mimeType = /\.png$/i.test(p) ? "image/png" : /\.webp$/i.test(p) ? "image/webp" : "image/jpeg";
  return { type: "image", data: fs.readFileSync(p).toString("base64"), mimeType };
}
const READ_ONLY = /^(kawkaw_status|presets_list|buttons_list|premiere_get_timeline|premiere_export_frame|gap_list|gap_get)$/;
const DESTRUCTIVE = /^(premiere_remove_items|premiere_remove_audio_gaps|ae_run_script)$/;
const tool = (server, name, description, shape, fn) =>
  server.registerTool(
    name,
    { description, inputSchema: shape, annotations: { readOnlyHint: READ_ONLY.test(name), destructiveHint: DESTRUCTIVE.test(name), openWorldHint: name === "gap_generate" } },
    async (args) => { try { return await fn(args || {}); } catch (e) { return fail(e); } }
  );

const itemRef = {
  kind: z.enum(["video", "audio"]).describe("Track type"),
  track: z.number().int().min(0).describe("0-based track index (V1 = 0)"),
  index: z.number().int().min(0).describe("0-based clip index on that track, from premiere_get_timeline"),
};


export function createServer(call, { client = "claude" } = {}) {
  const server = new McpServer({ name: "kawkaw", version: VERSION }, {
    instructions:
      "KawKaw controls Adobe Premiere Pro (via a UXP panel) and After Effects (via ExtendScript). Times are in seconds. " +
      "Tracks are 0-based in tool calls (V1 = track 0). Before editing, call premiere_get_timeline. Read the user's music-video preset " +
      "with presets_list and follow its rules when cutting. For AI gap fill: gap_list / gap_get shows the first/last frames as images so you can " +
      "write a matching prompt, then gap_generate. Every Premiere edit is one undo step.",
  });


  // ---- status / config
  tool(server, "kawkaw_status", "Check the bridge and which apps (Premiere, AE) are connected.", {}, async () => text(await call("bridge", "ping")));
  tool(server, "presets_list", "List the user's music-video presets (track names per V1..V7, BPM, editing rules).", {}, async () => text((await call("bridge", "getConfig")).presets));
  tool(server, "preset_save", "Create or replace a preset. tracks maps 'V1'..'V7'/'A1'.. to names. rules = plain-language cutting rules.", {
    name: z.string(),
    description: z.string().optional(),
    tracks: z.record(z.string()),
    bpm: z.number().optional(),
    beatsPerMarker: z.number().int().optional(),
    rules: z.string().optional(),
  }, async ({ name, ...preset }) => text(await call("bridge", "savePreset", { name, preset })));
  tool(server, "buttons_list", "List the custom buttons shown in the Premiere panel.", {}, async () => text((await call("bridge", "getConfig")).buttons));
  tool(server, "buttons_save", "Replace the panel's custom buttons. Each: {id,label,action,params,color}. Actions: removeAudioGaps, createGapFromInOut, applyPresetTracks, addBeatMarkers, sendRangeToAE, setInOutAroundSelection, macro (params.steps = [{action, params}]).", {
    buttons: z.array(z.object({ id: z.string(), label: z.string(), action: z.string(), params: z.record(z.any()).optional(), color: z.string().optional() })),
  }, async ({ buttons }) => text(await call("bridge", "saveButtons", { buttons })));

  // ---- Premiere read
  tool(server, "premiere_get_timeline", "Active sequence: name, fps, size, in/out, playhead, every track with its clips (name, start, end, source in/out, media path).", {
    includeAudio: z.boolean().optional(),
  }, async (a) => text(await call("premiere", "getTimeline", a)));
  tool(server, "premiere_export_frame", "Export the program frame at a time (seconds) and show it to you.", { timeSec: z.number() }, async ({ timeSec }) => {
    const r = await call("premiere", "exportFrame", { timeSec });
    return { content: [{ type: "text", text: r.path }, image(r.path)] };
  });

  // ---- Premiere edit
  tool(server, "premiere_set_in_out", "Set sequence In and Out points (seconds).", { inSec: z.number(), outSec: z.number() }, async (a) => text(await call("premiere", "setInOut", a)));
  tool(server, "premiere_set_playhead", "Move the playhead.", { timeSec: z.number() }, async (a) => text(await call("premiere", "setPlayhead", a)));
  tool(server, "premiere_add_markers", "Add sequence markers.", {
    markers: z.array(z.object({ timeSec: z.number(), name: z.string().optional(), comment: z.string().optional(), durationSec: z.number().optional(), colorIndex: z.number().int().min(0).max(7).optional() })),
  }, async (a) => text(await call("premiere", "addMarkers", a)));
  tool(server, "premiere_add_beat_markers", "Add a marker every N beats between two times (defaults: sequence In→Out, preset BPM).", {
    bpm: z.number().optional(), beatsPerMarker: z.number().int().optional(), startSec: z.number().optional(), endSec: z.number().optional(), offsetSec: z.number().optional(), preset: z.string().optional(),
  }, async (a) => text(await call("premiere", "addBeatMarkers", a)));
  tool(server, "premiere_apply_preset_tracks", "Rename tracks using a preset (e.g. V1 Close-Up Master, V2 Wide Master, V3 Drone, V4 B-Roll).", { preset: z.string() }, async (a) => text(await call("premiere", "applyPresetTracks", a)));
  tool(server, "premiere_trim_item", "Change a clip's timeline start/end (seconds) and/or source in/out.", {
    ...itemRef, startSec: z.number().optional(), endSec: z.number().optional(), sourceInSec: z.number().optional(), sourceOutSec: z.number().optional(),
  }, async (a) => text(await call("premiere", "trimItem", a)));
  tool(server, "premiere_move_item", "Move a clip so it starts at startSec (same track).", { ...itemRef, startSec: z.number() }, async (a) => text(await call("premiere", "moveItem", a)));
  tool(server, "premiere_remove_items", "Delete clips. ripple=true closes the gap.", { items: z.array(z.object(itemRef)), ripple: z.boolean().optional() }, async (a) => text(await call("premiere", "removeItems", a)));
  tool(server, "premiere_place_media", "Import a file (if needed) and place it on the timeline. Optional source in/out trims it before placing.", {
    path: z.string(), timeSec: z.number(), videoTrack: z.number().int().min(0), audioTrack: z.number().int().min(0).optional(),
    sourceInSec: z.number().optional(), sourceOutSec: z.number().optional(), insert: z.boolean().optional().describe("true = ripple insert, false = overwrite (default)"),
  }, async (a) => text(await call("premiere", "placeMedia", a)));
  tool(server, "premiere_place_clip_segments", "Cut a project clip into segments and lay them on a track one after another (e.g. cut-to-the-beat edits). Each segment uses source times of the clip at mediaPath.", {
    mediaPath: z.string(), videoTrack: z.number().int().min(0), audioTrack: z.number().int().min(0).optional(),
    segments: z.array(z.object({ timeSec: z.number(), sourceInSec: z.number(), sourceOutSec: z.number() })),
  }, async (a) => text(await call("premiere", "placeSegments", a, 600000)));
  tool(server, "premiere_remove_audio_gaps", "Remove silent parts from the selected clip(s) (or the clip given) and ripple the timeline. Threshold/min length default to the user's settings.", {
    thresholdDb: z.number().optional(), minSilenceSec: z.number().optional(), paddingSec: z.number().optional(), dryRun: z.boolean().optional().describe("true = only report what would be cut"),
  }, async (a) => text(await call("premiere", "removeAudioGaps", a, 600000)));

  tool(server, "premiere_build_edit", "Lay out a whole edit in one call: music (optional) plus a cut list. Each cut takes a source range of a media file and places it at a timeline time (overwrite). Use this for beat-cut edits: compute times from the BPM (one beat = 60/BPM s).", {
    music: z.object({ path: z.string(), timeSec: z.number(), sourceInSec: z.number().optional(), durationSec: z.number(), audioTrack: z.number().int().min(0).optional() }).optional(),
    cuts: z.array(z.object({ mediaPath: z.string(), timeSec: z.number(), sourceInSec: z.number(), sourceOutSec: z.number(), videoTrack: z.number().int().min(0).optional(), audioTrack: z.number().int().min(0).optional() })).max(1500),
    clipAudio: z.boolean().optional().describe("false = don't place the clips' own audio (default true, goes to A2)"),
  }, async (a) => text(await call("premiere", "buildEdit", a, 900000)));
  tool(server, "premiere_auto_edit_folder", "Auto-edit: cut every clip in a folder to the beat of a music track, starting at the playhead (V1 video, music on A1, clip audio on A2). Uses the preset's BPM / beatsPerCut / lengthSec unless given.", {
    folder: z.string().describe("Folder with the footage"), music: z.string().describe("Music file path"),
    preset: z.string().optional(), bpm: z.number().optional(), beatsPerCut: z.number().optional(), lengthSec: z.number().optional().describe("0 = whole song"), shuffle: z.boolean().optional(),
  }, async (a) => text(await call("premiere", "autoEditFolder", a, 900000)));

  // ---- AI gap fill
  tool(server, "gap_create_from_in_out", "Make an AI gap from the sequence In/Out: exports the frame just before In and the frame at Out as first/last frames.", {
    useFrames: z.boolean().optional().describe("false = leave frames empty (text-to-video / pick files later)"),
  }, async (a) => text(await call("premiere", "createGapFromInOut", a)));
  tool(server, "gap_list", "List AI gaps (status, duration, prompt, provider).", {}, async () => text(await call("bridge", "listGaps")));
  tool(server, "gap_get", "Show one gap with its first and last frame images so you can write a prompt that bridges them.", { id: z.string() }, async ({ id }) => {
    const g = await call("bridge", "getGap", { id });
    if (!g) throw new Error("No such gap");
    const content = [{ type: "text", text: JSON.stringify(g, null, 2) }];
    for (const k of ["firstFrame", "lastFrame"]) if (g[k] && fs.existsSync(g[k])) content.push({ type: "text", text: k + ":" }, image(g[k]));
    return { content };
  });
  tool(server, "gap_update", "Set a gap's prompt, provider, frames (local image paths) or target track (1-based V number or 'auto').", {
    id: z.string(), prompt: z.string().optional(), provider: z.enum(["higgsfield", "kling", "manual"]).optional(),
    firstFrame: z.string().optional(), lastFrame: z.string().optional(), videoTrack: z.union([z.number().int(), z.literal("auto")]).optional(),
    extraParams: z.record(z.any()).optional().describe("Extra provider fields, e.g. {aspect_ratio:'9:16'}"),
  }, async (a) => text(await call("bridge", "updateGap", a)));
  tool(server, "gap_generate", "Start generating the gap clip (Higgsfield / Kling API cost money; 'manual' waits for a file in ~/KawKaw/inbox/<id>). The clip is placed automatically when done.", {
    id: z.string(), prompt: z.string().optional(), provider: z.enum(["higgsfield", "kling", "manual"]).optional(),
  }, async (a) => text(await call("bridge", "generateGap", a)));
  tool(server, "gap_place", "Place a finished gap clip on the timeline (if it was not placed automatically).", { id: z.string() }, async (a) => text(await call("bridge", "placeGap", a)));

  // ---- After Effects
  tool(server, "ae_send_in_out_range", "Rebuild the Premiere In/Out range as an After Effects comp (each clip becomes a layer at the same time).", {}, async () => {
    const range = await call("premiere", "getRangeForAE", {});
    return text(await call("bridge", "aeSendRange", range, 300000));
  });
  tool(server, "ae_run_script", "Run ExtendScript in After Effects 2027 and return its value. Write the body of a function: use `return` for results. Example: return app.project.numItems;", {
    code: z.string(), timeoutSec: z.number().optional(),
  }, async ({ code, timeoutSec }) => text(await call("bridge", "aeRun", { code, timeoutMs: (timeoutSec || 180) * 1000 }, ((timeoutSec || 180) + 10) * 1000)));


  return server;
}
