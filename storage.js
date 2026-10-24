"use strict";
/* Rasmlar uchun object storage (Neon Object Storage — S3 bilan mos).
   Sozlash (Render → Environment): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION
   (Neon → Connect → Storage → "Parameters only" dan nusxalanadi) va S3_BUCKET (standart: momin-images).
   Sozlanmagan bo'lsa enabled=false — ilova eski usulda (rasm bazada) ishlayveradi. */
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");

const KEY_RE = /^momin:(img|mulkimg):[A-Za-z0-9:_.-]{1,160}$/;
const isImgKey = k => KEY_RE.test(String(k || ""));
const FREE_BYTES = 5 * 1024 ** 3;   // Neon bepul reja: loyihaga 5 GB

function createImageStore(env = process.env) {
  const endpoint = (env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT || "").trim();
  const accessKeyId = (env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY || "").trim();
  const region = (env.AWS_REGION || env.S3_REGION || "eu-central-1").trim();
  const bucket = (env.S3_BUCKET || "momin-images").trim();
  const enabled = !!(endpoint && accessKeyId && secretAccessKey);
  const st = { enabled, bucket, region, host: "", ok: null, error: null, checkedAt: 0 };
  try { st.host = endpoint ? new URL(endpoint).host : ""; } catch (e) { st.host = endpoint; }
  if (!enabled) {
    const missing = [["AWS_ENDPOINT_URL_S3", endpoint], ["AWS_ACCESS_KEY_ID", accessKeyId], ["AWS_SECRET_ACCESS_KEY", secretAccessKey]].filter(x => !x[1]).map(x => x[0]);
    st.error = endpoint || accessKeyId || secretAccessKey ? "Yetishmayapti: " + missing.join(", ") : null;
    return { enabled: false, state: st, isImgKey };
  }
  const s3 = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 3 });
  const objKey = (uid, k) => "u" + Number(uid) + "/" + String(k).replace(/:/g, "/");
  const explain = e => {
    const c = (e && (e.name || e.Code)) || "", s = e && e.$metadata && e.$metadata.httpStatusCode;
    if (c === "NoSuchBucket" || (s === 404 && /bucket/i.test(String(e.message)))) return `«${bucket}» nomli bucket topilmadi — Neon → Object storage → New bucket orqali yarating.`;
    if (c === "InvalidAccessKeyId" || c === "SignatureDoesNotMatch" || s === 403 || s === 401) return "Kalitlar noto'g'ri (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) — Neon → Connect → Storage dan qayta nusxalang.";
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(String(e && e.message))) return "AWS_ENDPOINT_URL_S3 manzili topilmadi — qayta nusxalang.";
    return (e && e.message) || "Noma'lum xato";
  };
  return {
    enabled: true, state: st, isImgKey, FREE_BYTES,
    async check() {
      try { await s3.send(new HeadBucketCommand({ Bucket: bucket })); st.ok = true; st.error = null; }
      catch (e) {
        const code = e && e.$metadata && e.$metadata.httpStatusCode;
        st.ok = false;
        st.error = code === 404 || (e && (e.name === "NotFound" || e.name === "NoSuchBucket")) ? `«${bucket}» nomli bucket topilmadi — Neon → Object storage → New bucket orqali shu nom bilan yarating.` : explain(e);
      }
      st.checkedAt = Date.now(); return st.ok;
    },
    async put(uid, k, buf, type) {
      try { await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objKey(uid, k), Body: buf, ContentType: type || "application/octet-stream" })); st.ok = true; }
      catch (e) { st.ok = false; st.error = explain(e); throw Object.assign(e, { hint: st.error }); }
    },
    async get(uid, k) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objKey(uid, k) }));
        return { body: Buffer.from(await r.Body.transformToByteArray()), type: r.ContentType || "application/octet-stream" };
      } catch (e) {
        const s = e && e.$metadata && e.$metadata.httpStatusCode;
        if (e && (e.name === "NoSuchKey" || s === 404) && !/bucket/i.test(String(e.message))) return null;
        st.ok = false; st.error = explain(e); throw Object.assign(e, { hint: st.error });
      }
    },
    async del(uid, k) { try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objKey(uid, k) })); } catch (e) { const s = e && e.$metadata && e.$metadata.httpStatusCode; if (s !== 404) throw e; } }
  };
}

/* data:image/jpeg;base64,... → {buf,type}; xom bayt bo'lsa ham tushunadi */
function decodeImage(v) {
  const s = String(v || "");
  const m = /^data:([a-z0-9.+\/-]+);base64,(.*)$/i.exec(s);
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  return buf.length ? { buf, type: m[1].toLowerCase() } : null;
}
function sniffType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 11 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return null;
}

module.exports = { createImageStore, decodeImage, sniffType, isImgKey, FREE_BYTES };
