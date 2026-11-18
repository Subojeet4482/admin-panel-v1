"""FRUIT SLASH — real-time 1v1 duel (service 1 / Main panel). Same wallet / entries (Rs 2/5/10) / cut as Coin Battle & Bomb & Gems.

How it works (server-authoritative, so the phone cannot cheat):
  * Matchmaking finds a REAL opponent for a cash match (never a bot). Entry is charged only when both players are found.
  * The SERVER builds the fruit schedule (what flies, when, with which launch numbers) and a shared `startAt` time.
    Both phones start at the same server time and see the SAME fruits (public doc fruit_games/{gid}).
  * A phone reports only {fruit index, time} of every slice. The SERVER checks the fruit really existed at that time, that it was not sliced twice,
    and computes the score + combo bonus itself. A bomb ends that player's run (score stays).
  * Scores are mirrored to fruit_games/{gid} (throttled) -> the opponent's live score reaches the other phone through onSnapshot = real time.
  * When both runs are over (or time + grace is over) the higher score wins 2x entry minus cut. Equal score = both refunded.
Free match (no money, NO time limit) is solo and runs only on the phone (pages/game/fruit.html), nothing is stored on the server.
Firestore: config/fruit · fruit_games/{gid} (players read their own) · fruit_stats/{uid} · fruit_totals/all
"""
import time, random, threading, uuid
from flask import request, jsonify, Response
from firebase_admin import firestore as fs

import fb, security, ballgame as B
from ballgame import NOW, debit, credit, lb_add, player_info, today, _bal, _cors, _out, _rate

DEFAULT_CFG = {"enabled": True, "freeEnabled": True, "entries": [2, 5, 10], "cutPct": 10, "durationSec": 60, "paidSearchSec": 40, "maxStake": 100}
GRACE_MS = 4500          # after time is up, late reports are still accepted for this long
COUNTDOWN_MS = 5500      # shared "3-2-1" before the first fruit (reveal screen + countdown)
FLIGHT_MS = 2300         # a fruit is slice-able from spawn until ~FLIGHT_MS later (flight time does not depend on the screen size)
MIN_VISIBLE_MS = 180     # a fruit cannot be sliced before it is on screen
COMBO_GAP_MS = 350
KINDS = ["lemon", "apple", "orange", "strawberry", "banana", "kiwi", "watermelon", "dragon", "pineapple", "bomb"]
PTS = {"lemon": 5, "apple": 10, "orange": 12, "strawberry": 15, "banana": 18, "kiwi": 20, "watermelon": 25, "dragon": 30, "pineapple": 40, "bomb": 0}
WEIGHT = {"lemon": 10, "apple": 14, "orange": 12, "strawberry": 11, "banana": 10, "kiwi": 8, "watermelon": 7, "dragon": 5, "pineapple": 4}
BOMB = KINDS.index("bomb")

_cfg = {"t": 0, "v": dict(DEFAULT_CFG)}
LOCK = threading.RLock()
QUEUE, TICKETS, GAMES, GLOCKS = {}, {}, {}, {}
_pub = {"v": None}
_lastw = {}              # gid -> last firestore write (throttle)


def _publish(enabled):
    en = bool(enabled)
    if _pub["v"] == en: return
    try: fb.get_db().collection("config").document("games").set({"fruit": en}, merge=True); _pub["v"] = en
    except Exception as e: print("[fruit] publish flag:", e, flush=True)


def cfg(force=False):
    if force or time.time() - _cfg["t"] > 20:
        try:
            d = fb.get_db().collection("config").document("fruit").get()
            v = dict(DEFAULT_CFG); v.update((d.to_dict() or {}) if d.exists else {}); _cfg["v"] = v; _publish(v.get("enabled", True))
        except Exception: pass
        _cfg["t"] = time.time()
    return _cfg["v"]


def save_cfg(patch):
    v = dict(DEFAULT_CFG); v.update(cfg(True))
    ent = patch.get("entries")
    if ent is not None: v["entries"] = sorted({int(x) for x in ent if 1 <= int(x) <= int(v.get("maxStake", 100))})[:6] or [2, 5, 10]
    for k, lo, hi in (("cutPct", 0, 50), ("durationSec", 20, 120), ("paidSearchSec", 4, 120), ("maxStake", 1, 1000)):
        if k in patch: v[k] = max(lo, min(hi, int(patch[k])))
    if "enabled" in patch: v["enabled"] = bool(patch["enabled"])
    if "freeEnabled" in patch: v["freeEnabled"] = bool(patch["freeEnabled"])
    fb.get_db().collection("config").document("fruit").set(v); _publish(v.get("enabled", True)); _cfg.update(t=time.time(), v=v); return v


