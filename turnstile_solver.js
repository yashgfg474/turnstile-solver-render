#!/usr/bin/env node
/* ♛ TURNSTILE SOLVER — local Cloudflare Turnstile token service (no API key).
 *
 *   GET /solve?url=<site url>&sitekey=<0x...>[&timeout=30][&action=login]
 *        → {"success":true,"token":"1.abc…","time":2.31}
 *   GET /health   → pool size + stats
 *   GET /log      → last solves
 *   GET /         → little status page with a live test form
 *
 * CLI:
 *   node turnstile_solver.js [--port 6767] [--pool 4] [--headless]
 *   node turnstile_solver.js --selftest                    (demo key, always passes)
 *   node turnstile_solver.js --solve --url=… --sitekey=…   (one-shot, prints JSON)
 *
 * env: SOLVER_PORT, SOLVER_POOL, SOLVER_TIMEOUT, SOLVER_HEADLESS=1,
 *      PUPPETEER_EXECUTABLE_PATH / CHROME_PATH override the browser.
 *
 * How it works: each solve opens a warm browser context, serves a tiny page
 * AT THE TARGET SITE'S OWN ORIGIN (request interception keeps the real URL,
 * so the widget is minted for the right hostname+sitekey), waits for the
 * Cloudflare widget, clicks the checkbox like a human, and returns the
 * token from cf-turnstile-response.
 */
"use strict";

const http = require("http");
const fs = require("fs");

/* ── args / env ─────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.findIndex(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (i === -1) return dflt;
  const hit = argv[i];
  const eq = hit.indexOf("=");
  if (eq !== -1) return hit.slice(eq + 1);
  const nxt = argv[i + 1];
  if (nxt && !nxt.startsWith("--")) return nxt;
  return true;
};
const PORT = parseInt(arg("port", process.env.SOLVER_PORT || 6767), 10) || 6767;
const POOL_SIZE = Math.max(
  1,
  parseInt(arg("pool", process.env.SOLVER_POOL || 4), 10) || 4
);
const DEFAULT_TIMEOUT =
  Math.max(10, parseFloat(arg("timeout", process.env.SOLVER_TIMEOUT || 30)) || 30);
const HEADLESS = !!(
  arg("headless", false) ||
  process.env.SOLVER_HEADLESS === "1" ||
  process.env.HEADLESS === "1"
);
const SELFTEST = !!arg("selftest", false);
const ONESHOT = !!arg("solve", false);
const DEMO_SITEKEY = "1x00000000000000000000AA"; // cloudflare always-pass test key

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* real tokens are long; the cloudflare demo key returns "XXXX.DUMMY.TOKEN.XXXX" */
const isToken = (t) => !!t && (String(t).length > 50 || /^XXXX\./i.test(String(t)));
const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const logline = (msg) => console.log(`[${now()}] ${msg}`);
const norm = (u) => String(u || "").trim().replace(/\/+$/, "");

/* ── browser discovery ──────────────────────────────────────────────── */
function findChrome() {
  const la = process.env.LOCALAPPDATA || "";
  const cands = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    // patchright / playwright downloaded chromium (preferred when present)
    ...(() => {
      const out = [];
      const base = require("path").join(la, "ms-playwright");
      try {
        for (const d of fs.readdirSync(base)) {
          if (d.toLowerCase().includes("patchright") || d.toLowerCase().includes("chromium")) {
            for (const rel of [
              ["chrome-win", "chrome.exe"],
              ["chrome-linux", "chrome"],
              ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
            ]) {
              const p = require("path").join(base, d, ...rel);
              if (fs.existsSync(p)) out.push(p);
            }
          }
        }
      } catch (e) {}
      return out;
    })(),
    "/repl/tools/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    (process.env.PROGRAMFILES || "") + "\\Google\\Chrome\\Application\\chrome.exe",
    (process.env["PROGRAMFILES(X86)"] || "") + "\\Google\\Chrome\\Application\\chrome.exe",
    (process.env.PROGRAMFILES || "") + "\\Microsoft\\Edge\\Application\\msedge.exe",
    (process.env["PROGRAMFILES(X86)"] || "") + "\\Microsoft\\Edge\\Application\\msedge.exe",
    la + "\\Google\\Chrome\\Application\\chrome.exe",
    la + "\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const p of cands) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return "";
}

