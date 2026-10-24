"use strict";
/* Mo'min — Kun tartibi · server (Render + Neon)
   - email + parol bilan ro'yxatdan o'tish / kirish (scrypt + imzolangan token)
   - har bir foydalanuvchi uchun "momin:*" kalit-qiymatlar ombori
   - DATABASE_URL (Neon PostgreSQL) bo'lsa — o'sha baza; bo'lmasa data.json fayl (mahalliy sinov) */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { promisify } = require("util");
const { createStore, explainDbError } = require("./db");
const { createImageStore, decodeImage, sniffType, isImgKey, FREE_BYTES } = require("./storage");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? null : "dev-secret-change-me");
if (!SECRET) { console.error("✖ JWT_SECRET o'rnatilmagan! (Render'da Environment bo'limiga qo'shing.)"); process.exit(1); }
const TOKEN_DAYS = 90;

/* ───────────── Ombor ───────────── */
let db;
try { db = createStore(process.env); }
catch (e) { console.error("✖ " + (e.hint || e.message)); process.exit(1); }

/* Rasmlar uchun object storage (sozlanmagan bo'lsa — rasmlar avvalgidek bazada) */
const imgs = createImageStore(process.env);
const MIG = { running: false, moved: 0, failed: 0, last: null, done: false };

/* Yozuv vaqtlari bu jarayonda har doim ortib boradi (bir millisekundda ikki yozuv bo'lsa ham to'qnashmaydi). */
let lastTs = 0;
const nextTs = () => (lastTs = Math.max(Date.now(), lastTs + 1));

/* ───────────── Parol va token ───────────── */
const scrypt = promisify(crypto.scrypt);
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return salt.toString("hex") + ":" + h.toString("hex");
}
async function checkPw(pw, stored) {
  const [s, h] = String(stored).split(":");
  if (!s || !h) return false;
  const x = await scrypt(pw, Buffer.from(s, "hex"), 64);
  const y = Buffer.from(h, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const b64 = b => Buffer.from(b).toString("base64url");
function sign(uid) {
  const body = b64(JSON.stringify({ u: uid, e: Date.now() + TOKEN_DAYS * 864e5 }));
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verify(tok) {
  if (!tok || tok.indexOf(".") < 0) return null;
  const [body, sig] = tok.split(".");
  const ok = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(String(sig)), b = Buffer.from(ok);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.e > Date.now() ? p.u : null; } catch (e) { return null; }
}

/* ───────────── Ilova ───────────── */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Link-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.path.indexOf("/api/") === 0) res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
/* ───────────── Hisoblagichlar (Sozlamalar → Server va baza) ─────────────
   Xotirada yig'iladi va bazaga kamdan-kam yoziladi (to'xtashda, statistika so'ralganda, yozuvlar bilan birga ≥10 daq.),
   shuning uchun Neon uxlashiga xalaqit bermaydi. */
const monthKey = () => new Date().toISOString().slice(0, 7);
const CNT = { req: 0, out: 0, inb: 0 };
let lastUpTick = Date.now(), lastFlush = Date.now();
const STARTED = Date.now();
app.use((req, res, next) => {
  CNT.req++;
  CNT.inb += Number(req.headers["content-length"]) || 0;
  res.on("finish", () => { CNT.out += Number(res.getHeader("content-length")) || 0; });
  next();
});
async function flushCounters() {
  const now = Date.now(), m = monthKey();
  const add = { ["up:" + m]: (now - lastUpTick) / 1000, ["req:" + m]: CNT.req, ["out:" + m]: CNT.out, ["in:" + m]: CNT.inb };
  lastUpTick = now; lastFlush = now; CNT.req = 0; CNT.out = 0; CNT.inb = 0;
  try { await db.metaAdd(add); }
  catch (e) { CNT.req += add["req:" + m]; CNT.out += add["out:" + m]; CNT.inb += add["in:" + m]; lastUpTick -= add["up:" + m] * 1000; throw e; }
}
const maybeFlush = () => { if (Date.now() - lastFlush > 10 * 60e3) flushCounters().catch(() => {}); };

function memLimit() {
  const env = Number(process.env.MEM_LIMIT_MB); if (env > 0) return env * 1024 * 1024;
  const free = process.env.RENDER ? 512 * 1024 * 1024 : Infinity;   // Render bepul reja: 512 MB
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try { const v = fs.readFileSync(f, "utf8").trim(); const n = Number(v); if (n > 0 && n < os.totalmem() * 2 && n < 1e15) return Math.min(n, free); } catch (e) {}
  }
  return process.env.RENDER ? 512 * 1024 * 1024 : os.totalmem();
}
let cpuPrev = { t: Date.now(), u: process.cpuUsage() };
function cpuPct() {
  const now = Date.now(), u = process.cpuUsage(), dt = (now - cpuPrev.t) * 1000;
  const used = (u.user - cpuPrev.u.user) + (u.system - cpuPrev.u.system); cpuPrev = { t: now, u };
  return dt > 0 ? Math.min(100, Math.round(used / dt * 1000) / 10) : 0;
}

