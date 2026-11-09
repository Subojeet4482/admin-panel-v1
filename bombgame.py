"""BOMB & GEMS — server-authoritative 5x5 mine game (service 1 / Main panel). Same wallet / matchmaking / BOT rules as Coin Battle (ballgame.py).

5x5 board = 25 boxes. At game start the SERVER hides 1..10 bombs at random. Players open one box each turn:
  gem = safe (opponent's turn) · bomb = the opener LOSES.
Why on the server: bomb positions are generated here and kept in memory + `bomb_secret/{gid}` (no client can read it).
The phone only receives {box, gem|bomb} AFTER a box is opened; the full bomb map is revealed only when the game is over.
Bots play ONLY free practice matches (cash matches are real players only), are ALWAYS labelled BOT and open random boxes.
Firestore: config/bomb · bomb_games/{gid} (players may read their own) · bomb_secret/{gid} (server only) · bomb_stats/{uid} · bomb_totals/all
"""
import os, time, random, threading, uuid
from flask import request, jsonify, Response
from firebase_admin import firestore as fs

import fb, security, ballgame as B
from ballgame import NOW, LOCK as _L, debit, credit, lb_add, player_info, bot_info, today, _bal, _cors, _out, _rate

N = 25
DEFAULT_CFG = {"enabled": True, "entries": [2, 5, 10], "cutPct": 10, "practicePerDay": 3, "botsEnabled": True, "botAfterFails": 2,
               "searchSec": 12, "paidSearchSec": 25, "turnSec": 15, "maxAuto": 3, "botMs": 900, "maxStake": 100, "minBombs": 1, "maxBombs": 10}
INTRO_MS = 11000      # extra time before the very first turn (reveal screen + coin toss + bomb roll on the phone)

_cfg = {"t": 0, "v": dict(DEFAULT_CFG)}
LOCK = threading.RLock()
QUEUE, TICKETS, FAILS, GAMES, GLOCKS = {}, {}, {}, {}, {}

_pub = {"v": None}
def _publish(enabled):
    """Mirror the ON/OFF switch to config/games so the app can hide the game card (written only when the value changes)."""
    en = bool(enabled)
    if _pub["v"] == en: return
    try: fb.get_db().collection("config").document("games").set({"bomb": en}, merge=True); _pub["v"] = en
    except Exception as e: print("[bomb] publish flag:", e, flush=True)

def cfg(force=False):
    if force or time.time() - _cfg["t"] > 20:
        try:
            d = fb.get_db().collection("config").document("bomb").get()
            v = dict(DEFAULT_CFG); v.update((d.to_dict() or {}) if d.exists else {}); _cfg["v"] = v; _publish(v.get("enabled", True))
        except Exception: pass
        _cfg["t"] = time.time()
    return _cfg["v"]

def save_cfg(patch):
    v = dict(DEFAULT_CFG); v.update(cfg(True))
    ent = patch.get("entries")
    if ent is not None: v["entries"] = sorted({int(x) for x in ent if 1 <= int(x) <= int(v.get("maxStake", 100))})[:6] or [2, 5, 10]
    for k, lo, hi in (("cutPct", 0, 50), ("practicePerDay", 0, 50), ("botAfterFails", 1, 5), ("searchSec", 4, 40), ("paidSearchSec", 4, 120), ("turnSec", 6, 60), ("maxAuto", 0, 10), ("botMs", 300, 3000), ("maxStake", 1, 1000), ("minBombs", 1, 24), ("maxBombs", 1, 24)):
        if k in patch: v[k] = max(lo, min(hi, int(patch[k])))
    if v["minBombs"] > v["maxBombs"]: v["minBombs"] = v["maxBombs"]
    for k in ("enabled", "botsEnabled"):
        if k in patch: v[k] = bool(patch[k])
    fb.get_db().collection("config").document("bomb").set(v)
    _publish(v.get("enabled", True))
    _cfg.update(t=time.time(), v=v); return v

def public_cfg():
    c = cfg(); return {k: c[k] for k in ("enabled", "entries", "cutPct", "practicePerDay", "botsEnabled", "searchSec", "paidSearchSec", "turnSec", "maxAuto", "botAfterFails", "minBombs", "maxBombs")}

def glock(gid):
    with LOCK: return GLOCKS.setdefault(gid, threading.RLock())

