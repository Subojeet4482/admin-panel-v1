"""REFER & EARN with SCRATCH CARDS (service 1 / Main panel). All money + rules live here; the phone only shows the result.

How it works
  * Every user's referral code = their Player ID (e.g. 8597053). Link: SITE_URL/?ref=8597053
  * A new user adds a friend's code (auto from the link at sign-up, or later within `claimWindowHrs`)  -> referrals/{newUid}
  * The referral becomes "qualified" when:  depositRequired == 0 (free, right at sign-up)  OR  the friend's total deposit >= depositRequired
  * Every `referralsPerCard` qualified referrals = 1 scratch card  -> ref_cards/{referrerUid}_{n}  (status new)
  * Scratching a card (the amount is chosen HERE, at that moment): fixed amount or random min..max -> credited to the wallet, once
Admin controls: config/referral (see DEFAULT_CFG) + void a referral. Cards that are still unscratched are taken back if a referral is voided.
Firestore: config/referral · referrals/{referredUid} · ref_cards/{id} · ref_totals/all · users/{uid}.referredBy
"""
import os, time, random, threading, datetime as dt
from flask import request, jsonify, Response
from firebase_admin import firestore as fs, auth as fauth
from google.api_core.exceptions import AlreadyExists

import fb, security, ballgame as B
from ballgame import NOW, _bal, _cors, _out, _rate, _tx

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
SITE_URL = os.environ.get("SITE_URL", "https://ffcashbattle.in").rstrip("/")
DEFAULT_CFG = {"enabled": True, "referralsPerCard": 1, "depositRequired": 50, "amountMode": "random", "fixedAmount": 10, "minAmount": 2, "maxAmount": 10,
               "creditTo": "deposit", "claimWindowHrs": 48, "maxReferralsPerUser": 100, "maxCardsPerUser": 0}
_cfg = {"t": 0, "v": dict(DEFAULT_CFG)}
LOCKS, LOCK = {}, threading.RLock()

def cfg(force=False):
    if force or time.time() - _cfg["t"] > 15:
        try:
            d = fb.get_db().collection("config").document("referral").get(); v = dict(DEFAULT_CFG); v.update((d.to_dict() or {}) if d.exists else {}); _cfg["v"] = v
        except Exception: pass
        _cfg["t"] = time.time()
    return _cfg["v"]

def save_cfg(p):
    v = dict(DEFAULT_CFG); v.update(cfg(True))
    for k, lo, hi in (("referralsPerCard", 1, 20), ("depositRequired", 0, 100000), ("fixedAmount", 1, 100000), ("minAmount", 1, 100000), ("maxAmount", 1, 100000),
                      ("claimWindowHrs", 1, 24 * 365), ("maxReferralsPerUser", 0, 100000), ("maxCardsPerUser", 0, 100000)):
        if k in p: v[k] = max(lo, min(hi, int(float(p[k]))))
    if v["minAmount"] > v["maxAmount"]: v["minAmount"], v["maxAmount"] = v["maxAmount"], v["minAmount"]
    if "enabled" in p: v["enabled"] = bool(p["enabled"])
    if p.get("amountMode") in ("fixed", "random"): v["amountMode"] = p["amountMode"]
    if p.get("creditTo") in ("deposit", "withdraw"): v["creditTo"] = p["creditTo"]
    fb.get_db().collection("config").document("referral").set(v); _cfg.update(t=time.time(), v=v); return v

def public_cfg():
    c = cfg(); return {k: c[k] for k in ("enabled", "referralsPerCard", "depositRequired", "amountMode", "fixedAmount", "minAmount", "maxAmount", "creditTo", "claimWindowHrs")}

def ulock(uid):
    with LOCK: return LOCKS.setdefault(uid, threading.RLock())

def mask(name):
    n = (name or "Player").strip() or "Player"; return (n[:2] + "•••") if len(n) > 2 else n[0] + "••"