/* Neon API (ixtiyoriy): NEON_API_KEY va NEON_PROJECT_ID qo'shilsa — hisoblash soatlari, trafik va h.k. */
let neonCache = null;
async function neonInfo() {
  const key = process.env.NEON_API_KEY, pid = process.env.NEON_PROJECT_ID;
  if (!key || !pid) return { configured: false };
  if (neonCache && Date.now() - neonCache.t < 5 * 60e3) return neonCache.v;
  let v;
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch("https://console.neon.tech/api/v2/projects/" + encodeURIComponent(pid), { headers: { Authorization: "Bearer " + key, Accept: "application/json" }, signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) v = { configured: true, error: r.status === 401 ? "NEON_API_KEY noto'g'ri" : r.status === 404 ? "NEON_PROJECT_ID topilmadi" : "Neon API: " + r.status };
    else {
      const p = (await r.json()).project || {};
      const num = x => (typeof x === "number" && isFinite(x)) ? x : null;
      v = { configured: true, name: p.name || null, region: p.region_id || null, pgVersion: p.pg_version || null,
            computeSec: num(p.compute_time_seconds), activeSec: num(p.active_time_seconds), cpuSec: num(p.cpu_used_sec),
            writtenBytes: num(p.written_data_bytes), transferBytes: num(p.data_transfer_bytes),
            storageBytes: num(p.synthetic_storage_size), periodStart: p.consumption_period_start || null, periodEnd: p.consumption_period_end || null };
    }
  } catch (e) { v = { configured: true, error: "Neon API'ga ulanib bo'lmadi" }; }
  neonCache = { t: Date.now(), v }; return v;
}

app.use(express.json({ limit: "25mb" }));

// oddiy tezlik cheklovi (IP bo'yicha, xotirada)
function makeLimiter(max, windowMs) {
  const hits = new Map();
  const check = ip => {
    const now = Date.now();
    const a = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (a.length >= max) { hits.set(ip, a); return true; }
    a.push(now); hits.set(ip, a); return false;
  };
  check.sweep = () => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < windowMs)) hits.delete(k); };
  return check;
}
const loginLimit = makeLimiter(20, 15 * 60e3);
const healthLimit = makeLimiter(10, 60e3);
function limited(req, res) {
  if (loginLimit(req.ip)) { res.status(429).json({ error: "Juda ko'p urinish. 15 daqiqadan keyin qayta urinib ko'ring." }); return true; }
  return false;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DB_BUSY = "Ma'lumotlar bazasi hozir uyg'onmoqda yoki band. Bir necha soniyadan keyin qayta urinib ko'ring.";
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e && (e.transient || (e.dbError && e.hint))) {
    // Neon uxlayotgan/uzilgan paytda — mijoz keyinroq o'zi qayta urinadi (503)
    console.error("DB vaqtincha mavjud emas:", e.message);
    return res.status(503).set("Retry-After", "5").json({ error: e.transient ? DB_BUSY : (e.hint || DB_BUSY) });
  }
  console.error(e);
  res.status(500).json({ error: "Server xatosi" });
});
const guard = fn => (req, res, next) => {
  const h = req.headers.authorization || "";
  const uid = verify(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!uid) return res.status(401).json({ error: "Kirish talab qilinadi" });
  req.uid = uid; wrap(fn)(req, res);
};

/* Bazaga TEGMAYDI — Render shuni tekshiradi va uni tashqi "uyg'otuvchi" ham chaqirishi mumkin.
   (Baza so'rovi bo'lsa, Neon hech qachon uxlamas va bepul soatlar tez tugardi.) */
app.get("/api/health", (req, res) => res.json({ ok: true, store: db.kind, uptime: Math.round(process.uptime()), time: Date.now() }));

