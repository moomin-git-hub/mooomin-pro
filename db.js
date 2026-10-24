"use strict";
/* Mo'min — ombor qatlami
   • DATABASE_URL bo'lsa → PostgreSQL (Neon uchun moslangan: uxlab-uyg'onish, uzilgan ulanishlar, SSL)
   • bo'lmasa           → data.json fayl (faqat mahalliy sinov uchun) */
const fs = require("fs");
const path = require("path");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log("[baza]", ...a);

/* ───────────────────────── Xatolarni tushunish ───────────────────────── */

// Vaqtincha xatolar: Neon uyg'onayotganda, ulanish uzilganda, tarmoq ming'irlaganda — qayta urinish kerak.
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "ENOTCONN",
  "57P01", "57P02", "57P03",            // admin_shutdown, crash_shutdown, cannot_connect_now (uyg'onmoqda)
  "53300", "53400",                      // too_many_connections, configuration_limit_exceeded
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",   // connection_exception oilasi
  "XX000"                                // Neon proksisi "compute'ga ulanib bo'lmadi" shu kod bilan keladi
]);
const TRANSIENT_MSG = /terminat|timeout|timed out|connection (?:ended|closed|refused|reset)|socket|ECONN|EPIPE|EAI_AGAIN|couldn'?t connect to compute|compute node|temporarily unavailable|starting up|shutting down|too many (?:clients|connections)/i;

function isTransient(e) {
  if (!e || e.fatal) return false;
  if (e.code && TRANSIENT_CODES.has(String(e.code))) return true;
  return TRANSIENT_MSG.test(String(e.message || ""));
}

// Foydalanuvchi tushunadigan qisqa sabab (log va /api/health/db uchun). Tanilmasa — null.
function explainDbError(e) {
  const c = String((e && e.code) || ""), m = String((e && e.message) || "");
  if (e && e.hint) return e.hint;
  if (/no pg_hba\.conf entry/i.test(m))
    return /no encryption/i.test(m)
      ? "Baza SSL talab qiladi — DATABASE_URL oxirida ?sslmode=require bo'lsin."
      : "Bazaga bu manzildan kirish ruxsat etilmagan (baza tomonidagi cheklov).";
  if (c === "28P01" || /password authentication failed/i.test(m))
    return "Bazaga kirish rad etildi: DATABASE_URL ichidagi foydalanuvchi yoki parol noto'g'ri. Neon'dagi ulanish manzilini qaytadan nusxalab qo'ying.";
  if (/role .* does not exist/i.test(m))
    return "Bunday foydalanuvchi (role) yo'q — DATABASE_URL'ni Neon'dan qaytadan nusxalang.";
  if (c === "3D000" || /database .* does not exist/i.test(m))
    return "DATABASE_URL ko'rsatgan baza (database) topilmadi.";
  if (/compute time quota|data transfer quota|exceeded the .*quota|project size limit|disk full|53100/i.test(m + c))
    return "Neon bepul limiti to'lgan ko'rinadi (hisoblash soati yoki xotira). Keyingi oy boshigacha kuting yoki Neon panelida limitni tekshiring.";
  if (/endpoint .*(disabled|suspended)|has been disabled/i.test(m))
    return "Neon'dagi baza vaqtincha o'chirilgan (limit tugagan bo'lishi mumkin) — Neon panelini tekshiring.";
  if (c === "ENOTFOUND" || /getaddrinfo ENOTFOUND/i.test(m))
    return "Baza manzili (host) topilmadi — DATABASE_URL'ni tekshiring.";
  if (/does not support SSL/i.test(m))
    return "Bu baza SSL'ni qo'llamaydi. Render'da PGSSL=off o'zgaruvchisini qo'shing.";
  if (/self.signed|unable to verify|certificate|CERT_|ERR_TLS|altnames/i.test(m + " " + c))
    return "Baza SSL sertifikatini tekshirib bo'lmadi. Neon bilan bunday bo'lmasligi kerak — DATABASE_URL to'g'rimi? (Zarur bo'lsa Render'da PGSSL=insecure qo'shing.)";
  if (/SSL|encryption|pg_hba/i.test(m) && /require|no pg_hba|insecure/i.test(m))
    return "Baza SSL talab qiladi — DATABASE_URL oxirida ?sslmode=require bo'lsin.";
  if (c === "ECONNREFUSED")
    return "Baza ulanishni rad etdi (ECONNREFUSED) — host yoki port noto'g'ri bo'lishi mumkin.";
  if (isTransient(e))
    return "Baza hozir javob bermayapti (Neon uyg'onayotgan bo'lishi mumkin). Bir necha soniyadan keyin qayta urinib ko'ring.";
  return null;
}

