#!/usr/bin/env node
// KawKaw Hub CLI (run on your server)
//   node hub/src/cli.js init --public https://kawkaw.example.com --primary wss://kawkaw-hub.example.com/agent [--backup wss://kawkaw.example.com/agent] [--worker https://kawkaw.example.com]
//   node hub/src/cli.js serve
//   node hub/src/cli.js invite "Juan"        → prints the invite code to send to Juan
//   node hub/src/cli.js list | revoke <id> | unrevoke <id> | secret | sync
import { loadData, saveData, createInvite, startHub, syncWorker, HUB_PORT } from "./hub.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf("--" + name); return i >= 0 ? rest[i + 1] : undefined; };
const d = loadData();

switch (cmd) {
  case "serve": startHub(); break;
  case "init": {
    const pub = flag("public"), primary = flag("primary"), backup = flag("backup"), worker = flag("worker");
    if (!pub || !primary) { console.log("Usage: init --public <https url ChatGPT uses> --primary <wss url to this hub>/agent [--backup <wss url of worker>/agent] [--worker <https url of worker>]"); process.exit(1); }
    d.publicBase = pub.replace(/\/$/, "");
    d.agentUrls = [primary, backup].filter(Boolean);
    d.workerUrl = worker || "";
    saveData(d);
    console.log("✔ Hub configured:\n", JSON.stringify({ publicBase: d.publicBase, agentUrls: d.agentUrls, workerUrl: d.workerUrl }, null, 2));
    console.log("\nIf you use the Cloudflare Worker backup, give it this secret (wrangler secret put HUB_SECRET):\n" + d.secret);
    break;
  }
  case "invite": {
    const name = rest.join(" ").trim();
    if (!name) { console.log('Usage: invite "Friend name"'); process.exit(1); }
    const r = createInvite(d, name);
    console.log(`\nInvite for ${name} (id ${r.id}). Send them this code; they paste it in KawKaw → Settings → ChatGPT → Join a KawKaw Hub:\n\n${r.code}\n\nTheir ChatGPT link (KawKaw shows it to them too):\n${r.link}\n`);
    break;
  }
  case "list":
    for (const [id, u] of Object.entries(d.users)) console.log(`${u.revoked ? "✗" : "✓"} ${id.padEnd(28)} ${u.name.padEnd(20)} created ${new Date(u.created).toLocaleDateString()}${u.lastSeen ? "  last seen " + new Date(u.lastSeen).toLocaleString() : ""}`);
    break;
  case "revoke": case "unrevoke": {
    const id = rest[0];
    if (!d.users[id]) { console.log("Unknown id. Use: list"); process.exit(1); }
    d.users[id].revoked = cmd === "revoke";
    saveData(d);
    console.log(`${cmd}d ${id}`);
    try { console.log("worker sync:", JSON.stringify(await syncWorker(d))); } catch (e) { console.log("worker sync failed:", e.message); }
    break;
  }
  case "sync": console.log(JSON.stringify(await syncWorker(d))); break;
  case "secret": console.log(d.secret); break;
  default: console.log(`KawKaw Hub — commands: init, serve, invite "<name>", list, revoke <id>, unrevoke <id>, secret, sync   (port ${HUB_PORT})`);
}