/* Bazaga ulanishni qo'lda tekshirish uchun (brauzerda oching). Neon uxlab yotgan bo'lsa — uni uyg'otadi. */
app.get("/api/health/db", async (req, res) => {
  if (healthLimit(req.ip)) return res.status(429).json({ ok: false, error: "Juda ko'p so'rov — bir daqiqadan keyin urinib ko'ring." });
  const t0 = Date.now();
  try { await db.ping(); res.json({ ok: true, store: db.kind, ms: Date.now() - t0 }); }
  catch (e) {
    console.error("health/db:", e.message);
    res.status(503).json({ ok: false, store: db.kind, ms: Date.now() - t0, error: explainDbError(e) || "Bazaga ulanib bo'lmadi." });
  }
});

app.post("/api/register", wrap(async (req, res) => {
  if (limited(req, res)) return;
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const pw = String((req.body || {}).password || "");
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: "Email noto'g'ri." });
  if (pw.length < 6) return res.status(400).json({ error: "Parol kamida 6 belgi bo'lsin." });
  if (pw.length > 200) return res.status(400).json({ error: "Parol juda uzun." });
  const taken = () => res.status(409).json({ error: "Bu email allaqachon ro'yxatda — “Kirish”ni bosing." });
  if (await db.findUser(email)) return taken();
  let u;
  try { u = await db.createUser(email, await hashPw(pw)); }
  catch (e) { if (e && e.code === "EXISTS") return taken(); throw e; }
  res.json({ token: sign(u.id), email: u.email });
}));

app.post("/api/login", wrap(async (req, res) => {
  if (limited(req, res)) return;
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const pw = String((req.body || {}).password || "").slice(0, 200);
  const bad = () => res.status(401).json({ error: "Email yoki parol noto'g'ri." });
  const u = await db.findUser(email);
  if (!u) { await hashPw(pw); return bad(); }
  if (!(await checkPw(pw, u.pw))) return bad();
  res.json({ token: sign(u.id), email: u.email });
}));

app.get("/api/me", guard(async (req, res) => {
  const u = await db.getUser(req.uid);
  if (!u) return res.status(401).json({ error: "Foydalanuvchi topilmadi" });
  res.json({ email: u.email });
}));

/* Sinxron so'rovi har ~15 soniyada keladi. Agar bu jarayon "ma'lumot o'zgarmagan" deb ishonchli bilsa,
   javobni xotiradan beramiz — shunda Neon bo'sh paytda uxlay oladi (bepul soatlar tejaladi).
   Render bepul rejasida server bitta nusxada ishlaydi, shuning uchun bu xavfsiz; TTL — qo'shimcha ehtiyot. */
const SEEN_TTL = 15 * 60e3;
const seen = new Map();          // uid → { mark: shu vaqtdan keyin yozuv yo'q, exp }
let writeSeq = 0;                // har yozuvda oshadi — o'qish paytida yozuv bo'lib o'tganini bilish uchun
const seenBump = (uid, ts) => { writeSeq++; const s = seen.get(uid); if (s) s.mark = Math.max(s.mark, ts); };
const seenDrop = uid => { writeSeq++; seen.delete(uid); };
const POLL_CACHE = process.env.NO_POLL_CACHE !== "1";

// ma'lumot: ?since=<ms>  → faqat o'zgargan kalitlar. Snapshotlar (__snap:) alohida.
app.get("/api/data", guard(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const s = seen.get(req.uid);
  if (POLL_CACHE && since > 0 && s && s.exp > Date.now() && since >= s.mark) return res.json({ data: {}, ts: since, now: Date.now() });
  const seq = writeSeq;
  const rows = await db.getAll(req.uid, since, "momin:");
  const data = {}; let max = since;
  for (const r of rows) { data[r.k] = r.v; if (r.updated > max) max = r.updated; }
  if (POLL_CACHE && seq === writeSeq) seen.set(req.uid, { mark: max, exp: Date.now() + SEEN_TTL });
  res.json({ data, ts: max, now: Date.now() });
}));