def _notify(uid, title, msg):
    try:
        fb.get_db().collection("users").document(uid).collection("notifications").document().set({"title": title, "message": msg, "date": dt.datetime.now(IST).strftime("%d %b %Y"), "timestamp": fs.SERVER_TIMESTAMP, "type": "reward"})
    except Exception as e: print("[ref] notify:", e, flush=True)

def _tot(**inc):
    try: fb.get_db().collection("ref_totals").document("all").set({k: fs.Increment(v) for k, v in inc.items()}, merge=True)
    except Exception as e: print("[ref] totals:", e, flush=True)

# ------------------------------------------------------------------ cards
def evaluate(uid):
    """Make sure the user holds exactly floor(qualified / referralsPerCard) cards (issue new ones, take back UNSCRATCHED extras after a void)."""
    c = cfg()
    with ulock(uid):
        db = fb.get_db()
        q = sum(1 for _ in db.collection("referrals").where("referrer", "==", uid).where("status", "==", "qualified").stream())
        earned = q // max(1, int(c["referralsPerCard"]))
        if int(c["maxCardsPerUser"]) > 0: earned = min(earned, int(c["maxCardsPerUser"]))
        cards = {d.id: d.to_dict() for d in db.collection("ref_cards").where("uid", "==", uid).stream() if (d.to_dict() or {}).get("src", "ref") == "ref"}
        top = max([int(x.get("seq", 0)) for x in cards.values()] or [0]); new = 0
        while len(cards) < earned:
            top += 1; cid = f"{uid}_{top}"
            if cid in cards: continue
            data = {"uid": uid, "seq": top, "status": "new", "amount": 0, "createdAt": NOW()}
            try: db.collection("ref_cards").document(cid).create(data)
            except AlreadyExists: pass
            cards[cid] = data; new += 1
        if new:
            _tot(cardsIssued=new)
            _notify(uid, "🎁 You won a Scratch Card!", f"Your friend's referral unlocked {new} scratch card{'s' if new > 1 else ''}. Open Refer & Earn from the menu and scratch to win real wallet money.")
        if len(cards) > earned:
            for cid, x in sorted(cards.items(), key=lambda kv: -int(kv[1].get("seq", 0))):
                if len(cards) <= earned: break
                if x.get("status") == "new":
                    db.collection("ref_cards").document(cid).delete(); cards.pop(cid)
        return cards, q

def _roll(c):
    if c["amountMode"] == "fixed": return float(c["fixedAmount"])
    lo, hi = int(c["minAmount"]), int(c["maxAmount"]); return float(random.randint(min(lo, hi), max(lo, hi)))

def _rollf(lo, hi):
    """Random amount between lo..hi (decimals allowed, 2 places). Whole-number ranges stay whole numbers."""
    lo = float(lo); hi = max(lo, float(hi))
    if lo == hi: return round(lo, 2)
    if lo.is_integer() and hi.is_integer(): return float(random.randint(int(lo), int(hi)))
    return max(round(lo, 2), min(round(hi, 2), round(random.uniform(lo, hi), 2)))