# ---------------------------------------------------------------- game state
PUBLIC = ("id", "uids", "players", "stake", "practice", "nb", "turn", "status", "winner", "reason", "moves", "deadline", "auto", "createdAt", "finishedAt", "prize", "cutPct", "turnSec", "settled", "reveal")

def public_game(g): return {k: g.get(k) for k in PUBLIC}

def save_game(g, secret=False):
    GAMES[g["id"]] = g
    d = {k: v for k, v in g.items() if k != "id" and k != "bombs"}          # bomb map NEVER goes into the public document
    db = fb.get_db(); db.collection("bomb_games").document(g["id"]).set(d)
    if secret: db.collection("bomb_secret").document(g["id"]).set({"bombs": g["bombs"]})

def load_game(gid):
    g = GAMES.get(gid)
    if g: return g
    db = fb.get_db(); s = db.collection("bomb_games").document(gid).get()
    if not s.exists: return None
    g = s.to_dict(); g["id"] = gid
    sec = db.collection("bomb_secret").document(gid).get().to_dict() or {}
    g["bombs"] = sec.get("bombs", g.get("reveal") or []); GAMES[gid] = g; return g

def active_game_of(uid):
    with LOCK:
        for g in GAMES.values():
            if g["status"] == "playing" and uid in g["uids"]: return g
    return None

def stat_add(uid, **inc):
    try: fb.get_db().collection("bomb_stats").document(uid).set({k: fs.Increment(v) for k, v in inc.items()}, merge=True)
    except Exception as e: print("[bomb] stats:", e, flush=True)

def create_game(p0, p1, stake, practice):
    c = cfg(); gid = uuid.uuid4().hex[:14]; taken = []
    if not practice:
        for p in (p0, p1):
            if p["bot"]: continue
            if not debit(p["uid"], stake, "Bomb & Gems entry"):
                for q in taken: credit(q, stake, "Bomb & Gems refund", "game_refund")
                return None, p["uid"]
            taken.append(p["uid"])
    nb = random.randint(int(c["minBombs"]), int(c["maxBombs"]))
    bombs = sorted(random.sample(range(N), nb))
    first = random.choice((0, 1))                                  # the coin toss on the phone only SHOWS this result
    g = {"id": gid, "uids": [p0["uid"], p1["uid"]], "players": [p0, p1], "stake": stake, "practice": practice, "nb": nb, "bombs": bombs, "turn": first, "status": "playing",
         "winner": -1, "reason": "", "moves": [], "auto": [0, 0], "createdAt": NOW(), "cutPct": c["cutPct"], "turnSec": c["turnSec"], "settled": False, "reveal": [],
         "deadline": NOW() + c["turnSec"] * 1000 + INTRO_MS}
    save_game(g, secret=True)
    for p in (p0, p1):
        if not p["bot"]: stat_add(p["uid"], games=1)
    if p0["bot"] or p1["bot"]: _bot_turns(g)
    return g, None

def _prize(g): return round(g["stake"] * 2 * (100 - g["cutPct"]) / 100.0, 2)

def finish(g, winner, reason):
    """idempotent — pays out exactly once. winner 0/1 (no draws in this game)."""
    with glock(g["id"]):
        if g["status"] == "done": return g
        g.update(status="done", winner=winner, reason=reason, finishedAt=NOW(), settled=False, reveal=list(g["bombs"]))
        humans = [i for i, p in enumerate(g["players"]) if not p["bot"]]
        stake, practice = g["stake"], g["practice"]
        prize = _prize(g) if not practice else 0
        g["prize"] = prize
        try:
            if not practice:
                if winner in humans:
                    p = g["players"][winner]
                    credit(p["uid"], prize, "Bomb & Gems — You won", "game_win"); lb_add(p["uid"], p["name"], p["photo"], prize)
                    stat_add(p["uid"], wins=1, won=prize)
                for i in humans:
                    if winner != i: stat_add(g["uids"][i], losses=1, lost=stake)
                tot = {"games": 1, "entries": stake * len(humans), "botGames": 1 if len(humans) == 1 else 0, "payouts": prize if winner in humans else 0}
                fb.get_db().collection("bomb_totals").document("all").set({k: fs.Increment(v) for k, v in tot.items()}, merge=True)
            else:
                for i in humans: stat_add(g["uids"][i], practiceGames=1)
            g["settled"] = True
        except Exception as e:
            print("[bomb] SETTLE ERROR", g["id"], e, flush=True); g["settleError"] = str(e)[:200]
        save_game(g)
        try: fb.get_db().collection("bomb_secret").document(g["id"]).delete()
        except Exception: pass
        return g