function loadPuppeteer() {
  const has = (m) => {
    try {
      require.resolve(m);
      return true;
    } catch (e) {
      return false;
    }
  };
  if (has("puppeteer-extra")) {
    try {
      const extra = require("puppeteer-extra");
      if (has("puppeteer-extra-plugin-stealth")) {
        extra.use(require("puppeteer-extra-plugin-stealth")());
      }
      return { pp: extra, lib: "puppeteer-extra" };
    } catch (e) {}
  }
  if (has("puppeteer")) return { pp: require("puppeteer"), lib: "puppeteer" };
  if (has("puppeteer-core")) return { pp: require("puppeteer-core"), lib: "puppeteer-core" };
  return { pp: null, lib: "" };
}

/* ── stealth patches (same as the cursor login engine) ──────────────── */
const STEALTH_CORE = `
(() => {
  try { Object.defineProperty(navigator, 'webdriver', {get: () => undefined}); } catch (e) {}
  try {
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    if (!window.chrome.runtime.connect) { window.chrome.runtime.connect = () => ({onMessage:{addListener(){}},postMessage(){}}); }
  } catch (e) {}
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return gp.apply(this, [p]);
    };
  } catch (e) {}
  try {
    const q = navigator.permissions && navigator.permissions.query;
    if (q) { navigator.permissions.query = (prm) => prm && prm.name === 'notifications'
      ? Promise.resolve({state: Notification.permission}) : q.call(navigator.permissions, prm); }
  } catch (e) {}
  try { Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8}); } catch (e) {}
  try { Object.defineProperty(navigator, 'deviceMemory', {get: () => 8}); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', {get: () => ['en-US','en']}); } catch (e) {}
})();
`;

/* ── the synthetic page (widget rendered at the target origin) ──────── */
function buildPage(sitekey, action) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>verify</title>
<script>
  window.__tok = "";
  window.__tcb = function (t) { try { window.__tok = t || ""; } catch (e) {} };
  window.__ci = 0;
  window.__err = "";
  window.__remint = function () {
    try {
      window.__tok = "";
      window.__err = "";
      if (!window.turnstile) return false;
      try { window.turnstile.reset(); } catch (e) { return false; }
      return true;
    } catch (e) { return false; }
  };
  window.addEventListener("message", function (m) {
    try {
      if (m.origin !== "https://challenges.cloudflare.com" || !m.data) return;
      if (m.data.event === "interactiveBegin") window.__ci = 1;
      if (m.data.event === "interactiveEnd") window.__ci = 0;
      if (String(m.data.event || "").indexOf("error") >= 0)
        window.__err = JSON.stringify(m.data);
    } catch (e) {}
  });
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body style="background:#ffffff">
<div class="cf-turnstile" data-sitekey="${sitekey}"${
    action ? ` data-action="${action}"` : ""
  } data-callback="__tcb"></div>