def scratch(uid, cid):
    c = cfg()
    if not cid.startswith(uid + "_"): return {"ok": False, "error": "Card not found"}
    def run(tx, db):
        cref = db.collection("ref_cards").document(cid); cs = cref.get(transaction=tx)
        if not cs.exists or (cs.to_dict() or {}).get("uid") != uid: return ("err", "Card not found")
        cd = cs.to_dict(); src = cd.get("src", "ref")
        if cd.get("status") == "cancelled": return ("err", "This card was cancelled")
        if cd.get("status") != "new": return ("done", float(cd.get("amount", 0)))        # already scratched: show the same amount again, never pay twice
        if src == "ref" and not c["enabled"]: return ("err", "Refer & Earn is switched off right now")
        uref = db.collection("users").document(uid); us = uref.get(transaction=tx)
        if not us.exists: return ("err", "Account not found")
        u = us.to_dict() or {}
        if u.get("banned") or u.get("blocked"): return ("err", "Account restricted")
        if src == "ref": amt, to = _roll(c), c["creditTo"]
        else:   # gift-code / admin card: fixed prize (gift code pool) or a random amount inside the min..max the admin set
            to = cd.get("creditTo", "deposit")
            mult = max(1, min(50, int(cd.get("mult", 1) or 1))); lo_, hi_ = float(cd.get("min", 1) or 1), float(cd.get("max", 1) or 1); hi_ = max(lo_, hi_)
            amt = float(cd["prize"]) if cd.get("prize") else round(sum(_rollf(lo_, hi_) for _ in range(mult)), 2)
        dep, wd = _bal(u)
        up = {"withdrawBalance": round(wd + amt, 2), "totalEarned": round(float(u.get("totalEarned", 0) or 0) + amt, 2)} if to == "withdraw" else {"depositBalance": round(dep + amt, 2)}
        tx.update(uref, up); tx.update(cref, {"status": "scratched", "amount": amt, "scratchedAt": NOW(), "creditedTo": to})
        tref = uref.collection("transactions").document()
        title = {"ref": "Referral Scratch Card 🎁", "gift": "Gift Scratch Card 🎁", "match": "Match Reward Scratch Card 🎁"}.get(src, "Reward Scratch Card 🎁")
        tx.set(tref, {"title": title, "amount": f"+₹{amt:g}", "type": "game", "kind": "gift", "status": "success", "date": dt.datetime.now(IST).strftime("%d/%m/%Y"), "timestamp": fs.SERVER_TIMESTAMP, "createdAt": NOW()})
        return ("ok", amt)
    with ulock(uid): st, val = _tx(run)
    if st == "err": return {"ok": False, "error": val}
    if st == "ok": _tot(cardsScratched=1, paid=val)
    return {"ok": True, "amount": val, "already": st == "done"}

# ------------------------------------------------------------------ gift-code / admin cards (src = "gift" | "admin")
def _card_notify(uid, title, msg, card=None):
    try:
        d = {"title": title, "message": msg, "date": dt.datetime.now(IST).strftime("%d %b %Y"), "timestamp": fs.SERVER_TIMESTAMP, "type": "reward"}
        if card: d["scratchCard"] = card
        fb.get_db().collection("users").document(uid).collection("notifications").document().set(d)
    except Exception as e: print("[ref] notify:", e, flush=True)

def giftcard(uid, h):
    """After a user redeemed a SCRATCH-type gift code: turn the redeem record into a scratch card (idempotent, amount = the pool amount the Firestore rules already fixed)."""
    h = str(h or "").strip().lower()
    if not (len(h) == 64 and all(ch in "0123456789abcdef" for ch in h)): return {"ok": False, "error": "Invalid code"}
    db = fb.get_db(); code = db.collection("gift_codes").document(h).get()
    if not code.exists or (code.to_dict() or {}).get("reward") != "scratch": return {"ok": False, "error": "Not a scratch code"}
    red = db.collection("gift_codes").document(h).collection("redeems").document(uid).get()
    if not red.exists: return {"ok": False, "error": "Redeem record not found"}
    cd, r = code.to_dict(), red.to_dict()
    cid = f"{uid}_g{h[:10]}"
    try: db.collection("ref_cards").document(cid).create({"uid": uid, "seq": 0, "status": "new", "amount": 0, "prize": float(r.get("amount", 0)), "src": "gift", "code": h,
                                                           "creditTo": "withdraw" if cd.get("balance") == "withdraw" else "deposit", "createdAt": NOW()})
    except AlreadyExists: return {"ok": True, "card": cid, "already": True}
    _tot(cardsIssued=1)
    _card_notify(uid, "🎁 You won a Scratch Card!", "Your gift code gave you a scratch card. Open it from here or from Refer & Earn and scratch to reveal your prize.", cid)
    return {"ok": True, "card": cid}

def sync_gift(uid, u):
    """Safety net: if the phone could not call giftcard() (server asleep), the last redeemed gift hash is checked when the user opens Refer & Earn."""
    h = str((u or {}).get("lastGiftHash") or "")
    if h:
        try: giftcard(uid, h)
        except Exception as e: print("[ref] sync_gift:", e, flush=True)