def public_cfg():
    c = cfg(); return {k: c.get(k) for k in ("enabled", "freeEnabled", "entries", "cutPct", "durationSec", "paidSearchSec")}


def glock(gid):
    with LOCK: return GLOCKS.setdefault(gid, threading.RLock())


# ---------------------------------------------------------------- schedule (same fruits for both players)
def make_schedule(dur_s):
    """[[t_ms, kind_idx, u1, u2, u3, u4, rot, vr], ...]  u* are launch randoms in 0..1000 (the phone turns them into x / height / sideways speed)."""
    out, t, sb = [], 900, 0.0
    names = list(WEIGHT); wts = [WEIGHT[k] for k in names]
    end = dur_s * 1000 - 1200
    while t < end:
        lvl = min(8, int(t / 8000)); n = min(6, 1 + int(random.random() * (3 + lvl * .4)))
        bomb_wave = n >= 2 and t > 3000 and (sb > 10 or random.random() < min(.14, .08 + lvl * .008))
        bi = 1 + int(random.random() * (n - 1)) if bomb_wave else -1
        for i in range(n):
            k = BOMB if i == bi else KINDS.index(random.choices(names, wts)[0])
            if i == bi: sb = 0.0
            out.append([int(t + i * 130 + random.random() * 70), k] + [random.randint(0, 1000) for _ in range(4)] + [random.randint(0, 6283), random.randint(-2500, 2500)])
        gap = max(.5, 1.35 - lvl * .1) + random.random() * .35
        t += int(gap * 1000); sb += gap
    out.sort(key=lambda e: e[0]); return out


# ---------------------------------------------------------------- game state
PUBLIC = ("id", "uids", "players", "stake", "status", "winner", "reason", "startAt", "dur", "scores", "cuts", "done", "createdAt", "finishedAt", "prize", "cutPct", "settled", "sched")

def public_game(g): return {k: g.get(k) for k in PUBLIC}


def save_game(g, force=True):
    GAMES[g["id"]] = g
    if not force and time.time() - _lastw.get(g["id"], 0) < .7: return
    _lastw[g["id"]] = time.time()
    d = {k: v for k, v in g.items() if k in PUBLIC and k != "id"}
    fb.get_db().collection("fruit_games").document(g["id"]).set(d)


def load_game(gid):
    g = GAMES.get(gid)
    if g: return g
    s = fb.get_db().collection("fruit_games").document(gid).get()
    if not s.exists: return None
    g = s.to_dict(); g["id"] = gid; g.setdefault("hit", [[], []]); GAMES[gid] = g; return g


def active_game_of(uid):
    with LOCK:
        for g in GAMES.values():
            if g["status"] == "playing" and uid in g["uids"]: return g
    return None


def stat_add(uid, **inc):
    try: fb.get_db().collection("fruit_stats").document(uid).set({k: fs.Increment(v) for k, v in inc.items()}, merge=True)
    except Exception as e: print("[fruit] stats:", e, flush=True)


def create_game(p0, p1, stake):
    c = cfg(); gid = uuid.uuid4().hex[:14]; taken = []
    for p in (p0, p1):
        if not debit(p["uid"], stake, "Fruit Slash entry"):
            for q in taken: credit(q, stake, "Fruit Slash refund", "game_refund")
            return None, p["uid"]
        taken.append(p["uid"])
    dur = int(c["durationSec"])
    g = {"id": gid, "uids": [p0["uid"], p1["uid"]], "players": [p0, p1], "stake": stake, "status": "playing", "winner": -1, "reason": "", "startAt": NOW() + COUNTDOWN_MS,
         "dur": dur, "scores": [0, 0], "cuts": [0, 0], "done": [False, False], "createdAt": NOW(), "cutPct": c["cutPct"], "settled": False, "sched": make_schedule(dur),
         "hit": [[], []]}        # hit = [[(idx, t)...], [...]] server memory only (accepted slices), rebuilt from scores if the server restarts
    save_game(g)
    for p in (p0, p1): stat_add(p["uid"], games=1)
    return g, None


