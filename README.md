# 🛒 unturned-shop-api

NestJS backend สำหรับเว็บ shop ของ SellVault — Discord login, market, coins, admin.

> Phase 1 = skeleton + Discord OAuth + ngrok + Firestore URL writer

## Quick start

```bash
cp .env.example .env
# กรอกค่าใน .env (ดูด้านล่าง)

npm install
npm run start:dev
```

หลัง start เสร็จ console จะแสดง **ngrok URL** → backend เปิดให้เข้าจาก public URL นั้น และ URL จะถูกเขียนลง Firestore doc `config/apiUrl` (ปรับ path ได้ใน `FIREBASE_API_URL_DOC`)

## Required env

| Var | ที่มา |
|---|---|
| `DB_*`, `SV_PREFIX`, `RC_PREFIX` | MySQL เดียวกับบอท/plugin |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | [Discord Dev Portal](https://discord.com/developers/applications) → OAuth2 |
| `DISCORD_REDIRECT_URI` | ตั้งใน Discord Dev Portal → ใช้ `https://<ngrok>/auth/discord/callback` |
| `JWT_SECRET` | random long string (≥32 chars) |
| `ADMIN_DISCORD_IDS` | discord_id ของแอดมิน คั่นด้วย `,` |
| `NGROK_AUTHTOKEN` | [dashboard.ngrok.com](https://dashboard.ngrok.com/auth) |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | path ของ JSON ที่ดาวน์โหลดจาก Firebase Console |

## Phase 1 endpoints

| Method | Path | Auth | คำอธิบาย |
|---|---|---|---|
| GET | `/health` | – | `{ ok: true, ts }` |
| GET | `/auth/discord` | – | redirect ไป Discord login |
| GET | `/auth/discord/callback` | Discord | callback → redirect `${FRONTEND_URL}/auth/callback?token=<jwt>` |
| GET | `/auth/me` | JWT | live user info พร้อม steam_id (ถ้า link แล้ว) + is_admin |

## Test login (no frontend needed)

1. ตั้ง `FRONTEND_URL=https://<ngrok>/auth/me` ชั่วคราว (จะ redirect กลับมาที่ /me)
2. เปิด browser → `https://<ngrok>/auth/discord`
3. กด Authorize → ถูก redirect กลับ พร้อม `?token=<jwt>`
4. copy token แล้ว curl:
   ```bash
   curl https://<ngrok>/auth/me -H "Authorization: Bearer <jwt>"
   ```
   ควรได้ `{ discord_id, username, steam_id, linked, is_admin }`

## โครงสร้าง

```
src/
├── main.ts                  bootstrap + ngrok start
├── app.module.ts
├── config/configuration.ts
├── database/                MySQL pool (shared schema)
├── auth/                    Discord OAuth + JWT
├── users/                   sv_links lookup
├── firebase/                Firestore publisher
├── ngrok/                   tunnel + publish URL
├── health/                  /health
└── common/                  guards + decorators
```