def admin_send(p):
    """Admin -> user: send N scratch cards (fixed or random min..max, to deposit or withdraw wallet). The user gets a notification with a 'Scratch now' button."""
    key = str(p.get("user", "")).strip()
    if not key: return {"ok": False, "error": "Enter the user's Player ID or UID"}
    db = fb.get_db(); uid = None
    ud = db.collection("users").document(key).get() if len(key) > 12 else None
    if ud is not None and ud.exists: uid = key
    else:
        f = _find_by_code("".join(ch for ch in key if ch.isdigit()))
        if f: uid = f.id
    if not uid: return {"ok": False, "error": "User not found"}
    n = max(1, min(10, int(float(p.get("count", 1) or 1)))); mode = p.get("mode") if p.get("mode") in ("fixed", "random") else "random"
    lo, hi = max(1, int(float(p.get("min", 1) or 1))), max(1, int(float(p.get("max", 1) or 1))); fx = max(1, int(float(p.get("fixed", 1) or 1)))
    if lo > hi: lo, hi = hi, lo
    if mode == "fixed": lo = hi = fx
    to = "withdraw" if p.get("creditTo") == "withdraw" else "deposit"; note = str(p.get("note", "") or "")[:80]; ids = []
    for i in range(n):
        cid = f"{uid}_a{NOW()}{i}"
        db.collection("ref_cards").document(cid).create({"uid": uid, "seq": 0, "status": "new", "amount": 0, "min": lo, "max": hi, "src": "admin", "creditTo": to, "note": note, "createdAt": NOW()}); ids.append(cid)
    _tot(cardsIssued=n)
    _card_notify(uid, "🎁 You received a Scratch Card!" if n == 1 else f"🎁 You received {n} Scratch Cards!", note or "FF Cash Battle sent you a scratch card. Scratch it to reveal your prize!", ids[0])
    return {"ok": True, "uid": uid, "cards": ids}

def admin_match_cards(p):
    """Admin -> match winners / players: one scratch card per user per match (fixed or random min..max). Idempotent: a user never gets two cards for the same match."""
    mid = str(p.get("matchId", "")).strip()[:60]
    rows = p.get("cards") or []
    if not mid or not isinstance(rows, list) or not rows: return {"ok": False, "error": "No cards to send"}
    if len(rows) > 300: return {"ok": False, "error": "Too many cards in one go (max 300)"}
    to = "withdraw" if p.get("creditTo") == "withdraw" else "deposit"; title = str(p.get("title", "") or "")[:40]
    db = fb.get_db(); issued, skipped = [], 0
    for r in rows:
        uid = str((r or {}).get("uid", "")).strip()
        if not uid or "/" in uid: skipped += 1; continue
        try:
            lo = round(float(r.get("min", 0.1) or 0.1), 2); hi = round(float(r.get("max", lo) or lo), 2)
        except Exception: skipped += 1; continue
        if lo < 0.1 or hi < lo or hi > 999999999: skipped += 1; continue
        if not db.collection("users").document(uid).get().exists: skipped += 1; continue
        label = str(r.get("label", "") or "Reward")[:30]
        note = f"{label} — {title or 'your match'}. Scratch to reveal your prize!"
        slot = "".join(ch for ch in str(r.get("slot", "")) if ch.isalnum())[:8]
        mult = max(1, min(50, int(float(r.get("mult", 1) or 1))))
        cid = f"{uid}_m{mid}" + (f"_{slot}" if slot else "")
        try:
            db.collection("ref_cards").document(cid).create({"uid": uid, "seq": 0, "status": "new", "amount": 0, "min": lo, "max": hi, "mult": mult, "src": "match", "matchId": mid,
                                                             "creditTo": to, "note": note, "createdAt": NOW()})
        except AlreadyExists: skipped += 1; continue
        issued.append(cid)
        _card_notify(uid, "🎁 Match Reward: Scratch Card!", note, cid)
    if issued: _tot(cardsIssued=len(issued))
    return {"ok": True, "issued": len(issued), "skipped": skipped}