const cfgError = msg => Object.assign(new Error(msg), { fatal: true, hint: msg });

/* Qayta urinish: faqat vaqtincha xatolarda, eksponensial kutish bilan, umumiy vaqt chegarasida. */
async function retry(fn, { tries = 4, budgetMs = 30000, base = 400, what = "so'rov" } = {}) {
  const t0 = Date.now();
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(i); }
    catch (e) {
      last = e;
      if (!isTransient(e)) break;
      const wait = Math.min(base * 2 ** (i - 1), 5000) + Math.floor(Math.random() * 250);
      if (i === tries || Date.now() - t0 + wait > budgetMs) break;
      log(`${what}: vaqtincha xato (${String(e.message).slice(0, 90)}) — ${i}/${tries}, ${wait} ms dan keyin yana urinaman`);
      await sleep(wait);
    }
  }
  if (last && typeof last === "object") {
    last.dbError = true;
    last.transient = isTransient(last);
    if (!last.hint) last.hint = explainDbError(last);
  }
  throw last;
}

/* ───────────────────────── DATABASE_URL ───────────────────────── */

// Neon konsolidan "psql 'postgresql://…'" yoki DATABASE_URL="…" ko'rinishida nusxalanib qolsa ham — URL'ning o'zini olamiz.
function cleanUrl(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/postgres(?:ql)?:\/\/[^\s'"]+/i);
  return m ? m[0] : s;
}

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0|[^.]+)$/i;   // nuqtasiz nom (docker/ichki tarmoq) ham mahalliy

/* URL'dan Pool sozlamalarini tuzadi.
   Nima uchun URL'dagi sslmode'ni olib tashlaymiz: pg uni o'zi sharhlaydi, "SECURITY WARNING" chiqaradi va
   bizning ssl sozlamamizni bosib ketadi. channel_binding esa pg'da URL orqali yoqilmaydi — foydasiz parametr. */
