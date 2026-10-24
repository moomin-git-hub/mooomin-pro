# Mo'min — Kun tartibi · server (Render + Neon)

```
Telefon / brauzer (PWA)  ──►  Render (Node server, bepul)  ──►  Neon (PostgreSQL, bepul, doimiy)
```

- **Render** serverni ishlatadi va ilovaning o'zini ham shu manzildan beradi.
- **Neon** ma'lumotlar bazasi. Render'ning o'z bepul bazasi 30 kundan keyin o'chib ketadi, Neon'niki muddatsiz.
- Ikkalasi ham bepul rejada **uxlab qoladi**: Render 15 daqiqa so'rov bo'lmasa (qayta uyg'onishi ~1 daqiqa), Neon 5 daqiqada (uyg'onishi bir necha soniya). Ma'lumot yo'qolmaydi, faqat uzoq tanaffusdan keyingi birinchi ulanish sekinroq. Ilovaning o'zi har doim telefonning xotirasi bilan darhol ishlaydi, bulutga fonda ulanadi (ulanmasa o'zi qayta urinadi).

## Fayllar (hammasi bitta joyda, papkasiz)

| Fayl | Nima uchun |
|---|---|
| `index.html` | ilovaning o'zi |
| `server.js`, `db.js`, `storage.js` | server, baza va rasmlar (object storage) bilan ishlash |
| `package.json`, `package-lock.json` | kerakli kutubxonalar ro'yxati |
| `render.yaml` | Render uchun tayyor sozlama |
| `manifest.json`, `sw.js`, `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | telefonga o'rnatish (PWA), ikonka va oflayn ishlash |
| `README.md` | shu qo'llanma |
| `LINK-API.md` | ilovalarni kalit bilan ulash qoidasi (Hisob va Vaqt Banki'ga qo'shish uchun) |

Hammasi **GitHub repo'sining eng yuqori sathida** turishi kerak (hech qanday papka ichida emas).

---

## 1-qadam · Neon'da baza (≈ 3 daqiqa)

1. **neon.com** ga kiring va ro'yxatdan o'ting (Google / GitHub / email).
2. **Create project** → nom: `momin` → **Region: AWS Europe (Frankfurt)** (Render ham Frankfurt'da bo'ladi, shuning uchun tez). Boshqa sozlamalarni o'zgartirmang.
3. Loyiha ochilgach **Connect** tugmasini bosing. Ochilgan oynada **Connection pooling** yoqilgan bo'lsin (manzilda `-pooler` so'zi bo'ladi).
4. `postgresql://…` bilan boshlanadigan manzilni **to'liq nusxalang**. Bu `DATABASE_URL`. Parol shu manzilning ichida: uni hech kimga bermang va GitHub'ga yozmang.

Jadvallarni qo'lda yaratish shart emas, server birinchi ishga tushganda o'zi yaratadi.

## 2-qadam · Fayllarni GitHub'ga