app.post("/api/data", guard(async (req, res) => {
  const items = (req.body || {}).items;
  if (!items || typeof items !== "object" || Array.isArray(items)) return res.status(400).json({ error: "items kerak" });
  const clean = {};
  for (const [k, v] of Object.entries(items)) {
    if (k.indexOf("momin:") !== 0 && k.indexOf("__snap:") !== 0) continue;
    clean[k] = v === null ? null : String(v).replace(/\u0000/g, "");   // PostgreSQL matnida NUL belgi bo'lmaydi
  }
  // object storage yoqilgan bo'lsa, rasm kalitlari bazaga emas, storage'ga ketadi
  if (imgs.enabled) {
    for (const k of Object.keys(clean)) {
      if (!isImgKey(k)) continue;
      const v = clean[k]; delete clean[k];
      try {
        if (v === null || v === "") { await imgs.del(req.uid, k); await db.imgDel(req.uid, k); await db.kvDel(req.uid, k); }
        else { const d = decodeImage(v); if (d) { const type = sniffType(d.buf) || d.type; await imgs.put(req.uid, k, d.buf, type); await db.imgUpsert(req.uid, k, d.buf.length, type, Date.now()); } }
      } catch (e) { clean[k] = v; }   // storage ishlamasa — eski usulda bazaga
    }
  }
  const ts = nextTs();
  await db.setMany(req.uid, clean, ts);
  seenBump(req.uid, ts);
  res.json({ ok: true, ts });
  maybeFlush();
}));

app.delete("/api/data", guard(async (req, res) => { await db.wipe(req.uid); seenDrop(req.uid); res.json({ ok: true }); }));

app.get("/api/snaps", guard(async (req, res) => {
  const rows = await db.getAll(req.uid, 0, "__snap:");
  res.json({ dates: rows.map(r => r.k.slice(7)).sort() });
}));
app.get("/api/snaps/:d", guard(async (req, res) => {
  const v = await db.getOne(req.uid, "__snap:" + req.params.d);
  if (v === null) return res.status(404).json({ error: "Topilmadi" });
  res.json({ value: v });
}));

app.delete("/api/account", guard(async (req, res) => {
  if (imgs.enabled) { for (const r of await db.imgList(req.uid)) { try { await imgs.del(req.uid, r.k); } catch (e) {} } }
  await db.deleteUser(req.uid); seenDrop(req.uid); res.json({ ok: true }); }));

/* ───────────── Ilovalarni ulash (kalit bilan, faqat o'qish) ─────────────
   Har bir hisobning bitta "ulash kaliti" bor: MOMIN-XXXXX-XXXXX-XXXXX-XXXXX.
   Boshqa ilova (Hisob, Vaqt Banki) shu kalit bilan GET /api/link/summary dan qisqa xulosani o'qiy oladi — boshqa hech narsani emas. */
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newLinkKey = () => { const b = crypto.randomBytes(20); let o = ""; for (let i = 0; i < 20; i++) o += B32[b[i] % 32]; return "MOMIN-" + o.match(/.{5}/g).join("-"); };
const LINK_RE = /^[A-Z]{2,12}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/;
const linkLimit = makeLimiter(60, 60e3);
app.get("/api/link/key", guard(async (req, res) => {
  let k = await db.linkGet(req.uid);
  if (!k) { k = newLinkKey(); await db.linkSet(req.uid, k); }
  res.json({ key: k });
}));
app.post("/api/link/key", guard(async (req, res) => { const k = newLinkKey(); await db.linkSet(req.uid, k); res.json({ key: k }); }));
app.get("/api/link/summary", wrap(async (req, res) => {
  if (linkLimit(req.ip)) return res.status(429).json({ error: "Juda ko'p so'rov" });
  const key = String(req.headers["x-link-key"] || req.query.key || "").trim().toUpperCase();
  if (!LINK_RE.test(key)) return res.status(401).json({ ok: false, error: "Kalit noto'g'ri" });
  const uid = await db.linkFind(key);
  if (!uid) return res.status(401).json({ ok: false, error: "Kalit noto'g'ri" });
  let summary = null; try { summary = JSON.parse(await db.getOne(uid, "momin:link:summary")); } catch (e) {}
  res.json({ ok: true, app: "momin", name: "Mo'min — Kun tartibi", version: 1, summary, time: Date.now() });
}));