def admin_cancel(cid):
    """Admin cancels an UNSCRATCHED card (gift / admin / referral). Scratched cards cannot be taken back. The user is told in Notifications."""
    ref = fb.get_db().collection("ref_cards").document(str(cid)); s = ref.get()
    if not s.exists: return {"ok": False, "error": "Card not found"}
    d = s.to_dict() or {}
    if d.get("status") == "scratched": return {"ok": False, "error": "User already scratched this card"}
    if d.get("status") == "cancelled": return {"ok": True}
    with ulock(d.get("uid", "")): 
        cur = ref.get().to_dict() or {}
        if cur.get("status") != "new": return {"ok": False, "error": "User already scratched this card"}
        ref.update({"status": "cancelled", "cancelledAt": NOW()})
    _card_notify(d.get("uid"), "Scratch Card cancelled", "One of your scratch cards was cancelled by admin. Contact support if you think this is a mistake.")
    return {"ok": True}

def admin_cards(h=None):
    db = fb.get_db(); q = db.collection("ref_cards").where("code", "==", h) if h else db.collection("ref_cards").order_by("createdAt", direction="DESCENDING").limit(60)
    rows = []
    for s in q.stream():
        x = s.to_dict() or {}
        if not h and x.get("src", "ref") == "ref": continue
        rows.append({"id": s.id, "uid": x.get("uid"), "src": x.get("src", "ref"), "status": x.get("status"), "amount": x.get("amount", 0), "prize": x.get("prize"), "min": x.get("min"), "max": x.get("max"), "mult": x.get("mult", 1), "at": x.get("createdAt")})
    return rows

# ------------------------------------------------------------------ binding a friend
def _find_by_code(code):
    for d in fb.get_db().collection("users").where("playerId", "==", code).limit(1).stream(): return d
    return None

def claim(uid, code):
    c = cfg(); code = "".join(ch for ch in str(code or "") if ch.isdigit())
    if not c["enabled"]: return {"ok": False, "error": "Refer & Earn is switched off right now"}
    if not (4 <= len(code) <= 12): return {"ok": False, "error": "Enter a valid referral code"}
    db = fb.get_db()
    with ulock(uid):
        me = db.collection("users").document(uid).get()
        if not me.exists: return {"ok": False, "error": "Account not ready — try again in a moment"}
        m = me.to_dict() or {}
        if m.get("referredBy"): return {"ok": False, "error": "You have already used a referral code"}
        ref = _find_by_code(code)
        if not ref or ref.id == uid: return {"ok": False, "error": "Invalid referral code" if not ref else "You cannot use your own code"}
        r = ref.to_dict() or {}
        if r.get("banned") or r.get("blocked"): return {"ok": False, "error": "Invalid referral code"}
        if r.get("referredBy") == uid: return {"ok": False, "error": "This code cannot be used"}
        try: created = int(fauth.get_user(uid).user_metadata.creation_timestamp)
        except Exception: created = NOW()
        if NOW() - created > int(c["claimWindowHrs"]) * 3600000: return {"ok": False, "error": f"Referral codes can only be added within {c['claimWindowHrs']} hours of joining"}
        cap = int(c["maxReferralsPerUser"])
        if cap > 0 and sum(1 for _ in db.collection("referrals").where("referrer", "==", ref.id).stream()) >= cap: return {"ok": False, "error": "This referral code has reached its limit"}
        need = int(c["depositRequired"]); dep = float(m.get("totalDeposited", 0) or 0); ok = need <= 0 or dep >= need
        data = {"referrer": ref.id, "referred": uid, "referredName": m.get("appName") or "Player", "referrerCode": code, "createdAt": NOW(), "status": "qualified" if ok else "pending"}
        if ok: data["qualifiedAt"] = NOW()
        try: db.collection("referrals").document(uid).create(data)
        except AlreadyExists: return {"ok": False, "error": "You have already used a referral code"}
        db.collection("users").document(uid).set({"referredBy": ref.id, "referredAt": NOW(), "referredByCode": code}, merge=True)
        _tot(referrals=1)
    evaluate(ref.id)
    return {"ok": True, "qualified": ok, "friend": mask(r.get("appName")), "need": need}

