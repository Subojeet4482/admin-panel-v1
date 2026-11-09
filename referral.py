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
        cards = {d.id: d.to_dict() for d in db.collection("ref_cards").where("uid", "==", uid).stream()}
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

def scratch(uid, cid):
    c = cfg()
    if not c["enabled"]: return {"ok": False, "error": "Refer & Earn is switched off right now"}
    if not cid.startswith(uid + "_"): return {"ok": False, "error": "Card not found"}
    def run(tx, db):
        cref = db.collection("ref_cards").document(cid); cs = cref.get(transaction=tx)
        if not cs.exists or (cs.to_dict() or {}).get("uid") != uid: return ("err", "Card not found")
        cd = cs.to_dict()
        if cd.get("status") != "new": return ("done", float(cd.get("amount", 0)))        # already scratched: show the same amount again, never pay twice
        uref = db.collection("users").document(uid); us = uref.get(transaction=tx)
        if not us.exists: return ("err", "Account not found")
        u = us.to_dict() or {}
        if u.get("banned") or u.get("blocked"): return ("err", "Account restricted")
        amt = _roll(c); dep, wd = _bal(u)
        up = {"withdrawBalance": round(wd + amt, 2), "totalEarned": round(float(u.get("totalEarned", 0) or 0) + amt, 2)} if c["creditTo"] == "withdraw" else {"depositBalance": round(dep + amt, 2)}
        tx.update(uref, up); tx.update(cref, {"status": "scratched", "amount": amt, "scratchedAt": NOW(), "creditedTo": c["creditTo"]})
        tref = uref.collection("transactions").document()
        tx.set(tref, {"title": "Referral Scratch Card 🎁", "amount": f"+₹{amt:g}", "type": "game", "kind": "gift", "status": "success", "date": dt.datetime.now(IST).strftime("%d/%m/%Y"), "timestamp": fs.SERVER_TIMESTAMP, "createdAt": NOW()})
        return ("ok", amt)
    with ulock(uid): st, val = _tx(run)
    if st == "err": return {"ok": False, "error": val}
    if st == "ok": _tot(cardsScratched=1, paid=val)
    return {"ok": True, "amount": val, "already": st == "done"}

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

def qualify_pending():
    """background: a pending referral qualifies as soon as the friend's total deposit reaches the amount."""
    c = cfg(); db = fb.get_db(); need = int(c["depositRequired"]); touched = set(); n = 0
    for s in db.collection("referrals").where("status", "==", "pending").limit(400).stream():
        r = s.to_dict() or {}
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
    cards, q = evaluate(uid) if c["enabled"] else ({}, 0)
    refs = [d.to_dict() for d in db.collection("referrals").where("referrer", "==", uid).stream()]
    refs.sort(key=lambda x: -int(x.get("createdAt", 0)))
    per = max(1, int(c["referralsPerCard"])); code = str(u.get("playerId") or "")
    lst = sorted(cards.values(), key=lambda x: (x.get("status") != "new", -int(x.get("seq", 0))))
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
            "cards": [{"id": k, "seq": x.get("seq"), "status": x.get("status"), "amount": x.get("amount", 0), "at": x.get("scratchedAt") or x.get("createdAt")} for k, x in sorted(cards.items(), key=lambda kv: (kv[1].get("status") != "new", -int(kv[1].get("seq", 0))))],
            "friends": [{"name": mask(r.get("referredName")), "status": r.get("status"), "at": r.get("createdAt")} for r in refs[:30]]}

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
    @app.post("/api/ref/admin/void")
    @security.login_required
    def ref_a_void():
        uid = str((request.get_json(silent=True) or {}).get("referred", "")); ref = fb.get_db().collection("referrals").document(uid); s = ref.get()
        if not s.exists: return jsonify(ok=False, error="not found"), 404
        ref.update({"status": "void", "voidedAt": NOW()}); evaluate((s.to_dict() or {}).get("referrer")); return jsonify(ok=True)
    return app