</body></html>`;
}

/* ── browser pool ───────────────────────────────────────────────────── */
let browser = null;
let PP = null; // puppeteer module (set in main)
let relaunching = null; // relaunch lock
const warm = []; // idle contexts
let active = 0; // solves in flight
const queue = []; // waiting solvers
const stats = { up: Date.now(), total: 0, ok: 0, fail: 0, ms: 0 };
const recent = [];

async function createCtx() {
  if (typeof browser.createBrowserContext === "function") {
    return await browser.createBrowserContext();
  }
  return await browser.createIncognitoBrowserContext();
}

async function getCtx() {
  while (warm.length) {
    const c = warm.pop();
    try {
      if (!c.__dead) return c;
    } catch (e) {}
  }
  return await createCtx();
}

function putCtx(ctx, ok) {
  try {
    if (ok && !ctx.__dead && warm.length < POOL_SIZE) {
      warm.push(ctx);
      return;
    }
    if (!ok) ctx.__dead = true;
    ctx.close().catch(() => {});
  } catch (e) {}
}

async function withSlot(fn) {
  if (active >= POOL_SIZE) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    if (queue.length) queue.shift()();
  }
}

/* ── page setup (interception + stealth, reused by hot pages) ───────── */
async function setupPage(ctx, siteUrl, siteKey, action) {
  const pg = await ctx.newPage();
  if (!pg.evaluateOnNewDocument) throw new Error("page API missing");
  // headless chrome leaks "HeadlessChrome" in the UA → cloudflare fails it (600010)
  // Use a real Windows Chrome UA to look like a genuine user
  try {
    await pg.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
  } catch (e) {}
  await pg.evaluateOnNewDocument(STEALTH_CORE);
  await pg.setRequestInterception(true);
  const want = norm(siteUrl);
  pg.on("request", (req) => {
    try {
      const u = norm(req.url());
      if (u === want) {
        req.respond({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: buildPage(siteKey, action),
        });
      } else {
        req.continue().catch(() => {});
      }
    } catch (e) {}
  });
  await pg.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  return pg;
}

/* ── wait for the token on a set-up page (poll + human-ish click) ───── */
async function waitToken(pg, timeout, t0) {
  let clicks = 0;
  while (Date.now() - t0 < timeout * 1000) {
    const st = await pg.evaluate(() => {
      let tok = window.__tok || "";
      try {
        if (!tok || tok.length < 50) {
          const i = document.querySelector('input[name="cf-turnstile-response"]');
          if (i && i.value) tok = i.value;
        }
      } catch (e) {}
      try {
        if ((!tok || tok.length < 50) && window.turnstile && window.turnstile.getResponse) {
          const t = window.turnstile.getResponse();
          if (t) tok = t;
        }
      } catch (e) {}
      let box = null;
      try {
        const el = document.querySelector(".cf-turnstile");
        if (el) {
          const r = el.getBoundingClientRect();
          box = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      } catch (e) {}
      return { tok, ci: window.__ci || 0, err: window.__err || "", box };
    });

    if (isToken(st.tok)) {
      return { success: true, token: st.tok, time: (Date.now() - t0) / 1000 };
    }

    const wantClick = st.ci
      ? clicks < 8 && Date.now() - t0 > clicks * 1200
      : Date.now() - t0 > 2200 && clicks < 3 && Date.now() - t0 > clicks * 1500 + 2000;
    if (wantClick && st.box && st.box.w > 8) {
      clicks++;
      const tx = st.box.x + Math.min(28, st.box.w / 3);
      const ty = st.box.y + st.box.h / 2;
      try {
        await pg.mouse.move(tx + 55, ty + 22);
        await sleep(120);
        await pg.mouse.move(tx, ty, { steps: 6 });
        await sleep(80);
        await pg.mouse.click(tx, ty);
      } catch (e) {}
    }
    await sleep(110);
  }
  return { success: false, err: "timeout" };
}

/* ── one solve on an already-acquired context ───────────────────────── */
async function solveOn(ctx, siteUrl, siteKey, timeout, action) {
  const t0 = Date.now();
  let pg = null;
  try {
    pg = await setupPage(ctx, siteUrl, siteKey, action);
    return await waitToken(pg, timeout, t0);
  } catch (e) {
    return { success: false, err: String((e && e.message) || e).slice(0, 160) };
  } finally {
    if (pg) await pg.close().catch(() => {});
  }
}

async function solveOnce(siteUrl, siteKey, timeout, action) {
  let ctx = await getCtx();
  let out = await solveOn(ctx, siteUrl, siteKey, timeout, action);
  if (!out.success) {
    putCtx(ctx, false); // rotate a fresh context on failure
    ctx = await getCtx();
    out = await solveOn(ctx, siteUrl, siteKey, timeout, action);
  }
  putCtx(ctx, out.success);
  return out;
}

/* ── browser launch + auto-recovery (user may close the Chrome window) ─ */
async function launchBrowser() {
  const launchArgs = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--lang=en-US",
    "--window-size=1280,800",
  ];
  return await PP.launch({
    headless: HEADLESS,
    executablePath: state.chrome || undefined,
    defaultViewport: null,
    args: launchArgs,
  });
}

function browserAlive() {
  try {
    if (!browser) return false;
    return typeof browser.connected === "boolean"
      ? browser.connected
      : !!browser.isConnected();
  } catch (e) {
    return false;
  }
}

async function ensureBrowser() {
  if (browserAlive()) return true;
  if (!relaunching) {
    relaunching = (async () => {
      logline("browser disconnected — relaunching…");
      try {
        if (browser) await browser.close().catch(() => {});
      } catch (e) {}
      warm.length = 0;
      for (const hot of hotPages.values()) hot.dead = true; // pages died with the browser
      hotPages.clear();
      browser = await launchBrowser();
      for (let i = 0; i < POOL_SIZE; i++) {
        try {
          warm.push(await createCtx());
        } catch (e) {}
      }
      logline(`browser relaunched (pool ${warm.length})`);
    })().finally(() => {
      relaunching = null;
    });
  }
  await relaunching;
  return true;
}

/* ── fast mode: pre-minted token buffer per site ────────────────────── */
// While the checker logs in (~8-10s per combo), the solver quietly mints
// the NEXT widget token in the background — /solve then returns instantly
// from the buffer. Turnstile tokens stay valid ~5 min; we keep them 4.
const FAST = !(arg("nofast", false) || process.env.SOLVER_FAST === "0");
const BUFFER_TARGET = Math.max(1, parseInt(process.env.SOLVER_BUFFER || 3, 10) || 3);
const MINT_GAP_MS = Math.max(0, parseInt(process.env.SOLVER_MINT_GAP_MS || 1200, 10) || 1200);
const TOKEN_TTL_MS =
  Math.max(60, parseInt(process.env.SOLVER_TOKEN_TTL || 240, 10) || 240) * 1000;
const HOT_MAX = Math.max(1, parseInt(process.env.SOLVER_HOT_MAX || 3, 10) || 3);
const hotPages = new Map();
const hotStats = { cached: 0, minted: 0, dropped: 0 };

function dropHot(hot) {
  if (!hot || hot.dead) return;
  hot.dead = true;
  hotPages.delete(hot.key);
  hotStats.dropped++;
  try {
    hot.pg.close().catch(() => {});
  } catch (e) {}
  putCtx(hot.ctx, false);
}

function evictHot() {
  for (const hot of hotPages.values()) {
    if (!hot.minting && !hot.tokens.length) {
      dropHot(hot);
      return;
    }
  }
}

async function ensureHot(siteUrl, siteKey, action) {
  const key = norm(siteUrl) + "|" + siteKey;
  const have = hotPages.get(key);
  if (have) return have;
  if (hotPages.size >= HOT_MAX) {
    evictHot();
    if (hotPages.size >= HOT_MAX) return null; // all busy — skip buffering
  }
  const ctx = await getCtx();
  let pg;
  try {
    pg = await setupPage(ctx, siteUrl, siteKey, action);
  } catch (e) {
    putCtx(ctx, false);
    return null;
  }
  const hot = {
    key, siteUrl, siteKey, action, ctx, pg,
    tokens: [], minting: false, fails: 0, mints: 0, lastMint: 0, dead: false,
  };
  hotPages.set(key, hot);
  return hot;
}

function popToken(hot) {
  const now = Date.now();
  while (hot.tokens.length) {
    const t = hot.tokens.shift();
    if (now - t.ts < TOKEN_TTL_MS) return t.tok;
  }
  return "";
}

async function mintOn(hot, timeout) {
  if (hot.dead) return { success: false, err: "hot page dead" };
  const t0 = Date.now();
  try {
    if (hot.mints > 0) {
      const ok = await hot.pg.evaluate(() =>
        window.__remint ? window.__remint() : false
      );
      if (!ok) {
        // reset failed — full reload as fallback
        await hot.pg
          .reload({ waitUntil: "domcontentloaded", timeout: 20000 })
          .catch(() => {});
      }
    }
    const out = await waitToken(hot.pg, timeout, t0);
    if (out.success) {
      hot.mints++;
      hot.fails = 0;
      hotStats.minted++;
    } else {
      hot.fails++;
      if (hot.fails >= 3) dropHot(hot);
    }
    hot.lastMint = Date.now();
    return out;
  } catch (e) {
    hot.fails++;
    hot.lastMint = Date.now();
    if (hot.fails >= 3) dropHot(hot);
    return { success: false, err: String((e && e.message) || e).slice(0, 160) };
  }
}

let refillTimer = null;
function scheduleRefillWake(ms) {
  if (refillTimer) return;
  refillTimer = setTimeout(() => {
    refillTimer = null;
    for (const h of hotPages.values()) refillHot(h);
  }, ms);
}
async function refillHot(hot) {
  if (!FAST || !hot || hot.dead || hot.minting) return;
  if (hot.tokens.length >= BUFFER_TARGET) return;
  // never compete with a live /solve request — direct latency wins
  if (active > 0) {
    scheduleRefillWake(2000);
    return;
  }
  const gapLeft = MINT_GAP_MS - (Date.now() - hot.lastMint);
  if (gapLeft > 0) {
    scheduleRefillWake(gapLeft + 30);
    return;
  }
  hot.minting = true;
  try {
    const out = await withSlot(() => mintOn(hot, DEFAULT_TIMEOUT));
    if (out.success && !hot.dead) {
      hot.tokens.push({ tok: out.token, ts: Date.now() });
      logline(
        `pre-mint ok ${out.time.toFixed(1)}s — buffer ${hot.tokens.length}/${BUFFER_TARGET} for ${hot.siteKey.slice(0, 14)}…`
      );
    }
  } finally {
    hot.minting = false;
  }
  if (!hot.dead && hot.tokens.length < BUFFER_TARGET) refillHot(hot);
}

/* ── sitekey auto-fetch (when the caller doesn't know it) ───────────── */
const keyCache = new Map();
async function fetchSitekey(siteUrl) {
  if (keyCache.has(siteUrl)) return keyCache.get(siteUrl);
  try {
    const r = await fetch(siteUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const html = await r.text();
    const pats = [
      /sitekey["'\\]?\s*[:=]\s*["'](0x[A-Za-z0-9_-]{10,})["']/i,
      /data-sitekey=["'](0x[A-Za-z0-9_-]{10,})["']/i,
      /\b(0x4[A-Za-z0-9_-]{18,})\b/,
    ];
    for (const p of pats) {
      const m = html.match(p);
      if (m && m[1]) {
        keyCache.set(siteUrl, m[1]);
        logline(`sitekey auto-fetch ${siteUrl} → ${m[1]}`);
        return m[1];
      }
    }
  } catch (e) {}
  return "";
}

/* ── http api ───────────────────────────────────────────────────────── */
const UI = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Turnstile Solver</title>
<style>
body{font-family:ui-monospace,Consolas,monospace;background:#0d0d0d;color:#ddd;margin:0;padding:24px}
.card{background:#141414;border:1px solid #232323;border-radius:10px;padding:18px;max-width:760px;margin:0 auto 14px}
h1{color:#c084fc;font-size:17px;margin:0 0 4px} small{color:#666}
input{background:#0d0d0d;border:1px solid #2c2c2c;color:#eee;border-radius:6px;padding:8px;width:100%;margin:6px 0;box-sizing:border-box}
button{background:#c084fc;border:0;color:#111;font-weight:700;border-radius:6px;padding:9px 16px;cursor:pointer}
pre{background:#0d0d0d;border:1px solid #222;border-radius:6px;padding:10px;overflow:auto;font-size:12px;max-height:240px}
.ok{color:#6ee7a0}.bad{color:#f87171}
</style></head><body>
<div class="card"><h1>⚡ turnstile solver</h1>
<small>local service — no api key · <span id="st">…</span></small>
<div style="margin-top:12px">
<input id="u" placeholder="https://authenticator.cursor.sh" value="https://authenticator.cursor.sh">
<input id="k" placeholder="sitekey (opt — auto-fetched if empty)">
<button onclick="go()">solve</button>
</div><pre id="out">ready.</pre></div>
<div class="card"><small>recent solves</small><pre id="log"></pre></div>
<script>
async function go(){const o=document.getElementById('out');o.textContent='solving…';
try{const r=await fetch('/solve?url='+encodeURIComponent(u.value)+'&sitekey='+encodeURIComponent(k.value)+'&timeout=40');
const d=await r.json();o.innerHTML=d.success?'<span class=ok>OK '+d.time+'s</span>\\n'+d.token:'<span class=bad>FAIL '+d.err+'</span>';}catch(e){o.textContent=String(e)}}
async function tick(){try{const h=await fetch('/health');const d=await h.json();
document.getElementById('st').textContent='pool '+d.pool+'/'+d.pool_size+' · solves '+d.solves_ok+' ok / '+d.solves_fail+' fail · avg '+(d.avg_s||0)+'s';
const l=await fetch('/log');document.getElementById('log').textContent=(await l.json()).lines.join('\\n');}catch(e){}}
setInterval(tick,2000);tick();
</script></body></html>`;

