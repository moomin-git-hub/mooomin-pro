# Ilovalarni kalit bilan ulash (LINK API, 1-versiya)

Mo'min, Hisob va Vaqt Banki bir-biriga **ulash kaliti** orqali ulanadi. Har bir ilova hisobining o'z kaliti bo'ladi:

```
MOMIN-6DBWM-3LJS9-ZDWP6-6E8RN      (Mo'min)
HISOB-XXXXX-XXXXX-XXXXX-XXXXX      (Hisob — shu qoidaga ko'ra qo'shiladi)
VAQT-XXXXX-XXXXX-XXXXX-XXXXX       (Vaqt Banki — shu qoidaga ko'ra qo'shiladi)
```

Ko'rinishi: `PREFIKS-` + 4 guruh × 5 belgi (A–Z va 2–9, chalkashmasligi uchun 0, O, 1, I yo'q). Tekshirish uchun regex:

```
^[A-Z]{2,12}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$
```

Kalit **faqat o'qish** uchun: u bilan ilovaning qisqa xulosasini olish mumkin, boshqa hech narsani o'qib ham, yozib ham bo'lmaydi. Kalit yangilansa, eskisi darhol ishlamay qoladi.

## Har bir ilova serverida bo'lishi kerak bo'lgan 3 ta yo'l

| So'rov | Kim | Javob |
|---|---|---|
| `GET /api/link/key` | hisob egasi (`Authorization: Bearer <token>`) | `{"key":"HISOB-…"}`; kalit bo'lmasa yaratiladi |
| `POST /api/link/key` | hisob egasi | yangi kalit, eskisi bekor bo'ladi |
| `GET /api/link/summary` | istalgan ilova, sarlavhada `X-Link-Key: <kalit>` | pastdagi JSON |

`/api/link/summary` javobi:

```json
{
  "ok": true,
  "app": "hisob",
  "name": "Hisob 2026",
  "version": 1,
  "summary": { "Bugungi xarajat": "45 000 so'm", "Oy balansi": "+1 200 000 so'm" },
  "time": 1792720677220
}
```

- `summary`: ko'pi bilan 6 ta oddiy `"nom": "qiymat"` juftligi, ikkalasi ham matn. Mo'min ularni ulangan ilova kartasida chiplar ko'rinishida ko'rsatadi.
- Kalit noto'g'ri bo'lsa → **401** `{"ok":false,"error":"Kalit noto'g'ri"}`.
- So'rovlar soni cheklansin (masalan, IP bo'yicha daqiqasiga 60 ta) → **429**.
- Brauzer boshqa domendan so'rov yuboradi, shuning uchun **CORS** ochiq bo'lishi kerak: `Access-Control-Allow-Origin: *` va `Access-Control-Allow-Headers: Content-Type, Authorization, X-Link-Key`.

## Mo'min qanday tekshiradi

Sozlamalar → **Bog'langan ilovalar** → ilova manzili va kalitini yozib, **Ulash va tekshirish** bosilganda:

```
GET <manzil>/api/link/summary
X-Link-Key: <kalit>
```

- `200` va `ok:true` bo'lsa → «Ulangan», xulosa ko'rinadi.
- `401` bo'lsa → «Kalit noto'g'ri».
- `404` bo'lsa yoki javob JSON bo'lmasa → «Ilova hali qo'llamaydi».
- Tarmoq xatosi bo'lsa → «Javob yo'q».

Mo'minning o'zi bu yo'llarni allaqachon qo'llaydi: `server.js` dagi «Ilovalarni ulash» bo'limini Hisob va Vaqt Banki serveriga ko'chirib, prefiksni (`MOMIN-` → `HISOB-` / `VAQT-`) va `summary` mazmunini almashtirish kifoya.
