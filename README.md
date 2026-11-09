# 1️⃣ FF Admin — MAIN PANEL

User search, balance / wallet, matches, deposits-withdraw, chat manager, gift codes, leaderboard rewards, app rules, reports — **roz ka saara kaam yahin**.
Heavy kaam (backup, data center, data delete) **Service 3** mein, Fampay bot **Service 2** mein gaya hai, isliye yeh panel hamesha halka aur tez rehta hai.

> ⚠️ Is service ko **purani Render service ki jagah** deploy karo (same URL). User app ka chat-token URL (`/api/chat/token`) isi URL par chalta hai — URL badla to app mein update karna padega.

## Kya hai
- Owner login → poora Main panel (Firebase client SDK ke saath, pehle jaisa)
- ADMIN login → LITE panel (users / wallet / matches / settings) — pehle jaisa
- Wallet approve par Fampay UTR match ab seedha Firestore pool se hota hai (`fampay_store.py`), bot thread ki zaroorat nahi
- Month-end leaderboard reward job (halka, 15 min mein ek check)
- Top strip: **Render status · UptimeRobot · Self revive** + header mein 3 panels ka switcher
- **Coin Battle game server** (`ballgame.py`): user app ka real-money game yahin chalta hai (rules, timers, bot, wallet payout, leaderboard). Admin tab **Coin Battle**: entry amounts, cut %, bot on/off + strength, free practice, live games, house net. Match list mein har match par **slot + player names** dikhte hain.
- Bots hamesha user ko **BOT** badge ke saath dikhte hain (kisi ko real player nahi dikhaye jate) aur fair hain.
- Dashboard par **Payment Bot ↗** aur **Backup Center ↗** tiles

## Kya NAHI hai (doosri services mein)
Chat Manager mein **Message life (hours)** ka control hai (default 24h). Fampay bot / payments → `2-payment-bot` · Backup, Telegram, Data Center, Data Delete, unverified cleanup → `3-backup-center`

## Render par deploy (Docker)
1. Is folder ko apni **alag GitHub repo** mein daalo (ya ek repo mein 3 folder rakho aur Render mein *Root Directory* set karo).
2. Render → **New → Blueprint** (ya New → Web Service → Runtime **Docker**) → repo choose karo. `render.yaml` sab bhar deta hai.
3. **Environment** mein `.env.example` ke hisaab se values bharo. Firebase key ke liye: `python tools/make_b64.py serviceAccount.json` ka output `FIREBASE_CREDENTIALS_B64` mein paste.
4. Deploy ke baad `https://<service>.onrender.com/health` kholo — `{"ok":true}` aana chahiye.
5. UptimeRobot: **Add New Monitor → HTTP(s)** → URL `https://<service>.onrender.com/health` → interval **5 min**.
   Phir UptimeRobot → My Settings → API → **Read-only API key** → env `UPTIMEROBOT_API_KEY`. Ab panel ke top strip mein uptime % dikhega.
6. Panel ke header mein **server icon** dabao — Render status, UptimeRobot, Self-revive aur env check ek jagah.

## Files
`app.py` routes · `admin_lite.py` sub-admin panel · `chatadmin.py` chat manager · `fampay_store.py` deposit pool · `jobs.py` reward job · `opsapi.py/keepalive.py/renderinfo.py/uptimerobot.py` status + revive · `public/` UI · `firestore.rules`

---

# Leaderboard manager (admin panel -> Leaderboard)
* **Add / edit a top player**: find by Player ID or app UID, set an amount, tick Today / This week / This month. The top order follows the amount.
* **Edit ₹** on any row changes that player's amount on the board shown.
* **Recently removed**: Remove / Hide keep a copy, so a mistake can be restored with one tap (stored in `config/lbTrash`, only current boards).
* Hidden accounts now show name + Player ID, with a **Show again** button.