function send(res, code, body, type) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function handleSolve(q, res) {
  let siteUrl = (q.get("url") || "").trim();
  if (!siteUrl) return send(res, 400, { success: false, err: "missing url" });
  if (!/^https?:\/\//i.test(siteUrl)) siteUrl = "https://" + siteUrl;
  let siteKey = (q.get("sitekey") || "").trim();
  if (!siteKey) siteKey = await fetchSitekey(siteUrl);
  if (!siteKey)
    return send(res, 400, { success: false, err: "missing sitekey (auto-fetch failed — pass ?sitekey=)" });
  const timeout = Math.max(8, parseFloat(q.get("timeout") || DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT);
  const action = (q.get("action") || "").trim();

  await ensureBrowser();

  /* fast path: token already minted for this site → instant reply */
  if (FAST) {
    const hot = hotPages.get(norm(siteUrl) + "|" + siteKey);
    if (hot && !hot.dead) {
      const tok = popToken(hot);
      if (tok) {
        hotStats.cached++;
        stats.total++;
        stats.ok++;
        const line = `CACHE 0.0s  ${norm(siteUrl).slice(-46)}  ${siteKey.slice(0, 14)}…  ${tok.slice(0, 22)}…`;
        recent.unshift(`[${now()}] ${line}`);
        if (recent.length > 40) recent.pop();
        logline(line);
        refillHot(hot).catch(() => {}); // top the buffer back up
        return send(res, 200, {
          success: true,
          token: tok,
          time: 0,
          cached: true,
          url: siteUrl,
          sitekey: siteKey,
          by: "turnstile_solver.js",
        });
      }
    }
  }

  const t0 = Date.now();
  const out = await withSlot(() =>
    solveOnce(siteUrl, siteKey, timeout, action).catch((e) => ({
      success: false,
      err: String((e && e.message) || e),
    }))
  );
  const ms = Date.now() - t0;
  stats.total++;
  stats.ms += ms;
  if (out.success) stats.ok++;
  else stats.fail++;
  const line = `${out.success ? "OK  " : "FAIL"} ${(ms / 1000).toFixed(1)}s  ${
    norm(siteUrl).slice(-46)
  }  ${siteKey.slice(0, 14)}…  ${out.success ? String(out.token).slice(0, 22) + "…" : out.err || ""}`;
  recent.unshift(`[${now()}] ${line}`);
  if (recent.length > 40) recent.pop();
  logline(line);
  // start the background pre-mint so the NEXT combo is instant
  if (FAST && out.success) {
    (async () => {
      try {
        const hot = await ensureHot(siteUrl, siteKey, action);
        if (hot && !hot.dead) refillHot(hot).catch(() => {});
      } catch (e) {}
    })().catch(() => {});
  }
  send(res, 200, { ...out, url: siteUrl, sitekey: siteKey, by: "turnstile_solver.js" });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (u.pathname === "/solve") return void handleSolve(u.searchParams, res);
  if (u.pathname === "/warm") {
    let siteUrl = (u.searchParams.get("url") || "").trim();
    if (siteUrl && !/^https?:\/\//i.test(siteUrl)) siteUrl = "https://" + siteUrl;
    let siteKey = (u.searchParams.get("sitekey") || "").trim();
    const action = (u.searchParams.get("action") || "").trim();
    if (!siteUrl) return send(res, 400, { ok: false, err: "missing url" });
    (async () => {
      if (!siteKey) siteKey = await fetchSitekey(siteUrl);
      if (!siteKey || !FAST) return;
      const hot = await ensureHot(siteUrl, siteKey, action);
      if (hot && !hot.dead) refillHot(hot).catch(() => {});
    })().catch(() => {});
    return send(res, 200, {
      ok: true,
      fast: FAST,
      buffer_target: BUFFER_TARGET,
      note: "pre-minting in background — check /health for the buffer",
    });
  }
  if (u.pathname === "/health") {
    let buffered = 0;
    for (const h of hotPages.values()) buffered += h.tokens.length;
    return send(res, 200, {
      ok: true,
      fast: FAST,
      pool: warm.length,
      pool_size: POOL_SIZE,
      active,
      queued: queue.length,
      solves_ok: stats.ok,
      solves_fail: stats.fail,
      avg_s: stats.total ? Math.round((stats.ms / stats.total) / 100) / 10 : 0,
      cached_ok: hotStats.cached,
      hot_sites: hotPages.size,
      buffered,
      buffer_target: BUFFER_TARGET,
      preminted: hotStats.minted,
      uptime_s: Math.round((Date.now() - stats.up) / 1000),
      lib: state.lib,
      chrome: state.chrome ? state.chrome.split(/[\\/]/).pop() : "",
    });
  }
  if (u.pathname === "/log") return send(res, 200, { lines: recent });
  return send(res, 200, UI, "text/html; charset=utf-8");
});
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.error(
      `[!] port ${PORT} is already in use — another solver is probably running.`
    );
    console.error(`    → just open http://127.0.0.1:${PORT} (or close the other window).`);
    process.exit(1);
  }
  console.error("server error:", (e && e.stack) || e);
  process.exit(1);
});