function pgSetup(raw, env = process.env) {
  const url = cleanUrl(raw);
  let u;
  try { u = new URL(url); }
  catch (e) { throw cfgError("DATABASE_URL noto'g'ri. U postgresql://foydalanuvchi:parol@host/baza?sslmode=require ko'rinishida bo'lishi kerak."); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:")
    throw cfgError("DATABASE_URL “postgresql://” bilan boshlanishi kerak (Neon'dagi Connection string).");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw cfgError("DATABASE_URL ichida host yo'q.");

  const p = u.searchParams;
  const mode = String(p.get("sslmode") || "").toLowerCase();
  ["sslmode", "ssl", "channel_binding", "uselibpqcompat", "sslrootcert", "sslcert", "sslkey"].forEach(k => p.delete(k));

  const forced = String(env.PGSSL || "").trim().toLowerCase();
  let ssl;
  if (forced === "off" || mode === "disable") ssl = false;
  else if (forced === "insecure" || mode === "no-verify") ssl = { rejectUnauthorized: false };
  else if (!mode && !forced && LOCAL_HOST.test(host)) ssl = false;          // mahalliy sinov
  else ssl = { rejectUnauthorized: true };                                   // Neon: ommaviy CA, to'liq tekshiruv

  return {
    connectionString: u.toString(),
    ssl,
    host,
    pooled: /-pooler\./i.test(host),
    neon: /\.neon\.tech$/i.test(host)
  };
}

/* ───────────────────────── PostgreSQL ───────────────────────── */

function createPgStore(env) {
  const { Pool } = require("pg");
  const cfg = pgSetup(env.DATABASE_URL, env);

  const pool = new Pool({
    connectionString: cfg.connectionString,
    ssl: cfg.ssl,
    max: Number(env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: Number(env.PG_IDLE_MS) || 60000,                  // Neon 5 daqiqada uxlaydi — bo'sh ulanishni oldinroq yopamiz
    connectionTimeoutMillis: Number(env.PG_CONNECT_TIMEOUT_MS) || 10000, // uyg'onayotgan bazani kutish
    query_timeout: 20000,                                                // faqat mijoz tomonida; PgBouncer bilan mos
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
  });
  // Bo'sh turgan ulanish uzilsa pg 'error' chiqaradi; tinglovchi bo'lmasa — butun server qulaydi.
  pool.on("error", e => log("bo'sh ulanish uzildi (Neon uxlagan bo'lishi mumkin):", e.message));

  const q = (text, params) => retry(() => pool.query(text, params), { what: "so'rov" });

  return {
    kind: "postgres",
    label: "PostgreSQL · " + cfg.host + (cfg.pooled ? " (pooled)" : cfg.neon ? " (direct)" : ""),
    cfg,

    async init() {
      const budgetMs = Number(env.DB_INIT_BUDGET_MS) || 60000;
      await retry(() => pool.query(
        `CREATE TABLE IF NOT EXISTS users(
           id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, created BIGINT NOT NULL);
         CREATE TABLE IF NOT EXISTS kv(
           user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           k TEXT NOT NULL, v TEXT, updated BIGINT NOT NULL, PRIMARY KEY(user_id,k));
         CREATE INDEX IF NOT EXISTS kv_upd ON kv(user_id, updated);
         CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, n BIGINT NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS img(
           user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           k TEXT NOT NULL, size BIGINT NOT NULL, type TEXT, updated BIGINT NOT NULL, PRIMARY KEY(user_id,k));
         CREATE TABLE IF NOT EXISTS linkkey(
           user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, key TEXT UNIQUE NOT NULL, created BIGINT NOT NULL)`),
        { tries: 10, budgetMs, base: 800, what: "ishga tushirish" });
    },

    async ping() { await q("SELECT 1"); },
    async close() { await pool.end(); },

    async findUser(email) { return (await q("SELECT * FROM users WHERE email=$1", [email])).rows[0] || null; },
    async getUser(id) { return (await q("SELECT * FROM users WHERE id=$1", [id])).rows[0] || null; },

    async createUser(email, pw) {
      let attempt = 0;
      return retry(async () => {
        attempt++;
        try {
          return (await pool.query("INSERT INTO users(email,pw,created) VALUES($1,$2,$3) RETURNING *", [email, pw, Date.now()])).rows[0];
        } catch (e) {
          if (e && e.code === "23505") {
            // Qayta urinishda: oldingi urinish aslida yozilib bo'lgan bo'lishi mumkin (javob yo'lda yo'qolgan) — bizniki bo'lsa, muvaffaqiyat.
            if (attempt > 1) {
              const u = (await pool.query("SELECT * FROM users WHERE email=$1", [email])).rows[0];
              if (u && u.pw === pw) return u;
            }
            throw Object.assign(new Error("Bu email band"), { code: "EXISTS", fatal: true });
          }
          throw e;
        }
      }, { what: "ro'yxatdan o'tish" });
    },

    async getAll(uid, since, prefix) {
      const r = await q("SELECT k,v,updated FROM kv WHERE user_id=$1 AND updated>$2 AND k LIKE $3",
        [uid, since, prefix.replace(/[%_\\]/g, "\\$&") + "%"]);
      return r.rows.map(x => ({ k: x.k, v: x.v, updated: Number(x.updated) }));
    },
    async getOne(uid, k) { const r = await q("SELECT v FROM kv WHERE user_id=$1 AND k=$2", [uid, k]); return r.rows[0] ? r.rows[0].v : null; },

    // Barcha o'zgarishlar BITTA so'rovda (bitta tranzaksiya, bitta tarmoq yo'li) — Neon bilan tez va qayta urinishga xavfsiz.
    async setMany(uid, items, ts) {
      const ks = [], vs = [], del = [];
      for (const [k, v] of Object.entries(items)) { if (v === null) del.push(k); else { ks.push(k); vs.push(v); } }
      if (!ks.length && !del.length) return;
      await q(
        `WITH d AS (DELETE FROM kv WHERE user_id=$1 AND k = ANY($2::text[]))
         INSERT INTO kv(user_id,k,v,updated)
         SELECT $1::int, t.k, t.v, $3::bigint FROM UNNEST($4::text[], $5::text[]) AS t(k,v)
         ON CONFLICT(user_id,k) DO UPDATE SET v=EXCLUDED.v, updated=EXCLUDED.updated`,
        [uid, del, ts, ks, vs]);
    },

    async wipe(uid) { await q("DELETE FROM kv WHERE user_id=$1 AND k NOT LIKE '\\_\\_snap:%'", [uid]); },

    // Hisoblagichlar (oylik server ish vaqti, so'rovlar, trafik) — faqat kamdan-kam yoziladi
    async metaAdd(map) {
      const ks = Object.keys(map).filter(k => map[k]); if (!ks.length) return;
      await q(`INSERT INTO meta(k,n) SELECT t.k, t.n FROM UNNEST($1::text[], $2::bigint[]) AS t(k,n)
               ON CONFLICT(k) DO UPDATE SET n = meta.n + EXCLUDED.n`, [ks, ks.map(k => Math.round(map[k]))]);
    },
    async metaGet(prefix) {
      const r = await q("SELECT k,n FROM meta WHERE k LIKE $1", [prefix.replace(/[%_\\]/g, "\\$&") + "%"]);
      const o = {}; for (const x of r.rows) o[x.k] = Number(x.n); return o;
    },
    // Ilovalarni ulash kaliti (faqat o'qish uchun)
    async linkGet(uid) { const r = await q("SELECT key FROM linkkey WHERE user_id=$1", [uid]); return r.rows[0] ? r.rows[0].key : null; },
    async linkSet(uid, key) { await q("INSERT INTO linkkey(user_id,key,created) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET key=EXCLUDED.key, created=EXCLUDED.created", [uid, key, Date.now()]); },
    async linkFind(key) { const r = await q("SELECT user_id FROM linkkey WHERE key=$1", [key]); return r.rows[0] ? r.rows[0].user_id : null; },

    // Rasmlar (object storage'dagi fayllar ro'yxati)
    async imgUpsert(uid, k, size, type, ts) {
      await q(`INSERT INTO img(user_id,k,size,type,updated) VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(user_id,k) DO UPDATE SET size=EXCLUDED.size, type=EXCLUDED.type, updated=EXCLUDED.updated`, [uid, k, size, type, ts]);
    },
    async imgDel(uid, k) { await q("DELETE FROM img WHERE user_id=$1 AND k=$2", [uid, k]); },
    async imgList(uid) { const r = await q("SELECT k,size,updated FROM img WHERE user_id=$1", [uid]); return r.rows.map(x => ({ k: x.k, size: Number(x.size), updated: Number(x.updated) })); },
    async imgStats(uid) {
      const r = (await q(`SELECT coalesce(sum(size),0) AS b, count(*) AS n,
          coalesce(sum(size) FILTER (WHERE user_id=$1),0) AS mb, count(*) FILTER (WHERE user_id=$1) AS mn FROM img`, [uid])).rows[0];
      return { bytes: Number(r.b), count: Number(r.n), myBytes: Number(r.mb), myCount: Number(r.mn) };
    },
    // Bazada (kv) qolib ketgan eski rasmlar — object storage'ga ko'chirish uchun
    async kvImgBatch(limit) {
      const r = await q("SELECT user_id,k,v FROM kv WHERE (k LIKE 'momin:img:%' OR k LIKE 'momin:mulkimg:%') AND k NOT LIKE '\\_\\_snap:%' LIMIT $1", [limit]);
      return r.rows.map(x => ({ uid: x.user_id, k: x.k, v: x.v }));
    },
    async kvImgCount() { const r = await q("SELECT count(*) AS n, coalesce(sum(octet_length(v)),0) AS b FROM kv WHERE k LIKE 'momin:img:%' OR k LIKE 'momin:mulkimg:%'"); return { count: Number(r.rows[0].n), bytes: Number(r.rows[0].b) }; },
    async kvDel(uid, k) { await q("DELETE FROM kv WHERE user_id=$1 AND k=$2", [uid, k]); },

    async stats(uid) {
      const r = (await q(`SELECT pg_database_size(current_database()) AS db,
          pg_total_relation_size('kv') AS kv, pg_total_relation_size('users') AS us,
          (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM kv) AS rows,
          (SELECT coalesce(sum(octet_length(v)),0) FROM kv WHERE user_id=$1) AS mine,
          (SELECT count(*) FROM kv WHERE user_id=$1) AS myrows,
          (SELECT min(id) FROM users) AS owner, current_setting('server_version') AS ver`, [uid])).rows[0];
      const N = k => Number(r[k]) || 0;
      return { dbBytes: N("db"), kvBytes: N("kv"), usersBytes: N("us"), users: N("users"), rows: N("rows"),
               myBytes: N("mine"), myRows: N("myrows"), ownerId: N("owner"), version: String(r.ver || "") };
    },
    async deleteUser(uid) { await q("DELETE FROM users WHERE id=$1", [uid]); }
  };
}

/* ───────────────────────── Fayl (mahalliy sinov) ───────────────────────── */

function createFileStore(env) {
  const FILE = env.DATA_FILE || path.join(__dirname, "data.json");
  let D = { seq: 0, users: [], kv: {} };
  try { D = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
  let t = null;
  const flush = () => { try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(D)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { console.error(e); } };
  const save = () => { clearTimeout(t); t = setTimeout(flush, 150); };
  return {
    kind: "file",
    label: "data.json (faqat mahalliy sinov uchun)",
    async init() {},
    async ping() {},
    async close() { clearTimeout(t); flush(); },
    async findUser(email) { return D.users.find(u => u.email === email) || null; },
    async createUser(email, pw) {
      if (D.users.some(u => u.email === email)) throw Object.assign(new Error("Bu email band"), { code: "EXISTS", fatal: true });
      const u = { id: ++D.seq, email, pw, created: Date.now() }; D.users.push(u); D.kv[u.id] = {}; save(); return u;
    },
    async getUser(id) { return D.users.find(u => u.id === id) || null; },
    async getAll(uid, since, prefix) {
      const o = D.kv[uid] || {};
      return Object.keys(o).filter(k => k.indexOf(prefix) === 0 && o[k].updated > since).map(k => ({ k, v: o[k].v, updated: o[k].updated }));
    },
    async getOne(uid, k) { const e = (D.kv[uid] || {})[k]; return e ? e.v : null; },
    async setMany(uid, items, ts) {
      const o = D.kv[uid] || (D.kv[uid] = {});
      for (const [k, v] of Object.entries(items)) { if (v === null) delete o[k]; else o[k] = { v, updated: ts }; }
      save();
    },
    async wipe(uid) { const o = D.kv[uid] || {}; for (const k of Object.keys(o)) if (k.indexOf("__snap:") !== 0) delete o[k]; save(); },
    async linkGet(uid) { return ((D.link || {})[uid]) || null; },
    async linkSet(uid, key) { (D.link || (D.link = {}))[uid] = key; save(); },
    async linkFind(key) { for (const [u, k] of Object.entries(D.link || {})) if (k === key) return Number(u); return null; },
    async imgUpsert(uid, k, size, type, ts) { const m = D.img || (D.img = {}); (m[uid] || (m[uid] = {}))[k] = { size, type, updated: ts }; save(); },
    async imgDel(uid, k) { const m = (D.img || {})[uid]; if (m) { delete m[k]; save(); } },
    async imgList(uid) { const m = (D.img || {})[uid] || {}; return Object.keys(m).map(k => ({ k, size: m[k].size, updated: m[k].updated })); },
    async imgStats(uid) { let bytes = 0, count = 0, myBytes = 0, myCount = 0; for (const [u, m] of Object.entries(D.img || {})) for (const e of Object.values(m)) { bytes += e.size; count++; if (Number(u) === Number(uid)) { myBytes += e.size; myCount++; } } return { bytes, count, myBytes, myCount }; },
    async kvImgBatch(limit) { const out = []; for (const [u, o] of Object.entries(D.kv)) for (const k of Object.keys(o)) { if (/^momin:(img|mulkimg):/.test(k) && out.length < limit) out.push({ uid: Number(u), k, v: o[k].v }); } return out; },
    async kvImgCount() { let count = 0, bytes = 0; for (const o of Object.values(D.kv)) for (const [k, e] of Object.entries(o)) if (/^momin:(img|mulkimg):/.test(k)) { count++; bytes += Buffer.byteLength(String(e.v || "")); } return { count, bytes }; },
    async kvDel(uid, k) { const o = D.kv[uid]; if (o) { delete o[k]; save(); } },
    async metaAdd(map) { const m = D.meta || (D.meta = {}); for (const k of Object.keys(map)) if (map[k]) m[k] = (m[k] || 0) + Math.round(map[k]); save(); },
    async metaGet(prefix) { const m = D.meta || {}, o = {}; for (const k of Object.keys(m)) if (k.indexOf(prefix) === 0) o[k] = m[k]; return o; },
    async stats(uid) {
      const size = Buffer.byteLength(JSON.stringify(D));
      const mine = D.kv[uid] || {};
      return { dbBytes: size, kvBytes: size, usersBytes: 0, users: D.users.length,
               rows: Object.values(D.kv).reduce((s, o) => s + Object.keys(o).length, 0),
               myBytes: Object.values(mine).reduce((s, e) => s + Buffer.byteLength(String(e.v || "")), 0), myRows: Object.keys(mine).length,
               ownerId: D.users.length ? Math.min(...D.users.map(u => u.id)) : 0, version: "data.json" };
    },
    async deleteUser(uid) { D.users = D.users.filter(u => u.id !== uid); delete D.kv[uid]; save(); }
  };
}

function createStore(env = process.env) {
  return env.DATABASE_URL && String(env.DATABASE_URL).trim() ? createPgStore(env) : createFileStore(env);
}

module.exports = { createStore, pgSetup, cleanUrl, isTransient, explainDbError, retry };