def _prize(g): return round(g["stake"] * 2 * (100 - g["cutPct"]) / 100.0, 2)


def _score(g, pi):
    """score from the accepted slices: fruit points + combo bonus (3+ slices, each gap < 350 ms = one swipe)."""
    hits = sorted(g["hit"][pi], key=lambda h: h[1]); pts = 0; grp = []
    def close():
        return len(grp) * 5 if len(grp) >= 3 else 0
    for idx, t in hits:
        k = g["sched"][idx][1]
        if k == BOMB: continue
        pts += PTS[KINDS[k]]
        if grp and t - grp[-1] < COMBO_GAP_MS: grp.append(t)
        else: pts += close(); grp = [t]
    return pts + close()


def finish(g, reason):
    with glock(g["id"]):
        if g["status"] == "done": return g
        s0, s1 = g["scores"]; winner = 0 if s0 > s1 else 1 if s1 > s0 else -1
        g.update(status="done", winner=winner, reason=reason, finishedAt=NOW(), settled=False)
        stake = g["stake"]; prize = _prize(g) if winner >= 0 else 0; g["prize"] = prize
        try:
            if winner < 0:
                for u in g["uids"]: credit(u, stake, "Fruit Slash — draw refund", "game_refund")
                tot = {"games": 1, "entries": 0, "payouts": 0}
            else:
                p = g["players"][winner]
                credit(p["uid"], prize, "Fruit Slash — You won", "game_win"); lb_add(p["uid"], p["name"], p["photo"], prize)
                stat_add(p["uid"], wins=1, won=prize); stat_add(g["uids"][1 - winner], losses=1, lost=stake)
                tot = {"games": 1, "entries": stake * 2, "payouts": prize}
            fb.get_db().collection("fruit_totals").document("all").set({k: fs.Increment(v) for k, v in tot.items()}, merge=True)
            g["settled"] = True
        except Exception as e:
            print("[fruit] SETTLE ERROR", g["id"], e, flush=True); g["settleError"] = str(e)[:200]
        save_game(g); return g


def _maybe_done(g):
    if g["status"] != "playing": return
    end = g["startAt"] + g["dur"] * 1000
    if all(g["done"]) or NOW() > end + GRACE_MS: finish(g, "time" if NOW() > end else "bomb")


def report(uid, gid, hits, end_flag):
    """hits = [[idx, t_ms_since_start], ...]  (new slices since the last report)."""
    with glock(gid):
        g = load_game(gid)
        if not g: return None, "game not found"
        if uid not in g["uids"]: return None, "not your game"
        if g["status"] != "playing": return public_game(g), None
        pi = g["uids"].index(uid); now_rel = NOW() - g["startAt"]; sched = g["sched"]; mine = g["hit"][pi]
        seen = {h[0] for h in mine}; dead = any(sched[i][1] == BOMB for i, _ in mine)
        if not g["done"][pi] and now_rel > -300 and now_rel <= g["dur"] * 1000 + GRACE_MS:
            for h in (hits or [])[:60]:
                try: idx, t = int(h[0]), int(h[1])
                except Exception: continue
                if dead or idx in seen or not (0 <= idx < len(sched)): continue
                sp = sched[idx][0]
                if t > now_rel + 900 or t > g["dur"] * 1000 + 300: continue          # a slice cannot be from the future / after the end
                if not (sp + MIN_VISIBLE_MS <= t <= sp + FLIGHT_MS): continue        # the fruit was not in the air then
                mine.append([idx, t]); seen.add(idx)
                if sched[idx][1] == BOMB: dead = True
        g["scores"][pi] = _score(g, pi); g["cuts"][pi] = sum(1 for i, _ in mine if sched[i][1] != BOMB)
        if dead or end_flag or now_rel > g["dur"] * 1000 + 800: g["done"][pi] = True
        save_game(g, force=g["done"][pi]); _maybe_done(g)
        if g["status"] == "done": save_game(g)
        return public_game(g), None