def apply_open(g, pi, box, delay=0):
    if not (0 <= box < N): return "invalid box"
    if any(m["i"] == box for m in g["moves"]): return "box already open"
    bomb = 1 if box in g["bombs"] else 0
    g["moves"].append({"p": pi, "i": box, "b": bomb, "d": int(delay)})
    if bomb: finish(g, 1 - pi, "bomb"); return None
    g["turn"] = 1 - pi; g["deadline"] = NOW() + int(delay) + g["turnSec"] * 1000 + 600
    return None

def _closed(g):
    o = {m["i"] for m in g["moves"]}; return [i for i in range(N) if i not in o]

def _bot_turns(g):
    c = cfg(); guard = 0
    while g["status"] == "playing" and g["players"][g["turn"]]["bot"] and guard < 3:
        guard += 1; pi = g["turn"]; cl = _closed(g)
        if not cl: break
        apply_open(g, pi, random.choice(cl), delay=random.randint(int(c["botMs"]), int(c["botMs"]) + 1800))
    if g["status"] == "playing": save_game(g)

def human_open(uid, gid, box):
    with glock(gid):
        g = load_game(gid)
        if not g: return None, "game not found"
        if uid not in g["uids"]: return None, "not your game"
        if g["status"] != "playing": return public_game(g), None
        pi = g["uids"].index(uid)
        if g["turn"] != pi: return public_game(g), "not your turn"
        try: box = int(box)
        except Exception: return public_game(g), "invalid box"
        err = apply_open(g, pi, box)
        if err: return public_game(g), err
        if g["status"] == "playing": _bot_turns(g)
        save_game(g); return public_game(g), None

def tick(gid):
    with glock(gid):
        g = load_game(gid)
        if not g or g["status"] != "playing": return public_game(g) if g else None
        if NOW() <= g["deadline"]: return public_game(g)
        pi = g["turn"]
        if g["players"][pi]["bot"]: _bot_turns(g); return public_game(g)
        g["auto"][pi] += 1
        if g["auto"][pi] > cfg()["maxAuto"]: finish(g, 1 - pi, "afk"); return public_game(g)
        cl = _closed(g)
        if cl: apply_open(g, pi, random.choice(cl))
        if g["status"] == "playing": _bot_turns(g)
        save_game(g); return public_game(g)

def leave(uid, gid):
    with glock(gid):
        g = load_game(gid)
        if not g or uid not in g["uids"] or g["status"] != "playing": return public_game(g) if g else None
        pi = g["uids"].index(uid); finish(g, 1 - pi, "forfeit"); return public_game(g)

# ---------------------------------------------------------------- matchmaking (same rules as Coin Battle)
def _key(practice, stake): return "p" if practice else f"s{stake}"

def _wait(c, practice): return c["searchSec"] if practice else c["paidSearchSec"]    # cash matches wait longer: they only ever get a REAL player

def _practice_used(uid):
    ref = fb.get_db().collection("bomb_stats").document(uid); s = ref.get().to_dict() or {}
    n = (int(s.get("practiceUsed", 0) or 0) + 1) if s.get("practiceDay") == today() else 1
    ref.set({"practiceDay": today(), "practiceUsed": n}, merge=True)

def _drop_ticket(t):
    t["status"] = "cancelled"
    try: QUEUE.get(t["key"], []).remove(t)
    except ValueError: pass

