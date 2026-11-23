// Runs ExtendScript (.jsx) inside After Effects 2027 on macOS or Windows and reads the result back.
// Works with regular (non-beta) AE. Needs: AE > Settings > Scripting & Expressions >
// "Allow Scripts to Write Files and Access Network".
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DIRS } from "./config.js";

const JSON_POLYFILL = `
if (typeof JSON !== "object") { JSON = {}; }
if (typeof JSON.stringify !== "function") {
  JSON.stringify = function (v) {
    var t = typeof v;
    if (v === null || v === undefined) return "null";
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return String(v);
    if (t === "string") return '"' + v.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"').replace(/\\n/g, "\\\\n").replace(/\\r/g, "\\\\r").replace(/\\t/g, "\\\\t") + '"';
    if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(JSON.stringify(v[i])); return "[" + a.join(",") + "]"; }
    var p = []; for (var k in v) if (v.hasOwnProperty(k) && typeof v[k] !== "function") p.push(JSON.stringify(k) + ":" + JSON.stringify(v[k]));
    return "{" + p.join(",") + "}";
  };
}`;

function wrap(userCode, resultPath) {
  const rp = resultPath.replace(/\\/g, "/");
  return `${JSON_POLYFILL}
(function () {
  function __write(o) { var f = new File(${JSON.stringify(rp)}); f.encoding = "UTF-8"; f.open("w"); f.write(JSON.stringify(o)); f.close(); }
  try {
    app.beginUndoGroup("KawKaw");
    var __r = (function () {
${userCode}
    })();
    app.endUndoGroup();
    __write({ ok: true, result: __r === undefined ? null : __r });
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) {}
    __write({ ok: false, error: String(e) + (e.line ? " (line " + e.line + ")" : "") });
  }
})();`;
}

export async function runAEScript(config, userCode, { timeoutMs = 180000 } = {}) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const scriptPath = path.join(DIRS.ae, `nb_${id}.jsx`);
  const resultPath = path.join(DIRS.ae, `nb_${id}.result.json`);
  fs.writeFileSync(scriptPath, wrap(userCode, resultPath), "utf8");

  const ae = config.afterEffects;
  let child;
  if (process.platform === "darwin") {
    const as = `tell application ${JSON.stringify(ae.appName)} to DoScriptFile ${JSON.stringify(scriptPath)}`;
    child = spawn("osascript", ["-e", as]);
  } else if (process.platform === "win32") {
    if (!fs.existsSync(ae.windowsExe)) throw new Error(`AfterFX.exe not found at ${ae.windowsExe}. Fix the path in KawKaw Settings.`);
    child = spawn(ae.windowsExe, ["-r", scriptPath], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } else {
    throw new Error("After Effects only runs on macOS or Windows.");
  }
  let spawnErr = "";
  child.stderr?.on("data", (d) => (spawnErr += d));

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 400));
    if (fs.existsSync(resultPath)) {
      await new Promise((r) => setTimeout(r, 100));
      const res = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      try { fs.unlinkSync(scriptPath); fs.unlinkSync(resultPath); } catch {}
      if (!res.ok) throw new Error("After Effects: " + res.error);
      return res.result;
    }
    if (spawnErr && /error/i.test(spawnErr)) throw new Error("Could not reach After Effects: " + spawnErr.trim());
  }
  throw new Error("After Effects did not answer. Is it open, and is 'Allow Scripts to Write Files and Access Network' turned on?");
}

/** Build an AE comp that mirrors a Premiere In/Out range (each clip becomes a layer at the same time). */
export function buildRangeCompScript(range) {
  const data = JSON.stringify(range);
  return `
var R = ${data};
var folder = app.project.items.addFolder("KawKaw – " + R.name);
var cache = {};
function footage(p) {
  if (cache[p]) return cache[p];
  var f = new File(p);
  if (!f.exists) return null;
  var io = new ImportOptions(f);
  var it = app.project.importFile(io);
  it.parentFolder = folder;
  cache[p] = it;
  return it;
}
var comp = app.project.items.addComp(R.name, R.width, R.height, 1, Math.max(R.duration, 0.1), R.fps);
comp.parentFolder = folder;
// lowest Premiere track first, so higher tracks end up on top in AE
R.layers.sort(function (a, b) { return (a.kind === b.kind ? 0 : a.kind === "audio" ? -1 : 1) || a.track - b.track; });
var added = 0, missing = [];
for (var i = 0; i < R.layers.length; i++) {
  var L = R.layers[i];
  var src = footage(L.path);
  if (!src) { missing.push(L.path); continue; }
  var lay = comp.layers.add(src);
  var tl = L.start - R.rangeIn;        // where the clip begins inside the comp
  lay.startTime = tl - L.sourceIn;     // so the right source frame lines up
  lay.inPoint = Math.max(0, tl);
  lay.outPoint = Math.min(R.duration, L.end - R.rangeIn);
  lay.name = (L.kind === "audio" ? "A" : "V") + (L.track + 1) + " " + L.name;
  if (L.kind === "audio" && lay.hasVideo) lay.enabled = false;
  if (L.kind === "video" && lay.hasAudio) {
    for (var j = 0; j < R.layers.length; j++) if (R.layers[j].kind === "audio" && R.layers[j].path === L.path) { lay.audioEnabled = false; break; }
  }
  added++;
}
comp.openInViewer();
return { comp: comp.name, layers: added, missing: missing };`;
}