def qualify_for(uid):
    """When a referrer opens the page: check ONLY his own pending friends (a few reads) so a fresh deposit shows up at once."""
    c = cfg(); db = fb.get_db(); need = int(c["depositRequired"]); n = 0
    for s in db.collection("referrals").where("referrer", "==", uid).where("status", "==", "pending").stream():
        try:
            u = db.collection("users").document(s.id).get().to_dict() or {}
            if need <= 0 or float(u.get("totalDeposited", 0) or 0) >= need: s.reference.update({"status": "qualified", "qualifiedAt": NOW()}); n += 1
        except Exception as e: print("[ref] qualify_for:", e, flush=True)
    return n

def qualify_pending():
    """background: a pending referral qualifies as soon as the friend's total deposit reaches the amount. Only referrals from the last 30 days are checked (old never-deposited ones cost reads for nothing)."""
    c = cfg(); db = fb.get_db(); need = int(c["depositRequired"]); touched = set(); n = 0; cutoff = NOW() - 30 * 86400000
    for s in db.collection("referrals").where("status", "==", "pending").limit(400).stream():
        r = s.to_dict() or {}
        if int(r.get("createdAt", 0) or 0) < cutoff: continue
        try:
            u = db.collection("users").document(s.id).get().to_dict() or {}
            if need <= 0 or float(u.get("totalDeposited", 0) or 0) >= need:
                s.reference.update({"status": "qualified", "qualifiedAt": NOW()}); touched.add(r.get("referrer")); n += 1
        except Exception as e: print("[ref] qualify:", e, flush=True)
    for rid in touched:
        if rid: evaluate(rid)
    return n

# ------------------------------------------------------------------ info for the app
def info(uid):
    c = cfg(); db = fb.get_db(); u = db.collection("users").document(uid).get().to_dict() or {}
    if c["enabled"]:
        try: qualify_for(uid)
        except Exception as e: print("[ref] info-qualify:", e, flush=True)
    sync_gift(uid, u)
    cards, q = evaluate(uid) if c["enabled"] else ({}, 0)
    cards = {d.id: d.to_dict() for d in db.collection("ref_cards").where("uid", "==", uid).stream()}      # referral + gift + admin cards
    refs = [d.to_dict() for d in db.collection("referrals").where("referrer", "==", uid).stream()]
    refs.sort(key=lambda x: -int(x.get("createdAt", 0)))
    per = max(1, int(c["referralsPerCard"])); code = str(u.get("playerId") or "")
    can = False
    if c["enabled"] and not u.get("referredBy"):
        try: can = NOW() - int(fauth.get_user(uid).user_metadata.creation_timestamp) <= int(c["claimWindowHrs"]) * 3600000
        except Exception: can = False
    by = None
    if u.get("referredBy"):
        rb = db.collection("users").document(u["referredBy"]).get().to_dict() or {}; by = {"name": mask(rb.get("appName")), "code": u.get("referredByCode", "")}
    return {"ok": True, "cfg": public_cfg(), "code": code, "link": f"{SITE_URL}/?ref={code}" if code else SITE_URL,
            "stats": {"joined": len(refs), "qualified": q, "pending": sum(1 for r in refs if r.get("status") == "pending"), "cards": len(cards),
                      "fresh": sum(1 for x in cards.values() if x.get("status") == "new"), "earned": round(sum(float(x.get("amount", 0) or 0) for x in cards.values() if x.get("status") == "scratched"), 2)},
            "progress": {"per": per, "have": q % per, "toNext": per - (q % per)}, "referredBy": by, "canClaim": can,
            "cards": [{"id": k, "seq": x.get("seq"), "status": x.get("status"), "amount": x.get("amount", 0), "src": x.get("src", "ref"), "to": x.get("creditTo"), "min": x.get("min"), "max": x.get("max"), "at": x.get("scratchedAt") or x.get("createdAt")} for k, x in sorted(cards.items(), key=lambda kv: (kv[1].get("status") != "new", -int(kv[1].get("seq", 0) or 0), -int(kv[1].get("createdAt", 0) or 0)))],
            "friends": [{"name": (r.get("referredName") or "Player"), "status": r.get("status"), "at": r.get("createdAt")} for r in refs[:30]]}

