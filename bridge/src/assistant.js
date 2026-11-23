// KawKaw Assistant: chat with Claude from inside the Premiere panel.
// Two ways to reach Claude:
//   "claude-code": your own Claude login through the Claude Code app (uses your Claude plan)
//   "api":         an Anthropic API key (pay per use, console.anthropic.com)
// Either way Claude gets the same KawKaw tools as the desktop app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./tools.js";
import { DIRS } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GUIDE = `You are the KawKaw assistant inside Adobe Premiere Pro, helping a professional video editor.
Use the KawKaw tools to read and edit the timeline. Before editing, call premiere_get_timeline.
Times are in seconds; tracks are 0-based in tool calls (V1 = 0). Every edit is one undo step (Ctrl+Z).
Follow the user's music-video presets (presets_list) when cutting. Keep replies short and practical.
If an action could change a lot of the edit, say what you'll do in one line, then do it.`;

// ---------------------------------------------------------------- detect Claude Code
let claudeBin; // cached path or null
export function findClaudeCode(force = false) {
  if (claudeBin !== undefined && !force) return claudeBin;
  claudeBin = null;
  const candidates = [];
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    candidates.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch {}
  const home = os.homedir();
  candidates.push(
    path.join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
    path.join(home, ".claude", "local", process.platform === "win32" ? "claude.exe" : "claude"),
    path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude"
  );
  // prefer .exe/.cmd on Windows, executable files elsewhere
  claudeBin = candidates.find((c) => c && fs.existsSync(c) && (process.platform !== "win32" || /\.(exe|cmd)$/i.test(c))) || null;
  return claudeBin;
}

// ---------------------------------------------------------------- tools via in-memory MCP
async function toolClient(call) {
  const server = createServer(call, { client: "assistant" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "kawkaw-assistant", version: "1" });
  await client.connect(b);
  return client;
}

// ---------------------------------------------------------------- sessions
const sessions = new Map(); // id -> { messages (api), ccSession (claude code), busy, proc }

export function resetSession(id) {
  const s = sessions.get(id);
  if (s?.proc) try { s.proc.kill(); } catch {}
  sessions.delete(id);
}

export function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.stopped = true;
  if (s.proc) try { s.proc.kill(); } catch {}
  return true;
}

export function assistantStatus(config) {
  const a = config.assistant;
  const cc = findClaudeCode();
  const mode = a.mode === "auto" ? (cc ? "claude-code" : a.apiKey ? "api" : "none") : a.mode;
  return { mode, claudeCode: !!cc, claudeCodePath: cc, hasApiKey: !!a.apiKey, model: a.model };
}

/** Send one user message. emit({type, ...}) streams progress: text | tool | done | error */
export async function sendMessage(config, call, { sessionId, text }, emit) {
  const st = assistantStatus(config);
  let s = sessions.get(sessionId);
  if (!s) { s = { messages: [], ccSession: null, busy: false }; sessions.set(sessionId, s); }
  if (s.busy) throw new Error("Claude is still working on the last message.");
  s.busy = true; s.stopped = false;
  try {
    if (st.mode === "claude-code") await runClaudeCode(config, s, text, emit);
    else if (st.mode === "api") await runApi(config, call, s, text, emit);
    else throw new Error("No way to reach Claude yet. Install Claude Code and log in with your Claude account, or add an Anthropic API key in KawKaw settings → Assistant.");
  } finally {
    s.busy = false; s.proc = null;
  }
}