/* ── boot ───────────────────────────────────────────────────────────── */
const state = { lib: "", chrome: "" };

async function oneShot(url, sitekey, timeout) {
  const out = await withSlot(() => solveOnce(url, sitekey, timeout || DEFAULT_TIMEOUT, ""));
  console.log(JSON.stringify(out, null, 2));
  return out.success ? 0 : 2;
}

async function main() {
  const { pp, lib } = loadPuppeteer();
  PP = pp;
  state.lib = lib;
  state.chrome = findChrome();
  if (!pp) {
    console.error("puppeteer / puppeteer-core not found — run:  npm install");
    process.exit(1);
  }
  logline(`browser lib: ${lib} | chrome: ${state.chrome || "(bundled)"}`);
  browser = await launchBrowser();

  if (SELFTEST) {
    logline(`selftest — 3 solves on the demo sitekey (${DEMO_SITEKEY})`);
    let ok = 0;
    for (let i = 1; i <= 3; i++) {
      const t0 = Date.now();
      const out = await solveOnce("https://example.com/", DEMO_SITEKEY, DEFAULT_TIMEOUT, "");
      const took = ((Date.now() - t0) / 1000).toFixed(1);
      if (out.success) {
        ok++;
        logline(`selftest ${i}/3  OK in ${took}s  token ${String(out.token).slice(0, 26)}…`);
      } else {
        logline(`selftest ${i}/3  FAIL in ${took}s  ${out.err}`);
      }
      await sleep(300);
    }
    logline(`selftest done — ${ok}/3 passed`);
    await browser.close().catch(() => {});
    process.exit(ok > 0 ? 0 : 1);
  }

  if (ONESHOT) {
    const url = String(arg("url", "") || "").trim();
    const key = String(arg("sitekey", "") || "").trim() || (await fetchSitekey(url));
    if (!url || !key) {
      console.error("usage: --solve --url=<site> [--sitekey=<0x…>]");
      process.exit(1);
    }
    const rc = await oneShot(url, key, parseFloat(arg("timeout", "") || 0) || undefined);
    await browser.close().catch(() => {});
    process.exit(rc);
  }

  for (let i = 0; i < POOL_SIZE; i++) {
    warm.push(await createCtx());
  }
  server.listen(PORT, "0.0.0.0", () => {
    logline(`════════ TURNSTILE SOLVER ════════`);
    logline(`listening on http://127.0.0.1:${PORT}`);
    logline(`  solve : /solve?url=<site>&sitekey=<0x…>  (sitekey optional)`);
    logline(`  warm  : /warm?url=…&sitekey=…          (pre-mint tokens)`);
    logline(`  health: /health        page: /`);
    logline(`pool ${POOL_SIZE} · timeout ${DEFAULT_TIMEOUT}s · headless ${HEADLESS ? "yes" : "no"}`);
    logline(
      FAST
        ? `FAST mode ON — keeps ${BUFFER_TARGET} pre-minted token(s) per site (instant /solve)`
        : "FAST mode OFF"
    );
    if (!HEADLESS) logline("browser window is open — that's normal, don't close it");
  });
}

main().catch((e) => {
  console.error("fatal:", (e && e.stack) || e);
  process.exit(1);
});