def find(uid, entry, practice):
    c = cfg()
    if not c["enabled"]: return {"error": "Bomb & Gems is switched off right now"}
    if practice:
        st = fb.get_db().collection("bomb_stats").document(uid).get().to_dict() or {}
        used = int(st.get("practiceUsed", 0) or 0) if st.get("practiceDay") == today() else 0
        if used >= c["practicePerDay"]: return {"error": f"Daily practice limit reached ({c['practicePerDay']}/day)"}
        entry = 0
    else:
        entry = int(entry or 0)
        if entry not in c["entries"]: return {"error": "Invalid entry amount"}
        u = fb.get_db().collection("users").document(uid).get().to_dict() or {}
        dep, wd = _bal(u)
        if dep + wd < entry: return {"error": "Not enough balance — add money first"}
    with LOCK:
        ag = active_game_of(uid)
        if ag: return {"status": "matched", "gid": ag["id"], "resume": True}
        for t in [t for t in TICKETS.values() if t["uid"] == uid and t["status"] == "waiting"]: _drop_ticket(t)
        key = _key(practice, entry); me = player_info(uid)
        for t in list(QUEUE.get(key, [])):
            if t["uid"] != uid and time.time() - t["ts"] < _wait(c, practice) + 4:
                opp = t["player"]
                g, bad = create_game(opp, me, entry, practice)
                QUEUE[key].remove(t)
                if g is None:
                    if bad == me["uid"]: return {"error": "Not enough balance — add money first"}
                    t["status"] = "cancelled"; continue
                t.update(status="matched", gid=g["id"]); FAILS.pop(uid, None); FAILS.pop(opp["uid"], None)
                if practice: _practice_used(uid); _practice_used(opp["uid"])
                return {"status": "matched", "gid": g["id"]}
        tk = uuid.uuid4().hex[:12]
        t = {"id": tk, "uid": uid, "key": key, "entry": entry, "practice": practice, "player": me, "ts": time.time(), "status": "waiting", "gid": None}
        TICKETS[tk] = t; QUEUE.setdefault(key, []).append(t)
        return {"status": "waiting", "ticket": tk, "searchSec": _wait(c, practice), "attempt": FAILS.get(uid, {}).get("n", 0) + 1, "botAfter": c["botAfterFails"], "practice": practice}

def poll(uid, tk):
    c = cfg()
    with LOCK:
        t = TICKETS.get(tk)
        if not t or t["uid"] != uid: return {"status": "none"}
        if t["status"] == "matched": return {"status": "matched", "gid": t["gid"]}
        if t["status"] != "waiting": return {"status": "cancelled"}
        w = _wait(c, t["practice"])
        if time.time() - t["ts"] < w: return {"status": "waiting", "left": int(w - (time.time() - t["ts"]))}
        _drop_ticket(t)
        if not t["practice"]:                      # CASH match: never a bot. Nothing was charged yet (entry is taken only when a real opponent is found).
            return {"status": "nomatch", "paid": True}
        f = FAILS.setdefault(uid, {"n": 0, "t": 0})
        if time.time() - f["t"] > 900: f["n"] = 0
        f["n"] += 1; f["t"] = time.time()
        if c["botsEnabled"] and t["practice"] and f["n"] >= c["botAfterFails"]:
            g, bad = create_game(t["player"], bot_info(), t["entry"], t["practice"])
            if g is None: return {"status": "error", "error": "Not enough balance — add money first"}
            f["n"] = 0
            if t["practice"]: _practice_used(uid)
            return {"status": "matched", "gid": g["id"], "bot": True}
        return {"status": "nomatch", "fails": f["n"], "botAfter": c["botAfterFails"]}

