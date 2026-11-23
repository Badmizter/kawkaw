// KawKaw configuration: lives in ~/KawKaw/config.json so it is easy to find and edit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const HOME_DIR = process.env.KAWKAW_HOME || path.join(os.homedir(), "KawKaw");
export const DIRS = {
  root: HOME_DIR,
  frames: path.join(HOME_DIR, "frames"),
  generated: path.join(HOME_DIR, "generated"),
  inbox: path.join(HOME_DIR, "inbox"),
  ae: path.join(HOME_DIR, "ae-scripts"),
  logs: path.join(HOME_DIR, "logs"),
};
export const CONFIG_PATH = path.join(HOME_DIR, "config.json");
export const PORT = Number(process.env.KAWKAW_PORT || 47321);

export const DEFAULT_CONFIG = {
  version: 1,
  ai: {
    defaultProvider: "manual", // "higgsfield" | "kling" | "manual"
    higgsfield: {
      keyId: "",
      keySecret: "",
      baseUrl: "https://api.higgsfield.ai",
      // Kling O3 first/last frame through Higgsfield. Any Higgsfield model path works here.
      endpoint: "/kling-video/o3/first-last-frame",
      mode: "pro",
      sound: "off",
      aspectRatio: "16:9",
    },
    kling: {
      apiKey: "",
      baseUrl: "https://api-singapore.klingai.com",
      model: "kling-2.5-turbo", // path becomes /image-to-video/<model>
      resolution: "1080p", // first + last frame needs 1080p on Kling
    },
  },
  silence: {
    thresholdDb: -40, // anything quieter than this counts as silence
    minSilenceSec: 0.5, // only remove gaps at least this long
    paddingSec: 0.12, // keep a little air before/after speech
  },
  projectFolders: {}, // Premiere project file path -> folder where that project's AI videos go
  gapFill: {
    // Track (1-based, like V1) where AI clips get placed. "auto" = first empty track above the gap.
    videoTrack: "auto",
    audioTrack: 0, // 0 = do not place generated audio
    frameWidth: 1920,
    frameHeight: 1080,
  },
  assistant: {
    mode: "auto", // "auto" = Claude Code if installed, else API key | "claude-code" | "api"
    apiKey: "", // Anthropic API key (console.anthropic.com) — only for "api" mode
    model: "claude-sonnet-5-5", // API model (claude-haiku-5-5 is cheaper)
    claudeCodeModel: "", // optional model for Claude Code (empty = your default)
  },
  chatgpt: {
    enabled: false,
    mode: "quick", // "quick" = free Cloudflare link (changes on restart) | "custom" = own domain, tunnel on this computer | "server" = through your home server's tunnel | "hub" = join a KawKaw Hub with an invite
    token: "", // secret part of the link; generated on first run
    customUrl: "", // e.g. https://kawkaw.yourdomain.com
    tunnelToken: "", // Cloudflare named-tunnel token (optional, for custom mode)
    serverPort: 47322, // "server" mode: port your home server connects to on this computer
    hubInvite: "", // "hub" mode: invite code (kk1.…) from a KawKaw Hub owner
    allowedIps: [], // "server" mode: LAN address(es) of your home server, e.g. ["10.0.0.9"]
  },
  afterEffects: {
    // Name of the AE app on macOS / folder name on Windows
    appName: "Adobe After Effects 2027",
    windowsExe: "C:\\Program Files\\Adobe\\Adobe After Effects 2027\\Support Files\\AfterFX.exe",
  },
  presets: {
    "Music Video – Multicam": {
      description: "Standard multicam music video layout",
      tracks: {
        V1: "Close-Up Master",
        V2: "Wide Master",
        V3: "Drone",
        V4: "B-Roll",
        V5: "Performance Alt",
        V6: "Inserts / Details",
        V7: "AI Fill",
        A1: "Song Master",
      },
      bpm: 120,
      beatsPerMarker: 4,
      rules:
        "Open cinematic: hold Wide Master or Drone for 2–4 bars. Verses favour Close-Up Master, cut every 2 bars. Choruses cut every bar, mix Wide + Performance Alt + B-Roll. Never cut off-beat unless on a hit.",
    },
    "Ad / Commercial": {
      description: "Commercials and social ads (15/30/60 s), fast and clean",
      tracks: {
        V1: "Hero Shots",
        V2: "Product Close-Ups",
        V3: "Lifestyle / B-Roll",
        V4: "Talent / Testimonial",
        V5: "Text & Graphics",
        V6: "Logo / End Card",
        V7: "AI Fill",
        A1: "Music",
        A2: "Clip Audio",
        A3: "Voice-Over",
        A4: "SFX",
      },
      bpm: 120,
      beatsPerMarker: 2,
      beatsPerCut: 2,
      lengthSec: 30,
      rules:
        "Hook in the first 2 seconds with the strongest hero or product shot. Cut every 2 beats; on drops or the chorus cut every beat. Show the product clearly at least every 5 seconds. Keep text on screen at least 1.5 s. Last 3 seconds: logo / end card held on V6 with the music resolving. Prefer motion-matched cuts; no shot repeats unless it's the product hero.",
    },
    "Concert – Live": {
      description: "Live concert edit, angles on V1–V7",
      tracks: { V1: "Stage Wide", V2: "Singer CU", V3: "Band", V4: "Crowd", V5: "Drone", V6: "B-Roll", V7: "AI Fill", A1: "Board Mix" },
      bpm: 120,
      beatsPerMarker: 4,
      rules: "Cinematic intro: slow wides and crowd. Cut on downbeats. Singer CU on vocal lines, band on solos.",
    },
  },
  // Buttons shown in the Premiere panel. action = built-in action name, params = its options.
  buttons: [
    { id: "gaps", label: "Remove Audio Gaps", action: "removeAudioGaps", params: {}, color: "#e85d3f" },
    { id: "gapmark", label: "In/Out → AI Gap", action: "createGapFromInOut", params: {}, color: "#7b5cff" },
    { id: "names", label: "Name Tracks (Preset)", action: "applyPresetTracks", params: { preset: "Music Video – Multicam" }, color: "#2f9e72" },
    { id: "beats", label: "Beat Markers In→Out", action: "addBeatMarkers", params: { preset: "Music Video – Multicam" }, color: "#2f7ee8" },
    { id: "toae", label: "Send In/Out to AE", action: "sendRangeToAE", params: {}, color: "#9a5cd6" },
    { id: "autoedit", label: "Auto-Edit: Folder + Music", action: "autoEditFolder", params: { preset: "Ad / Commercial" }, color: "#e0a019" },
  ],
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = k in base && typeof base[k] === "object" && !Array.isArray(base[k]) && base[k] !== null ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

export function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

export function loadConfig() {
  ensureDirs();
  if (!fs.existsSync(CONFIG_PATH)) {
    const fresh = structuredClone(DEFAULT_CONFIG);
    fresh.chatgpt.token = crypto.randomBytes(18).toString("base64url");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    // presets and buttons are fully user-owned once the file exists
    const merged = deepMerge(DEFAULT_CONFIG, user);
    if (user.presets) merged.presets = user.presets;
    if (user.buttons) merged.buttons = user.buttons;
    // one-time additions for people upgrading (never overwrites their own presets/buttons)
    merged.migrations = merged.migrations || {};
    if (!merged.migrations.adPreset) {
      if (!merged.presets["Ad / Commercial"]) merged.presets["Ad / Commercial"] = structuredClone(DEFAULT_CONFIG.presets["Ad / Commercial"]);
      if (!merged.buttons.some((b) => b.action === "autoEditFolder")) merged.buttons.push(structuredClone(DEFAULT_CONFIG.buttons.find((b) => b.action === "autoEditFolder")));
      merged.migrations.adPreset = true;
      saveConfig(merged);
    }
    if (!merged.chatgpt.token) { merged.chatgpt.token = crypto.randomBytes(18).toString("base64url"); saveConfig(merged); }
    return merged;
  } catch (e) {
    throw new Error(`config.json is not valid JSON (${CONFIG_PATH}): ${e.message}`);
  }
}

export function saveConfig(cfg) {
  ensureDirs();
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

// Never send secrets to the panel or to Claude.
export function publicConfig(cfg) {
  const c = structuredClone(cfg);
  const mask = (v) => (v ? "••••" + String(v).slice(-4) : "");
  c.ai.higgsfield.keyId = mask(c.ai.higgsfield.keyId);
  c.ai.higgsfield.keySecret = mask(c.ai.higgsfield.keySecret);
  c.ai.kling.apiKey = mask(c.ai.kling.apiKey);
  c.chatgpt.token = mask(c.chatgpt.token);
  c.assistant.apiKey = mask(c.assistant.apiKey);
  c.chatgpt.tunnelToken = mask(c.chatgpt.tunnelToken);
  c.chatgpt.hubInvite = mask(c.chatgpt.hubInvite);
  return c;
}
