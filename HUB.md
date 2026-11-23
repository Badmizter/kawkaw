# KawKaw Hub: give your friends a permanent ChatGPT link on your domain

The hub lets friends use KawKaw with ChatGPT through **your** domain. They don't need a Cloudflare account, a server, or any router changes. They paste one invite code into KawKaw and get a permanent link like `https://kawkaw.yourdomain.com/u/juan-1a2b3c/…`.

It's built to survive power cuts:

```
                          ┌──────────── kawkaw.yourdomain.com (Cloudflare Worker) ────────────┐
 ChatGPT ──https──────────▶  1. home server up?  → forward to kawkaw-hub.yourdomain.com      │
                          │  2. server down?     → relay through the backup connection       │
                          └─────────────┬───────────────────────────────┬─────────────────────┘
                                        │ (Cloudflare Tunnel)            │ backup WebSocket
                              Home server: KawKaw Hub  ◀── primary ──  Friend's KawKaw ── Premiere
```

Every friend's KawKaw keeps **two** connections open, one to your server and one to the Worker. When your server loses power, the Worker notices within seconds and serves the requests itself. Same link, nothing to change in ChatGPT. Revoking a friend applies to both.

Your friends' own power cuts are different: if *their* computer is off, ChatGPT gets a clear "KawKaw is offline" message.

## What you need
- A domain on Cloudflare (e.g. nelsonmaita.com) and a server running Cloudflare Tunnel
- Node.js 20+ on the server
- A free Cloudflare account for the Worker (same account as the domain)

## 1. Hub on your server
```bash
git clone https://github.com/Badmizter/kawkaw.git ~/KawKaw && cd ~/KawKaw && npm install --omit=dev
node hub/src/cli.js init \
  --public  https://kawkaw.yourdomain.com \
  --primary wss://kawkaw-hub.yourdomain.com/agent \
  --backup  wss://kawkaw.yourdomain.com/agent \
  --worker  https://kawkaw.yourdomain.com
sudo cp hub/kawkaw-hub.service /etc/systemd/system/   # edit User and WorkingDirectory first
sudo systemctl daemon-reload && sudo systemctl enable --now kawkaw-hub
```
In your Cloudflare Tunnel, add the hostname **kawkaw-hub.yourdomain.com → http://localhost:47400**.

## 2. Backup Worker on Cloudflare
```bash
cd hub-worker && npm install
npx wrangler login
node ../hub/src/cli.js secret | npx wrangler secret put HUB_SECRET
# edit wrangler.toml: routes pattern = kawkaw.yourdomain.com, ORIGIN = https://kawkaw-hub.yourdomain.com
npx wrangler deploy
```
`kawkaw.yourdomain.com` must **not** also be a hostname in your tunnel. The Worker owns it.

Check: `https://kawkaw.yourdomain.com/health` should show `"originUp": true`.

## 3. Invite people
- Admin page (from your home network or Tailscale only): `http://<server-ip>:47400/admin` → type a name → **Create invite** → send the code.
- Or on the server: `node hub/src/cli.js invite "Juan"`

Your friend opens KawKaw → Settings → ChatGPT → **Join a KawKaw Hub**, pastes the code, presses **Turn on ChatGPT**, and copies the link into ChatGPT. Use an invite for yourself too, so your own KawKaw also gets the backup.

Revoke from the admin page or `node hub/src/cli.js revoke <id>`. It disconnects them and updates the backup.

## Power-outage checklist for the server
- Make the server **power on by itself when electricity returns** (BIOS "restore on AC power loss"; Intel iMacs running Linux need a small `setpci` tweak).
- `cloudflared` and `kawkaw-hub` enabled as services so both start at boot.
- A small UPS/inverter on the **router and modem** helps the most, since the server is useless without internet.
- Even if none of that works, the Worker backup keeps every friend online as long as *their* computer has power and internet.

## Costs
The Worker and Durable Objects fit in Cloudflare's free plan for a group of friends. If someone generates AI clips, that bills **their** Kling/Higgsfield keys, never yours.