# ------------------------------------------------------------------ HTTP
def register(app):
    def uid_of():
        tok = (request.headers.get("Authorization") or "").replace("Bearer ", "").strip(); return fb.verify_main_token(tok)["uid"]
    def guarded(fn):
        def w(*a, **k):
            if request.method == "OPTIONS": return _cors(Response(status=204))
            try: uid = uid_of()
            except Exception: return _out({"ok": False, "error": "Please log in again", "code": "auth"}, 401)
            if not _rate(uid): return _out({"ok": False, "error": "Too many requests — slow down"}, 429)
            try: res = fn(uid, request.get_json(silent=True) or {}); res["now"] = NOW(); return _out(res)
            except Exception as e: print("[ref] error", fn.__name__, repr(e), flush=True); return _out({"ok": False, "error": "Server error — try again"}, 500)
        w.__name__ = "ref_" + fn.__name__; return w
    def route(path):
        def deco(fn): app.add_url_rule(path, view_func=guarded(fn), methods=["POST", "OPTIONS"]); return fn
        return deco

    @route("/api/ref/info")
    def r_info(uid, d): return info(uid)
    @route("/api/ref/claim")
    def r_claim(uid, d): return claim(uid, d.get("code"))
    @route("/api/ref/giftcard")
    def r_giftcard(uid, d): return giftcard(uid, d.get("hash"))
    @route("/api/ref/scratch")
    def r_scratch(uid, d): return scratch(uid, str(d.get("card", "")))

    @app.get("/api/ref/admin/overview")
    @security.login_required
    def ref_a_overview():
        db = fb.get_db(); tot = db.collection("ref_totals").document("all").get().to_dict() or {}; rows = []
        for s in db.collection("referrals").order_by("createdAt", direction="DESCENDING").limit(60).stream():
            r = s.to_dict() or {}; rows.append({"referred": s.id, "name": r.get("referredName"), "referrer": r.get("referrer"), "code": r.get("referrerCode"), "status": r.get("status"), "at": r.get("createdAt")})
        return jsonify(ok=True, cfg=cfg(True), totals={k: tot.get(k, 0) for k in ("referrals", "cardsIssued", "cardsScratched", "paid")}, referrals=rows)
    @app.post("/api/ref/admin/config")
    @security.login_required
    def ref_a_config(): return jsonify(ok=True, cfg=save_cfg(request.get_json(silent=True) or {}))
    @app.post("/api/ref/admin/sendcard")
    @security.login_required
    def ref_a_send(): return jsonify(admin_send(request.get_json(silent=True) or {}))
    @app.post("/api/ref/admin/matchcards")
    @security.login_required
    def ref_a_matchcards(): return jsonify(admin_match_cards(request.get_json(silent=True) or {}))
    @app.post("/api/ref/admin/cancelcard")
    @security.login_required
    def ref_a_cancel(): return jsonify(admin_cancel(str((request.get_json(silent=True) or {}).get("card", ""))))
    @app.post("/api/ref/admin/cards")
    @security.login_required
    def ref_a_cards(): return jsonify(ok=True, cards=admin_cards((request.get_json(silent=True) or {}).get("hash")))
    @app.post("/api/ref/admin/void")
    @security.login_required
    def ref_a_void():
        uid = str((request.get_json(silent=True) or {}).get("referred", "")); ref = fb.get_db().collection("referrals").document(uid); s = ref.get()
        if not s.exists: return jsonify(ok=False, error="not found"), 404
        ref.update({"status": "void", "voidedAt": NOW()}); evaluate((s.to_dict() or {}).get("referrer")); return jsonify(ok=True)
    return app