def tick(gid):
    with glock(gid):
        g = load_game(gid)
        if not g: return None
        if g["status"] == "playing":
            end = g["startAt"] + g["dur"] * 1000
            if NOW() > end + 800:
                for i in (0, 1): g["done"][i] = True
            _maybe_done(g)
            if g["status"] == "playing" and NOW() > end + GRACE_MS: finish(g, "time")
        return public_game(g)


def leave(uid, gid):
    """leaving before the run starts = forfeit (opponent wins); after start = the run just ends with the score so far."""
    with glock(gid):
        g = load_game(gid)
        if not g or uid not in g["uids"] or g["status"] != "playing": return public_game(g) if g else None
        pi = g["uids"].index(uid)
        if NOW() < g["startAt"] - 500: g["scores"][pi] = -1; g["scores"][1 - pi] = max(0, g["scores"][1 - pi]); g["done"] = [True, True]; finish(g, "forfeit"); return public_game(g)
        g["done"][pi] = True; save_game(g); _maybe_done(g); return public_game(g)


# ---------------------------------------------------------------- matchmaking (real players only)
def _drop_ticket(t):
    t["status"] = "cancelled"
    try: QUEUE.get(t["key"], []).remove(t)
    except ValueError: pass


def find(uid, entry):
    c = cfg()
    if not c["enabled"]: return {"error": "Fruit Slash is switched off right now"}
    entry = int(entry or 0)
    if entry not in c["entries"]: return {"error": "Invalid entry amount"}
    u = fb.get_db().collection("users").document(uid).get().to_dict() or {}
    dep, wd = _bal(u)
    if dep + wd < entry: return {"error": "Not enough balance — add money first"}
    with LOCK:
        ag = active_game_of(uid)
        if ag: return {"status": "matched", "gid": ag["id"], "resume": True}
        for t in [t for t in TICKETS.values() if t["uid"] == uid and t["status"] == "waiting"]: _drop_ticket(t)
        key = f"s{entry}"; me = player_info(uid)
        for t in list(QUEUE.get(key, [])):
            if t["uid"] != uid and time.time() - t["ts"] < c["paidSearchSec"] + 4:
                g, bad = create_game(t["player"], me, entry); QUEUE[key].remove(t)
                if g is None:
                    if bad == me["uid"]: return {"error": "Not enough balance — add money first"}
                    t["status"] = "cancelled"; continue
                t.update(status="matched", gid=g["id"]); return {"status": "matched", "gid": g["id"]}
        tk = uuid.uuid4().hex[:12]
        t = {"id": tk, "uid": uid, "key": key, "entry": entry, "player": me, "ts": time.time(), "status": "waiting", "gid": None}
        TICKETS[tk] = t; QUEUE.setdefault(key, []).append(t)
        return {"status": "waiting", "ticket": tk, "searchSec": c["paidSearchSec"]}


