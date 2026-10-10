"use strict";
/* Mo'min — Kun tartibi · server (Render + Neon)
   - email + parol bilan ro'yxatdan o'tish / kirish (scrypt + imzolangan token)
   - har bir foydalanuvchi uchun "momin:*" kalit-qiymatlar ombori
   - DATABASE_URL (Neon PostgreSQL) bo'lsa — o'sha baza; bo'lmasa data.json fayl (mahalliy sinov) */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { promisify } = require("util");
const { createStore, explainDbError } = require("./db");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? null : "dev-secret-change-me");
if (!SECRET) { console.error("✖ JWT_SECRET o'rnatilmagan! (Render'da Environment bo'limiga qo'shing.)"); process.exit(1); }
const TOKEN_DAYS = 90;

/* ───────────── Ombor ───────────── */
let db;
try { db = createStore(process.env); }
catch (e) { console.error("✖ " + (e.hint || e.message)); process.exit(1); }

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.path.indexOf("/api/") === 0) res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
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
  const ts = nextTs();
  await db.setMany(req.uid, clean, ts);
  seenBump(req.uid, ts);
  res.json({ ok: true, ts });
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

app.delete("/api/account", guard(async (req, res) => { await db.deleteUser(req.uid); seenDrop(req.uid); res.json({ ok: true }); }));

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
  const server = app.listen(PORT, () => console.log("Mo'min server :" + PORT + " · baza: " + db.label));
  // Render proksisi ulanishni uzoq ushlab turadi — Node undan oldin yopib qo'ymasin (aks holda tasodifiy 502)
  server.keepAliveTimeout = 65e3; server.headersTimeout = 66e3;

  let stopping = false;
  const stop = sig => {
    if (stopping) return; stopping = true;
    console.log(sig + " — server to'xtatilmoqda");
    setTimeout(() => process.exit(0), 8000).unref();
    server.close(() => db.close().catch(() => {}).finally(() => process.exit(0)));
    if (server.closeIdleConnections) server.closeIdleConnections();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
})();