/* ───────────── Rasmlar (object storage) ───────────── */
const imgKeyOf = req => { const k = String(req.query.k || ""); return isImgKey(k) ? k : null; };
app.get("/api/img/list", guard(async (req, res) => {
  if (!imgs.enabled) return res.json({ enabled: false, keys: [] });
  const rows = await db.imgList(req.uid);
  res.json({ enabled: true, keys: rows.map(r => r.k), items: rows });
}));
app.put("/api/img", express.raw({ type: () => true, limit: "8mb" }), guard(async (req, res) => {
  if (!imgs.enabled) return res.status(501).json({ error: "Object storage sozlanmagan", code: "NO_STORAGE" });
  const k = imgKeyOf(req); if (!k) return res.status(400).json({ error: "Rasm kaliti noto'g'ri" });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const type = sniffType(buf);
  if (!type) return res.status(415).json({ error: "Faqat JPEG, PNG, WEBP yoki GIF rasm qabul qilinadi" });
  try { await imgs.put(req.uid, k, buf, type); }
  catch (e) { console.error("S3 put:", e.message); return res.status(502).json({ error: imgs.state.error || "Rasmni saqlab bo'lmadi" }); }
  await db.imgUpsert(req.uid, k, buf.length, type, Date.now());
  res.json({ ok: true, size: buf.length });
}));
app.get("/api/img", guard(async (req, res) => {
  if (!imgs.enabled) return res.status(501).json({ error: "Object storage sozlanmagan", code: "NO_STORAGE" });
  const k = imgKeyOf(req); if (!k) return res.status(400).json({ error: "Rasm kaliti noto'g'ri" });
  let o; try { o = await imgs.get(req.uid, k); }
  catch (e) { console.error("S3 get:", e.message); return res.status(502).json({ error: imgs.state.error || "Rasmni olib bo'lmadi" }); }
  if (!o) return res.status(404).json({ error: "Topilmadi" });
  res.set("Content-Type", o.type).set("Cache-Control", "private, no-cache").send(o.body);
}));
app.delete("/api/img", guard(async (req, res) => {
  if (!imgs.enabled) return res.status(501).json({ error: "Object storage sozlanmagan", code: "NO_STORAGE" });
  const k = imgKeyOf(req); if (!k) return res.status(400).json({ error: "Rasm kaliti noto'g'ri" });
  try { await imgs.del(req.uid, k); } catch (e) { console.error("S3 del:", e.message); return res.status(502).json({ error: imgs.state.error || "O'chirib bo'lmadi" }); }
  await db.imgDel(req.uid, k); await db.kvDel(req.uid, k).catch(() => {});
  res.json({ ok: true });
}));

/* Bazada (kv) saqlangan eski rasmlarni object storage'ga ko'chirish — fonda, 20 tadan */
async function migrateImages() {
  if (!imgs.enabled || MIG.running) return; MIG.running = true;
  try {
    if (!(await imgs.check())) { MIG.last = imgs.state.error; return; }
    for (let round = 0; round < 500; round++) {
      const rows = await db.kvImgBatch(20); if (!rows.length) { MIG.done = true; break; }
      let progress = 0;
      for (const r of rows) {
        const d = decodeImage(r.v);
        try {
          if (d) { const type = sniffType(d.buf) || d.type; await imgs.put(r.uid, r.k, d.buf, type); await db.imgUpsert(r.uid, r.k, d.buf.length, type, Date.now()); MIG.moved++; }
          await db.kvDel(r.uid, r.k); progress++;
        } catch (e) { MIG.failed++; MIG.last = e.hint || e.message; }
      }
      if (!progress) break;
    }
    if (MIG.moved) console.log("Rasmlar object storage'ga ko'chirildi:", MIG.moved, "ta");
  } catch (e) { MIG.last = e.message; console.error("Ko'chirish:", e.message); }
  finally { MIG.running = false; }
}

