#!/usr/bin/env node
// kawkaw daemon | mcp | setup | status | uninstall
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, HOME_DIR, loadConfig } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const cmd = process.argv[2] || "help";

function claudeConfigPath() {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function addToClaude() {
  const p = claudeConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let cfg = {};
  if (fs.existsSync(p)) {
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { throw new Error(`${p} is not valid JSON; fix it and run setup again.`); }
    fs.copyFileSync(p, p + ".kawkaw-backup");
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.kawkaw = { command: process.execPath, args: [__filename, "mcp"] };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function addLoginItem() {
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", "com.kawkaw.daemon.plist");
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kawkaw.daemon</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${__filename}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>${path.join(HOME_DIR, "logs", "daemon.err.log")}</string>
</dict></plist>`);
    return plist + "  (run: launchctl load -w \"" + plist + "\")";
  }
  if (process.platform === "win32") {
    const startup = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "KawKaw.vbs");
    fs.writeFileSync(startup, `CreateObject("Wscript.Shell").Run """${process.execPath}"" ""${__filename}"" daemon", 0, False\r\n`);
    return startup;
  }
  return "(login item not supported on this OS)";
}

if (cmd === "daemon") {
  const { startDaemon } = await import("./daemon.js");
  const started = await startDaemon();
  if (!started) process.exit(0);
} else if (cmd === "mcp") {
  const { startMcp } = await import("./mcp.js");
  await startMcp();
} else if (cmd === "setup") {
  loadConfig();
  console.log("✔ Data folder:      " + HOME_DIR);
  console.log("✔ Claude config:    " + addToClaude());
  if (!process.argv.includes("--no-login")) console.log("✔ Start at login:   " + addLoginItem());
  console.log(`\nNext:\n  1. Restart the Claude desktop app.\n  2. Install the Premiere panel (KawKaw.ccx) and open Window > UXP Plugins > KawKaw.\n  3. Settings, API keys and ChatGPT link: http://127.0.0.1:${PORT}/settings`);
} else if (cmd === "open") {
  // Start KawKaw if needed, then open the settings page (used by the app icon / Start menu shortcut).
  const { spawn } = await import("node:child_process");
  let up = false;
  try { up = (await fetch(`http://127.0.0.1:${PORT}/api/status`)).ok; } catch {}
  if (!up) {
    spawn(process.execPath, [__filename, "daemon"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    for (let i = 0; i < 30 && !up; i++) { await new Promise((r) => setTimeout(r, 300)); try { up = (await fetch(`http://127.0.0.1:${PORT}/api/status`)).ok; } catch {} }
  }
  const url = `http://127.0.0.1:${PORT}/settings`;
  const opener = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(opener[0], opener[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
} else if (cmd === "stop") {
  try { await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: "POST" }); console.log("KawKaw stopped."); } catch { console.log("KawKaw was not running."); }
} else if (cmd === "status") {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/status`);
    console.log(JSON.stringify(await r.json(), null, 2));
  } catch { console.log("KawKaw daemon is not running. Start it with: kawkaw daemon"); process.exit(1); }
} else if (cmd === "uninstall") {
  const p = claudeConfigPath();
  if (fs.existsSync(p)) {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    if (cfg.mcpServers) delete cfg.mcpServers.kawkaw;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  }
  for (const f of [path.join(os.homedir(), "Library", "LaunchAgents", "com.kawkaw.daemon.plist"), path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "KawKaw.vbs")]) {
    try { fs.unlinkSync(f); } catch {}
  }
  console.log("Removed KawKaw from Claude and login items. Your settings stay in " + HOME_DIR);
} else {
  console.log("Usage: kawkaw <open|daemon|mcp|setup|status|stop|uninstall>");
}