# ---------------------------------------------------------------- HTTP
def register(app):
    def uid_of():
        tok = (request.headers.get("Authorization") or "").replace("Bearer ", "").strip()
        return fb.verify_main_token(tok)["uid"]

    def guarded(fn):
        def w(*a, **k):
            if request.method == "OPTIONS": return _cors(Response(status=204))
            try: uid = uid_of()
            except Exception: return _out({"ok": False, "error": "Please log in again", "code": "auth"}, 401)
            if not _rate(uid): return _out({"ok": False, "error": "Too many requests — slow down"}, 429)
            try:
                res = fn(uid, request.get_json(silent=True) or {}); res["now"] = NOW(); return _out(res)
            except Exception as e:
                print("[bomb] error", fn.__name__, repr(e), flush=True); return _out({"ok": False, "error": "Game server error — try again"}, 500)
        w.__name__ = "bomb_" + fn.__name__; return w

    def route(path, methods=("POST", "OPTIONS")):
        def deco(fn): app.add_url_rule(path, view_func=guarded(fn), methods=list(methods)); return fn
        return deco

    @route("/api/bomb/config", ("GET", "POST", "OPTIONS"))
    def r_config(uid, d):
        st = fb.get_db().collection("bomb_stats").document(uid).get().to_dict() or {}
        used = int(st.get("practiceUsed", 0) or 0) if st.get("practiceDay") == today() else 0
        ag = active_game_of(uid)
        return {"ok": True, "cfg": public_cfg(), "practiceLeft": max(0, cfg()["practicePerDay"] - used), "active": ag["id"] if ag else None,
                "stats": {k: st.get(k, 0) for k in ("games", "wins", "losses", "won", "lost")}}

    @route("/api/bomb/find")
    def r_find(uid, d):
        r = find(uid, d.get("entry"), bool(d.get("practice"))); r["ok"] = "error" not in r; return r

    @route("/api/bomb/poll")
    def r_poll(uid, d):
        r = poll(uid, str(d.get("ticket", ""))); r["ok"] = r.get("status") != "error"; return r

    @route("/api/bomb/cancel")
    def r_cancel(uid, d):
        with LOCK:
            t = TICKETS.get(str(d.get("ticket", "")))
            if t and t["uid"] == uid and t["status"] == "waiting": _drop_ticket(t)
        return {"ok": True}

    @route("/api/bomb/open")
    def r_open(uid, d):
        g, err = human_open(uid, str(d.get("gid", "")), d.get("box", -1))
        return {"ok": err is None, "error": err, "game": g}

    @route("/api/bomb/tick")
    def r_tick(uid, d):
        g = load_game(str(d.get("gid", "")))
        if not g or uid not in g["uids"]: return {"ok": False, "error": "game not found"}
        return {"ok": True, "game": tick(g["id"])}

    @route("/api/bomb/leave")
    def r_leave(uid, d): return {"ok": True, "game": leave(uid, str(d.get("gid", "")))}

    @route("/api/bomb/game")
    def r_game(uid, d):
        g = load_game(str(d.get("gid", "")))
        if not g or uid not in g["uids"]: return {"ok": False, "error": "game not found"}
        return {"ok": True, "game": public_game(g)}

    @app.get("/api/bomb/admin/overview")
    @security.login_required
    def bomb_a_overview():
        db = fb.get_db(); tot = db.collection("bomb_totals").document("all").get().to_dict() or {}
        games = []
        for s in db.collection("bomb_games").order_by("createdAt", direction="DESCENDING").limit(40).stream():
            g = s.to_dict(); games.append({"id": s.id, "t": g.get("createdAt"), "stake": g.get("stake"), "practice": g.get("practice"), "status": g.get("status"), "winner": g.get("winner"), "reason": g.get("reason"),
                                         "prize": g.get("prize"), "nb": g.get("nb"), "players": [{"name": p.get("name"), "bot": p.get("bot")} for p in g.get("players", [])], "moves": len(g.get("moves", []))})
        hn = (tot.get("entries", 0) or 0) - (tot.get("payouts", 0) or 0)
        return jsonify(ok=True, cfg=cfg(True), totals={**{k: tot.get(k, 0) for k in ("games", "botGames", "entries", "payouts")}, "houseNet": round(hn, 2)}, games=games,
                       live=sum(1 for g in GAMES.values() if g["status"] == "playing"), queue=sum(len(v) for v in QUEUE.values()))

    @app.post("/api/bomb/admin/config")
    @security.login_required
    def bomb_a_config(): return jsonify(ok=True, cfg=save_cfg(request.get_json(silent=True) or {}))
    return app

def restore():
    n = 0
    db = fb.get_db()
    for s in db.collection("bomb_games").where("status", "==", "playing").limit(200).stream():
        g = s.to_dict(); g["id"] = s.id
        sec = db.collection("bomb_secret").document(s.id).get().to_dict() or {}
        if not sec.get("bombs"): continue
        g["bombs"] = sec["bombs"]; GAMES[s.id] = g; n += 1
    return n

def janitor():
    now = NOW()
    for gid in [k for k, g in list(GAMES.items()) if g.get("status") == "playing" and now > g.get("deadline", 0) + 2500]:
        try: tick(gid)
        except Exception as e: print("[bomb] janitor", gid, e, flush=True)
    with LOCK:
        for k in [k for k, t in TICKETS.items() if time.time() - t["ts"] > 180]: TICKETS.pop(k, None)
        for k, v in list(QUEUE.items()): QUEUE[k] = [t for t in v if time.time() - t["ts"] < 180]

def purge_old(days=14):
    db = fb.get_db(); cutoff = NOW() - days * 86400000; n = 0
    for s in db.collection("bomb_games").where("createdAt", "<", cutoff).limit(300).stream():
        s.reference.delete(); n += 1
    for gid in [k for k, g in GAMES.items() if g.get("status") == "done" and NOW() - (g.get("finishedAt") or 0) > 3600000]: GAMES.pop(gid, None); GLOCKS.pop(gid, None)
    return n