// ---------------------------------------------------------------- Claude Code (your Claude login)
async function runClaudeCode(config, s, text, emit) {
  const bin = findClaudeCode();
  if (!bin) throw new Error("Claude Code isn't installed on this computer.");
  const mcpFile = path.join(DIRS.root, "assistant-mcp.json");
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { kawkaw: { command: process.execPath, args: [path.join(__dirname, "cli.js"), "mcp"] } } }, null, 2));
  const workDir = path.join(DIRS.root, "assistant");
  fs.mkdirSync(workDir, { recursive: true });

  const args = ["-p", "--output-format", "stream-json", "--verbose", "--mcp-config", mcpFile, "--strict-mcp-config", "--allowedTools", "mcp__kawkaw"];
  if (config.assistant.claudeCodeModel) args.push("--model", config.assistant.claudeCodeModel);
  if (s.ccSession) args.push("--resume", s.ccSession);
  const prompt = s.ccSession ? text : `${GUIDE}\n\nUser: ${text}`;

  const isCmd = /\.cmd$/i.test(bin);
  const q = (x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x);
  const proc = isCmd
    ? spawn(`${q(bin)} ${args.map(q).join(" ")}`, { shell: true, cwd: workDir, windowsHide: true })
    : spawn(bin, args, { cwd: workDir, windowsHide: true });
  s.proc = proc;
  proc.stdin.end(prompt);

  let buf = "", errText = "", gotResult = false;
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id) s.ccSession = ev.session_id;
        if (ev.type === "assistant") {
          for (const c of ev.message?.content || []) {
            if (c.type === "text" && c.text.trim()) emit({ type: "text", text: c.text });
            if (c.type === "tool_use") emit({ type: "tool", name: String(c.name).replace(/^mcp__kawkaw__/, ""), input: c.input });
          }
        } else if (ev.type === "result") {
          gotResult = true;
          if (ev.is_error) emit({ type: "error", text: ev.result || ev.subtype || "Claude Code error" });
          emit({ type: "done", cost: ev.total_cost_usd });
        }
      }
    });
    proc.stderr.on("data", (d) => (errText += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (s.stopped) { emit({ type: "done", stopped: true }); return resolve(); }
      if (!gotResult) {
        const hint = /login|auth|logged in|api key/i.test(errText) ? " Open a terminal, run `claude`, and log in with your Claude account once." : "";
        return reject(new Error(`Claude Code stopped (code ${code}). ${errText.trim().slice(-300)}${hint}`));
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------- Anthropic API (API key)
async function runApi(config, call, s, text, emit) {
  const a = config.assistant;
  if (!a.apiKey) throw new Error("Add an Anthropic API key in KawKaw settings → Assistant.");
  const client = await toolClient(call);
  try {
    const { tools } = await client.listTools();
    const apiTools = tools.map((t) => ({ name: t.name, description: (t.description || "").slice(0, 1000), input_schema: t.inputSchema || { type: "object", properties: {} } }));
    s.messages.push({ role: "user", content: text });
    for (let turn = 0; turn < 25; turn++) {
      if (s.stopped) { emit({ type: "done", stopped: true }); return; }
      const res = await fetch((process.env.KAWKAW_ANTHROPIC_URL || "https://api.anthropic.com") + "/v1/messages", {
        method: "POST",
        headers: { "x-api-key": a.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: a.model, max_tokens: 4096, system: GUIDE, tools: apiTools, messages: s.messages }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        s.messages.pop(); // let the user retry
        const msg = body?.error?.message || res.statusText;
        throw new Error(res.status === 401 ? "The Anthropic API key was rejected. Check it in KawKaw settings." : /credit|billing|balance/i.test(msg) ? "Your Anthropic API account has no credits. Add credits at console.anthropic.com." : `Claude API error ${res.status}: ${msg}`);
      }
      s.messages.push({ role: "assistant", content: body.content });
      for (const c of body.content) if (c.type === "text" && c.text.trim()) emit({ type: "text", text: c.text });
      const uses = body.content.filter((c) => c.type === "tool_use");
      if (body.stop_reason !== "tool_use" || !uses.length) { emit({ type: "done", usage: body.usage }); return; }
      const results = [];
      for (const u of uses) {
        emit({ type: "tool", name: u.name, input: u.input });
        let r;
        try { r = await client.callTool({ name: u.name, arguments: u.input || {} }); }
        catch (e) { r = { isError: true, content: [{ type: "text", text: "Error: " + e.message }] }; }
        const content = (r.content || []).map((c) =>
          c.type === "image" ? { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } } : { type: "text", text: c.text ?? JSON.stringify(c) }
        );
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: !!r.isError, content: content.length ? content : [{ type: "text", text: "(no output)" }] });
      }
      s.messages.push({ role: "user", content: results });
      // keep history from growing forever: drop old turns but never split a tool_use/tool_result pair
      while (s.messages.length > 40 && s.messages[0].role === "user" && typeof s.messages[0].content === "string" && s.messages.length > 2) {
        const nextUser = s.messages.findIndex((m, idx) => idx > 0 && m.role === "user" && typeof m.content === "string");
        if (nextUser <= 0) break;
        s.messages.splice(0, nextUser);
      }
    }
    emit({ type: "done", note: "Stopped after 25 steps." });
  } finally {
    await client.close().catch(() => {});
  }
}
