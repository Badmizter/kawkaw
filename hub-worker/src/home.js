// KawKaw home page served at https://kawkaw.<your-domain>/ (stays up during power cuts — it runs on Cloudflare).
export function homePage(env) {
  const repo = env.GITHUB_REPO || "";
  const rel = repo ? `https://github.com/${repo}/releases/latest` : "#";
  const src = repo ? `https://github.com/${repo}` : "#";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KawKaw — Claude & ChatGPT for Premiere Pro and After Effects</title>
<meta name="description" content="Free app that connects Claude and ChatGPT to Adobe Premiere Pro and After Effects: custom buttons, audio-gap removal, music-video presets and AI gap fill with Kling / Higgsfield.">
<link rel="icon" href="/logo.png"><meta property="og:image" content="/logo.png">
<style>
  :root{--bg:#0b0815;--card:#151027;--line:#2a2247;--text:#efeaff;--dim:#a39bc4;--violet:#9b5cff;--cyan:#22d3ee;--orange:#ff9a3c}
  *{box-sizing:border-box} body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#2a1660 0%,var(--bg) 60%);color:var(--text);font:16px/1.6 -apple-system,"Segoe UI",Inter,sans-serif}
  .wrap{max-width:1040px;margin:0 auto;padding:0 24px}
  nav{display:flex;align-items:center;justify-content:space-between;padding:22px 0}
  nav .b{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px} nav img{width:36px;height:36px}
  nav a{color:var(--dim);text-decoration:none;margin-left:22px;font-size:14px} nav a:hover{color:var(--text)}
  .hero{text-align:center;padding:40px 0 30px}
  .hero img{width:220px;height:220px;filter:drop-shadow(0 20px 60px rgba(155,92,255,.45))}
  h1{font-size:clamp(34px,6vw,58px);line-height:1.05;margin:18px 0 12px;letter-spacing:-.02em}
  h1 span{background:linear-gradient(90deg,var(--cyan),var(--violet),var(--orange));-webkit-background-clip:text;background-clip:text;color:transparent}
  .lead{color:var(--dim);font-size:19px;max-width:680px;margin:0 auto 28px}
  .dl{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
  .btn{display:inline-flex;flex-direction:column;align-items:center;min-width:200px;padding:13px 22px;border-radius:12px;text-decoration:none;color:#fff;font-weight:700;background:linear-gradient(135deg,var(--violet),#6d3cf0);box-shadow:0 10px 30px rgba(155,92,255,.35)}
  .btn small{font-weight:500;opacity:.8;font-size:12px} .btn.alt{background:var(--card);border:1px solid var(--line);box-shadow:none}
  .status{display:inline-flex;align-items:center;gap:8px;margin-top:22px;padding:6px 14px;border:1px solid var(--line);border-radius:99px;color:var(--dim);font-size:13px}
  .dot{width:9px;height:9px;border-radius:50%;background:#666}
  section{padding:46px 0} h2{font-size:28px;margin:0 0 22px;text-align:center}
  .grid{display:flex;flex-wrap:wrap;gap:16px}
  .card{flex:1 1 300px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
  .card h3{margin:0 0 6px;font-size:17px} .card p{margin:0;color:var(--dim);font-size:15px}
  .ic{font-size:24px;margin-bottom:8px}
  ol{color:var(--dim);padding-left:20px;margin:0} ol li{margin:6px 0} b{color:var(--text)}
  code{background:#0a0714;border:1px solid var(--line);padding:2px 6px;border-radius:5px;color:var(--cyan);font-size:13px}
  footer{color:var(--dim);font-size:13px;text-align:center;padding:40px 0 50px;border-top:1px solid var(--line);margin-top:30px}
  footer a{color:var(--dim)}
</style></head><body>
<div class="wrap">
  <nav><div class="b"><img src="/logo.png" alt="">KawKaw</div><div><a href="#features">Features</a><a href="#connect">Connect</a><a href="#hub">Hub</a><a href="${src}">GitHub</a></div></nav>

  <div class="hero">
    <img src="/logo.png" alt="KawKaw logo">
    <h1>Your AI editor inside<br><span>Premiere Pro &amp; After Effects</span></h1>
    <p class="lead">KawKaw connects <b>Claude</b> and <b>ChatGPT</b> to your timeline. You get one-click custom buttons, automatic audio-gap removal, music-video presets, and AI gap fill with Kling and Higgsfield. Free and open source.</p>
    <div class="dl">
      <a class="btn" href="${rel}">Windows<small>KawKaw-Setup.exe</small></a>
      <a class="btn" href="${rel}">Mac · Apple Silicon<small>M1 – M4 .pkg</small></a>
      <a class="btn alt" href="${rel}">Mac · Intel<small>.pkg</small></a>
    </div>
    <div class="status"><span class="dot" id="dot"></span><span id="st">Checking connection…</span></div>
  </div>

  <section id="features">
    <h2>What it does</h2>
    <div class="grid">
      <div class="card"><div class="ic">🎛️</div><h3>Custom buttons</h3><p>Your own button grid in Premiere, including combos that run several actions at once. Or just ask the AI to make one for you.</p></div>
      <div class="card"><div class="ic">🔇</div><h3>Remove audio gaps</h3><p>Select a clip and press the button. The silences are cut and the gaps closed, as one undo step.</p></div>
      <div class="card"><div class="ic">✨</div><h3>AI gap fill</h3><p>Mark In/Out and KawKaw grabs the first and last frame, or you pick your own images. The AI writes the prompt, Kling or Higgsfield generates the clip, and it drops onto the timeline.</p></div>
      <div class="card"><div class="ic">🎬</div><h3>Music-video presets</h3><p>V1 Close-Up Master · V2 Wide · V3 Drone · V4 B-Roll… Name your tracks and add beat markers in one click, and the AI follows your cutting rules.</p></div>
      <div class="card"><div class="ic">🌀</div><h3>After Effects</h3><p>Send an In/Out range to AE as a comp with the same layers and timing, and let the AI script titles, comps and renders.</p></div>
      <div class="card"><div class="ic">🤝</div><h3>Claude or ChatGPT</h3><p>Works with the Claude desktop app and with ChatGPT / ChatGPT Atlas, using the same tools in both.</p></div>
    </div>
  </section>

  <section id="connect">
    <h2>Get started</h2>
    <div class="grid">
      <div class="card"><h3>1 · Install</h3><ol><li>Download the installer for your computer above and double-click it.</li><li>Click <b>Install</b> when Creative Cloud asks to add the panel.</li><li>In Premiere: <b>Window → UXP Plugins → KawKaw</b>.</li></ol></div>
      <div class="card"><h3>2 · Claude</h3><ol><li>Restart the Claude desktop app.</li><li>Ask: <i>"Look at my timeline and name my tracks with my music-video preset."</i></li></ol></div>
      <div class="card"><h3>3 · ChatGPT</h3><ol><li>KawKaw settings → <b>ChatGPT</b> → turn it on and copy your link.</li><li>ChatGPT → <b>Settings → Apps &amp; Connectors → Create</b>, paste it, Authentication: None.</li></ol></div>
    </div>
  </section>

  <section id="hub">
    <h2>KawKaw Hub</h2>
    <div class="card" style="max-width:760px;margin:0 auto">
      <p>Got an invite code? Open KawKaw settings → ChatGPT → <b>Join a KawKaw Hub</b> and paste it. You get a permanent ChatGPT link on <code>kawkaw.nelsonmaita.com</code> with no setup. It keeps working during power cuts at the hub, because a backup runs on Cloudflare.</p>
    </div>
  </section>

  <footer><img src="/logo.png" alt="" width="40"><br>KawKaw · free &amp; open source (MIT) · made by Nelson Maita · <a href="${src}">GitHub</a></footer>
</div>
<script>
fetch("/health").then(r => r.json()).then(h => {
  const d = document.getElementById("dot"), s = document.getElementById("st");
  if (h.originUp) { d.style.background = "#3ee08f"; s.textContent = "Hub online · home server"; }
  else { d.style.background = "#ffb340"; s.textContent = "Hub online · running on Cloudflare backup"; }
}).catch(() => { document.getElementById("st").textContent = "Status unavailable"; });
</script>
</body></html>`;
}