/* Server va baza ko'rsatkichlari — faqat egasi (birinchi ro'yxatdan o'tgan hisob yoki ADMIN_EMAILS) ko'radi */
app.get("/api/stats", guard(async (req, res) => {
  try { await flushCounters(); } catch (e) {}
  const st = await db.stats(req.uid);
  const is = await db.imgStats(req.uid), pend = await db.kvImgCount();
  const me = await db.getUser(req.uid);
  const admins = String(process.env.ADMIN_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const isOwner = admins.length ? !!(me && admins.includes(String(me.email).toLowerCase())) : Number(req.uid) === st.ownerId;
  const mine = { bytes: st.myBytes, rows: st.myRows, imgBytes: is.myBytes, imgCount: is.myCount };
  if (!isOwner) return res.json({ owner: false, mine });
  const m = monthKey(), cnt = await db.metaGet("");
  if (imgs.enabled && (!imgs.state.checkedAt || Date.now() - imgs.state.checkedAt > 5 * 60e3)) { await imgs.check(); if (pend.count && imgs.state.ok) migrateImages().catch(() => {}); }
  const mu = process.memoryUsage();
  res.json({
    owner: true, mine, time: Date.now(),
    render: {
      onRender: !!process.env.RENDER, service: process.env.RENDER_SERVICE_NAME || null, instance: process.env.RENDER_INSTANCE_ID || null,
      commit: (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || null, node: process.version,
      memLimit: memLimit(), rss: mu.rss, heapUsed: mu.heapUsed, heapTotal: mu.heapTotal,
      cpuPct: cpuPct(), uptimeSec: Math.round((Date.now() - STARTED) / 1000),
      month: m, monthUpSec: cnt["up:" + m] || 0, monthReq: cnt["req:" + m] || 0, monthOut: cnt["out:" + m] || 0, monthIn: cnt["in:" + m] || 0,
      freeHours: 750, freeOutBytes: 100 * 1024 ** 3
    },
    db: {
      kind: db.kind, version: st.version, sizeBytes: st.dbBytes, kvBytes: st.kvBytes, usersBytes: st.usersBytes,
      users: st.users, rows: st.rows, freeBytes: 1024 ** 3, freeComputeHours: 100,
      neon: db.kind === "postgres" ? await neonInfo() : { configured: false }
    },
    storage: {
      enabled: imgs.enabled, ok: imgs.state.ok, error: imgs.state.error, bucket: imgs.state.bucket, host: imgs.state.host, region: imgs.state.region,
      bytes: is.bytes, count: is.count, myBytes: is.myBytes, myCount: is.myCount, freeBytes: FREE_BYTES,
      pending: pend.count, pendingBytes: pend.bytes, migrating: MIG.running, moved: MIG.moved, failed: MIG.failed
    }
  });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Topilmadi" }));

// Ilova (PWA) — o'sha serverdan. Hamma fayl repo ildizida (papkasiz). Tashqariga FAQAT shu nomlar beriladi:
// server.js, db.js, package.json kabi fayllar hech qachon ochilmaydi.
const PUBLIC_FILES = new Set(["index.html", "manifest.json", "sw.js", "favicon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]);
const sendPublic = (name, res, next) => res.sendFile(path.join(__dirname, name), { dotfiles: "deny" }, err => { if (err && !res.headersSent) next(err); });
app.get("/", (req, res, next) => sendPublic("index.html", res, next));
app.get("/:file", (req, res, next) => (PUBLIC_FILES.has(req.params.file) ? sendPublic(req.params.file, res, next) : next()));
app.get("*", (req, res, next) => sendPublic("index.html", res, next));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const s = err.status || err.statusCode || 500;
  if (s >= 500) console.error(err);
  res.status(s).json({ error: s === 413 ? "Ma'lumot juda katta." : s < 500 ? "So'rov noto'g'ri." : "Server xatosi" });
});

/* ───────────── Ishga tushirish ───────────── */
setInterval(() => {
  loginLimit.sweep(); healthLimit.sweep();
  const now = Date.now(); for (const [k, s] of seen) if (s.exp < now) seen.delete(k);
}, 5 * 60e3).unref();

process.on("unhandledRejection", e => console.error("unhandledRejection:", (e && e.message) || e));

(async () => {
  try { await db.init(); }
  catch (e) {
    console.error("✖ Bazaga ulanib bo'lmadi — " + (explainDbError(e) || "noma'lum sabab") + "\n  (texnik: " + (e && e.message) + ")");
    process.exit(1);
  }
  const server = app.listen(PORT, () => console.log("Mo'min server :" + PORT + " · baza: " + db.label + " · rasmlar: " + (imgs.enabled ? "object storage (" + imgs.state.bucket + ")" : "bazada")));
  if (imgs.enabled) setTimeout(() => migrateImages().catch(() => {}), 3000);
  // Render proksisi ulanishni uzoq ushlab turadi — Node undan oldin yopib qo'ymasin (aks holda tasodifiy 502)
  server.keepAliveTimeout = 65e3; server.headersTimeout = 66e3;

  let stopping = false;
  const stop = sig => {
    if (stopping) return; stopping = true;
    console.log(sig + " — server to'xtatilmoqda");
    setTimeout(() => process.exit(0), 8000).unref();
    server.close(() => flushCounters().catch(() => {}).finally(() => db.close().catch(() => {}).finally(() => process.exit(0))));
    if (server.closeIdleConnections) server.closeIdleConnections();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
})();