1. **github.com** ga kiring (hisob bo'lmasa, oching) → yuqori o'ngdagi **+** → **New repository**.
2. **Repository name**: `momin`. **Private** ni tanlang. "Add a README file" va boshqa belgilarni **qo'ymang** (repo bo'sh bo'lsin) → **Create repository**.
3. Ochilgan sahifada **uploading an existing file** havolasini bosing (yoki **Add file → Upload files**).
4. Ro'yxatdagi **hamma fayllarni birdan** tanlang (yoki sudrab tashlang). Hammasi ro'yxatda paydo bo'lguncha kuting → pastdagi **Commit changes**.
5. Tekshiring: repo bosh sahifasida `render.yaml`, `server.js`, `index.html` va boshqalar to'g'ridan-to'g'ri ko'rinsin.

## 3-qadam · Render'da server

1. **render.com** ga kiring (GitHub bilan kirish eng oson).
2. **New +** → **Blueprint**.
3. GitHub'ni ulang (so'rasa, Render'ga `momin` repo'sini ko'rishga ruxsat bering) va `momin` yonidagi **Connect** ni bosing.
4. Blueprint nomi, branch (`main`) va **Blueprint Path** (`render.yaml`) ni o'zgartirmang.
5. Render **DATABASE_URL** qiymatini so'raydi: 1-qadamda nusxalagan Neon manzilini qo'ying. (`JWT_SECRET` ni Render o'zi yaratadi.)
6. **Deploy Blueprint** ni bosing. 2–5 daqiqada `momin` holati **Live** bo'ladi. Manzil: `https://momin-xxxx.onrender.com`.

Odatda karta so'ralmaydi. Agar baribir so'ralsa, bu tekshiruv uchun (Render xodimlari 1 dollar vaqtincha ushlanib, darhol qaytarilishini yozgan).

**Blueprint ishlamasa** (zaxira yo'l): **New + → Web Service** → repo'ni tanlang → *Language*: `Node`, *Build Command*: `npm install`, *Start Command*: `npm start`, *Instance Type*: **Free** → *Environment Variables* ga `DATABASE_URL` (Neon manzili), `JWT_SECRET` (kamida 32 ta tasodifiy belgi) va `NODE_ENV=production` qo'shing → **Create Web Service**.

## 4-qadam · Tekshirish

| Manzil | Nima ko'rsatadi |
|---|---|
| `…onrender.com/api/health` | `{"ok":true,…}`: server tirik (bazaga tegmaydi) |
| `…onrender.com/api/health/db` | `{"ok":true,"ms":…}`: **Neon'ga ulanish ishlayapti**. Ishlamasa `error` maydonida sababi o'zbekcha yoziladi |
| `…onrender.com` | ilovaning o'zi |

Ilovada: **Yana → Sozlamalar → Hisob va sinxron → Ro'yxatdan o'tish** (email + parol). Boshqa qurilmada shu email bilan **Kirish**: ma'lumot sinxron bo'ladi.

## 5-qadam · Telefonga o'rnatish

- **Android (Chrome)**: ⋮ menyu → **Install app** (yoki **Add to Home screen**).
- **iPhone (Safari)**: **Ulashish** tugmasi → **Add to Home Screen**.

## 6-qadam · Rasmlar uchun Neon object storage (ixtiyoriy, tavsiya etiladi)

Sozlanmasa, rasmlar avvalgidek bazada saqlanadi. Sozlansa, rasmlar alohida fayl ombori (bepul rejada **5 GB**) ga ko'chadi, baza esa yengil qoladi.

1. Neon → loyihangiz → **Object storage** bo'limi → **New bucket** → nom: `momin-images`, access: **private** → **Create**.
2. Neon → **Connect** → **Storage** yorlig'i → **Parameters only** ni tanlang → **Reveal credential**. To'rtta qiymat chiqadi: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`.
3. Render → `momin` → **Environment** → shu to'rttasini va `S3_BUCKET` = `momin-images` ni qo'shing → **Save**.
4. Render qayta ishga tushgach, eski rasmlar o'zi object storage'ga ko'chadi. Ilovada **Sozlamalar → Server va baza** da «Neon · object storage» bo'limi **ishlayapti** deb, band joy va 5 GB dan qancha qolgani bilan ko'rinadi.

Kalitlarni hech kimga bermang va GitHub'ga yozmang.

## 7-qadam · Ilovalarni kalit bilan ulash

Ilovada: **Sozlamalar → Bog'langan ilovalar**.
- **Mo'minning ulash kaliti** (`MOMIN-XXXXX-…`): har bir hisobning o'z, takrorlanmas kaliti. Uni **Nusxalash** qilib, Hisob yoki Vaqt Banki'ning shu bo'limiga qo'yasiz. Kalit faqat qisqa xulosani (ahd kuni, bugungi natija, namoz, streak) o'qishga ruxsat beradi.
- **Ilovalarim**: har bir ilova uchun manzil va o'sha ilovaning kaliti → **Ulash va tekshirish**.
- Hisob va Vaqt Banki bu kalitni qabul qilishi uchun ularning serveriga `LINK-API.md` dagi 3 ta yo'l qo'shilishi kerak.

---

## Muammolar

| Belgi | Sabab va yechim |
|---|---|
| Deploy "Failed", logda `✖ Bazaga ulanib bo'lmadi — …` | Sabab shu satrning o'zida yozilgan. Odatda `DATABASE_URL` noto'g'ri nusxalangan: Neon → **Connect** → qaytadan nusxalab, Render → *Environment* → `DATABASE_URL` ni almashtiring → *Save*. |
| `/api/health/db` → "parol noto'g'ri" | Neon'da parol almashtirilgan bo'lishi mumkin: yangi manzilni nusxalang. |
| `/api/health/db` → "limit to'lgan" | Neon bepul limiti (oyiga 100 CU-soat yoki 1 GB) tugagan. Keyingi oy boshigacha kuting yoki Neon panelida tekshiring. |
| Ilovada "☁ ulanmagan", "Server uyg'onmoqda…" | Render yoki Neon uxlab yotgan. 30–60 soniya kuting: ilova o'zi qayta ulanadi. |
| Sayt ochilganda ilova o'rniga boshqa narsa chiqadi | Fayllar papka ichida qolib ketgan. Hammasi repo'ning eng yuqori sathida bo'lishi kerak (yuqoridagi jadvalga qarang). |
| Server va baza → object storage: «bucket topilmadi» | Neon → Object storage da xuddi `S3_BUCKET` dagi nom bilan bucket yarating. |
| Object storage: «Kalitlar noto'g'ri» | Neon → Connect → Storage → **Rotate credentials** qilib, yangi kalitlarni Render'ga qo'ying. |
| Bazaning SSL sertifikati haqida xato | Render → *Environment* → `PGSSL` = `insecure` qo'shing (faqat Neon bo'lmagan baza uchun kerak bo'lishi mumkin). |

## Uxlab qolmasligi uchun (ixtiyoriy)

Bepul tashqi "pinger" (masalan UptimeRobot yoki cron-job.org) har 5–10 daqiqada `https://…onrender.com/api/health` ni chaqirsa, Render uxlamaydi.

- Faqat **`/api/health`** ni chaqiring. `/api/health/db` ni pingerga **qo'ymang**: Neon uxlamay qoladi va bepul soatlari tez tugaydi.
- Bitta xizmat butun oy uyg'oq tursa ~744 soat ketadi; Render'ning bepul chegarasi oyiga 750 soat (barcha bepul xizmatlar uchun umumiy).

Neon haqida: ilova har ~15 soniyada "yangilik bormi?" deb so'raydi, lekin server buni bazaga bormasdan, xotiradan javoblaydi. Shuning uchun ilova ochiq turganda ham baza uxlay oladi va soatlar tejaladi.

## Yangilash

GitHub'da repo'ni oching → **Add file → Upload files** → yangi fayllarni (masalan `index.html`) tashlang. Bir xil nomli fayl almashadi → **Commit changes**. Render o'zi qayta joylaydi. Telefondagi ilova ham keyingi ochilishda yangilanadi.

---

## Sozlamalar (Render → Environment)

| O'zgaruvchi | Ma'nosi |
|---|---|
| `DATABASE_URL` | Neon manzili (majburiy). `psql '…'` ko'rinishida nusxalanib qolsa ham tushunadi. |
| `JWT_SECRET` | Kirish tokenlari kaliti: Render yaratadi, o'zgartirmang (o'zgarsa hamma qayta kiradi). |
| `PGSSL` | Odatda kerak emas. `off`: SSL'siz baza; `insecure`: sertifikatni tekshirmaslik. |
| `PG_POOL_MAX` | Bazaga ochiq ulanishlar soni (standart 5). |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` | Neon object storage kalitlari (6-qadam). Bo'lmasa, rasmlar bazada saqlanadi. |
| `S3_BUCKET` | Bucket nomi (standart: `momin-images`). |
| `NEON_API_KEY` | Ixtiyoriy. Neon → hisob belgisi → **Account settings → API keys → Create** dan olingan kalit. Qo'shilsa, ilovadagi **Sozlamalar → Server va baza** da Neon hisoblash soatlari (CU-soat) va trafik ham ko'rinadi. |
| `NEON_PROJECT_ID` | `NEON_API_KEY` bilan birga. Neon → loyiha → **Settings → General → Project ID**. |
| `ADMIN_EMAILS` | Ixtiyoriy. Server ko'rsatkichlarini kim ko'rishi (vergul bilan). Bo'lmasa — birinchi ro'yxatdan o'tgan hisob. |
| `MEM_LIMIT_MB` | Ixtiyoriy. Pullik rejaga o'tsangiz, xotira chegarasi (standart: Render'da 512). |
| `NO_POLL_CACHE` | `1` bo'lsa sinxron so'rovlari har safar bazaga boradi (odatda kerak emas). |

## Mahalliy ishga tushirish (sinov uchun)

```bash
npm install
npm start                                   # DATABASE_URL yo'q → ma'lumot data.json faylda
DATABASE_URL='postgresql://…' npm start     # Neon bilan
```
`http://localhost:3000` da ilova ochiladi.

## API (qisqacha)

`POST /api/register` · `POST /api/login` · `GET /api/me` · `GET|POST|DELETE /api/data` (`?since=`: faqat o'zgarganlar) · `GET /api/snaps`, `GET /api/snaps/:sana` · `DELETE /api/account` · `GET /api/health`, `GET /api/health/db`.
Parollar `scrypt` bilan, tokenlar HMAC bilan imzolanadi (90 kun). Har bir foydalanuvchi ma'lumoti alohida.