def poll(uid, tk):
    c = cfg()
    with LOCK:
        t = TICKETS.get(tk)
        if not t or t["uid"] != uid: return {"status": "none"}
        if t["status"] == "matched": return {"status": "matched", "gid": t["gid"]}
        if t["status"] != "waiting": return {"status": "cancelled"}
        w = c["paidSearchSec"]
        if time.time() - t["ts"] < w: return {"status": "waiting", "left": int(w - (time.time() - t["ts"]))}
        _drop_ticket(t); return {"status": "nomatch", "paid": True}      # nothing was charged: entry is taken only when a real opponent is found


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
            if not _rate(uid, 120): return _out({"ok": False, "error": "Too many requests — slow down"}, 429)
            try:
                res = fn(uid, request.get_json(silent=True) or {}); res["now"] = NOW(); return _out(res)
            except Exception as e:
                print("[fruit] error", fn.__name__, repr(e), flush=True); return _out({"ok": False, "error": "Game server error — try again"}, 500)
        w.__name__ = "fruit_" + fn.__name__; return w

    def route(path, methods=("POST", "OPTIONS")):
        def deco(fn): app.add_url_rule(path, view_func=guarded(fn), methods=list(methods)); return fn
        return deco

    @route("/api/fruit/config", ("GET", "POST", "OPTIONS"))
    def r_config(uid, d):
        st = fb.get_db().collection("fruit_stats").document(uid).get().to_dict() or {}
        ag = active_game_of(uid)
        return {"ok": True, "cfg": public_cfg(), "active": ag["id"] if ag else None, "stats": {k: st.get(k, 0) for k in ("games", "wins", "losses", "won", "lost")}}

    @route("/api/fruit/find")
    def r_find(uid, d): r = find(uid, d.get("entry")); r["ok"] = "error" not in r; return r

    @route("/api/fruit/poll")
    def r_poll(uid, d): r = poll(uid, str(d.get("ticket", ""))); r["ok"] = r.get("status") != "error"; return r

    @route("/api/fruit/cancel")
    def r_cancel(uid, d):
        with LOCK:
            t = TICKETS.get(str(d.get("ticket", "")))
            if t and t["uid"] == uid and t["status"] == "waiting": _drop_ticket(t)
        return {"ok": True}

    @route("/api/fruit/hits")
    def r_hits(uid, d):
        g, err = report(uid, str(d.get("gid", "")), d.get("hits") or [], bool(d.get("end")))
        return {"ok": err is None, "error": err, "game": g}

    @route("/api/fruit/tick")
    def r_tick(uid, d):
        g = load_game(str(d.get("gid", "")))
        if not g or uid not in g["uids"]: return {"ok": False, "error": "game not found"}
        return {"ok": True, "game": tick(g["id"])}

    @route("/api/fruit/leave")
    def r_leave(uid, d): return {"ok": True, "game": leave(uid, str(d.get("gid", "")))}

    @route("/api/fruit/game")
    def r_game(uid, d):
        g = load_game(str(d.get("gid", "")))
        if not g or uid not in g["uids"]: return {"ok": False, "error": "game not found"}
        return {"ok": True, "game": public_game(g)}

    @app.get("/api/fruit/admin/overview")
    @security.login_required
    def fruit_a_overview():
        db = fb.get_db(); tot = db.collection("fruit_totals").document("all").get().to_dict() or {}
        games = []
        for s in db.collection("fruit_games").order_by("createdAt", direction="DESCENDING").limit(40).stream():
            g = s.to_dict(); games.append({"id": s.id, "t": g.get("createdAt"), "stake": g.get("stake"), "status": g.get("status"), "winner": g.get("winner"), "reason": g.get("reason"),
                                         "prize": g.get("prize"), "scores": g.get("scores"), "players": [{"name": p.get("name")} for p in g.get("players", [])]})
        hn = (tot.get("entries", 0) or 0) - (tot.get("payouts", 0) or 0)
        return jsonify(ok=True, cfg=cfg(True), totals={**{k: tot.get(k, 0) for k in ("games", "entries", "payouts")}, "houseNet": round(hn, 2)}, games=games,
                       live=sum(1 for g in GAMES.values() if g["status"] == "playing"), queue=sum(len(v) for v in QUEUE.values()))

    @app.post("/api/fruit/admin/config")
    @security.login_required
    def fruit_a_config(): return jsonify(ok=True, cfg=save_cfg(request.get_json(silent=True) or {}))
    return app


def restore():
    n = 0
    for s in fb.get_db().collection("fruit_games").where("status", "==", "playing").limit(200).stream():
        g = s.to_dict(); g["id"] = s.id; g.setdefault("hit", [[], []]); GAMES[s.id] = g; n += 1
    return n


def janitor():
    now = NOW()
    for gid in [k for k, g in list(GAMES.items()) if g.get("status") == "playing" and now > g["startAt"] + g["dur"] * 1000 + GRACE_MS + 1500]:
        try: tick(gid)
        except Exception as e: print("[fruit] janitor", gid, e, flush=True)
    with LOCK:
        for k in [k for k, t in TICKETS.items() if time.time() - t["ts"] > 180]: TICKETS.pop(k, None)
        for k, v in list(QUEUE.items()): QUEUE[k] = [t for t in v if time.time() - t["ts"] < 180]


def purge_old(days=14):
    db = fb.get_db(); cutoff = NOW() - days * 86400000; n = 0
    for s in db.collection("fruit_games").where("createdAt", "<", cutoff).limit(300).stream(): s.reference.delete(); n += 1
    for gid in [k for k, g in GAMES.items() if g.get("status") == "done" and NOW() - (g.get("finishedAt") or 0) > 3600000]: GAMES.pop(gid, None); GLOCKS.pop(gid, None); _lastw.pop(gid, None)
    return n
