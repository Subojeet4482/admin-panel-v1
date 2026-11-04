"""COIN BATTLE — server-authoritative 6x6 "connect four" for the user app (service 1 / Main panel).

Why on the server: the game pays real wallet money. All rules (turns, wins, timers, payouts) run HERE with the Admin SDK;
the phone only displays the board (it listens to ball_games/{gid}) and sends "drop in column N".

Money:  entry ₹2/5/10 (configurable) is taken from the wallet when a game starts (deposit balance first, then winnings).
        winner gets 2 x entry minus the platform cut (default 10% -> 1.8 x entry) credited to winnings balance.
        draw -> both refunded.  Practice games (free, N per day) move no money.
Bots:   when no real player is found after `botAfterFails` searches a BOT joins. Bots are ALWAYS labelled "BOT" in the app
        (name tag + badge) — nobody is led to think they play a human. Strength is fair & configurable (search depth); the bot
        sees exactly what a human sees (the board) and has no hidden advantage.
Firestore:  config/ball (settings) · ball_games/{gid} · ball_stats/{uid} · ball_totals/all · users/{uid} (+transactions) · lb/{d|w|m}-key
"""
import os, time, random, threading, uuid
import datetime as dt
from flask import request, jsonify, Response
from firebase_admin import firestore as fs

import fb, security

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
W = H = 6                      # board size
LINE = 4                       # balls in a row to win
NOW = lambda: int(time.time() * 1000)

DEFAULT_CFG = {"enabled": True, "entries": [2, 5, 10], "cutPct": 10, "practicePerDay": 3, "botsEnabled": True, "botAfterFails": 2,
               "searchSec": 12, "turnSec": 15, "maxAuto": 3, "botDepth": 7, "botMs": 700, "maxStake": 100}

BOT_NAMES = ["Arjun", "Rohit", "Vikram", "Karan", "Aman", "Neha", "Priya", "Sneha", "Ravi", "Dev", "Isha", "Rahul", "Zoya", "Kabir", "Meera", "Ayaan", "Tanya", "Yash", "Riya", "Sahil"]
BOT_AVATARS = 5                # assets/img/game/bots/b1..b5.webp  (separate list from player avatars)

# ==================================================================== engine
def lines():
    L = []
    for r in range(H):
        for c in range(W):
            for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
                er, ec = r + dr * (LINE - 1), c + dc * (LINE - 1)
                if 0 <= er < H and 0 <= ec < W: L.append(tuple((r + dr * i) * W + (c + dc * i) for i in range(LINE)))
    return L
LINES = lines()
CELL_LINES = [[] for _ in range(W * H)]
for _i, _l in enumerate(LINES):
    for _c in _l: CELL_LINES[_c].append(_i)
CENTER = [3 - abs(c - (W - 1) / 2) for c in range(W)]
ORDER = sorted(range(W), key=lambda c: -CENTER[c])


def new_board(): return [0] * (W * H)
def drop_row(b, col):
    if not (0 <= col < W): return None
    for r in range(H - 1, -1, -1):
        if b[r * W + col] == 0: return r
    return None
def valid_cols(b): return [c for c in range(W) if b[c] == 0]
def win_cells(b, p, last=None):
    """cells of a winning line for player p (1/2) or None. If `last` (cell idx) is given only lines through it are checked."""
    idxs = CELL_LINES[last] if last is not None else range(len(LINES))
    for i in idxs:
        l = LINES[i]
        if b[l[0]] == p and b[l[1]] == p and b[l[2]] == p and b[l[3]] == p: return list(l)
    return None


# ==================================================================== bot (alpha-beta, iterative deepening, time-boxed)
class Timeout(Exception): pass

def _eval(b, me):
    opp = 3 - me; s = 0
    for l in LINES:
        m = o = 0
        for i in l:
            v = b[i]
            if v == me: m += 1
            elif v == opp: o += 1
        if m and o: continue
        if m == 3: s += 60
        elif m == 2: s += 9
        elif m == 1: s += 1
        elif o == 3: s -= 70
        elif o == 2: s -= 10
        elif o == 1: s -= 1
    for r in range(H):
        for c in range(W):
            v = b[r * W + c]
            if v == me: s += CENTER[c]
            elif v == opp: s -= CENTER[c]
    return s

class Searcher:
    def __init__(self, me, deadline):
        self.me, self.deadline, self.nodes, self.tt = me, deadline, 0, {}
    def negamax(self, b, player, depth, alpha, beta, last):
        self.nodes += 1
        if self.nodes & 511 == 0 and time.time() > self.deadline: raise Timeout()
        opp = 3 - player
        if last is not None and win_cells(b, opp, last): return -100000 - depth
        cols = [c for c in ORDER if b[c] == 0]
        if not cols: return 0
        if depth == 0: return _eval(b, player)
        key = (tuple(b), player)
        hit = self.tt.get(key)
        if hit and hit[0] >= depth: return hit[1]
        best = -10 ** 9
        for c in cols:
            r = drop_row(b, c); i = r * W + c; b[i] = player
            v = -self.negamax(b, opp, depth - 1, -beta, -alpha, i)
            b[i] = 0
            if v > best: best = v
            if best > alpha: alpha = best
            if alpha >= beta: break
        self.tt[key] = (depth, best)
        return best

def bot_move(board, me, depth=7, ms=700):
    """Best column for `me` (1/2). Immediate win > block > deep search (time-boxed). No cheating: only sees the board."""
    cols = valid_cols(board)
    if not cols: return None
    b = list(board); opp = 3 - me
    for p in (me, opp):                                   # win now, else block now
        for c in ORDER:
            if b[c] == 0:
                r = drop_row(b, c); i = r * W + c; b[i] = p; w = win_cells(b, p, i); b[i] = 0
                if w: return c
    deadline = time.time() + max(80, ms) / 1000.0
    best, bestv = None, None
    safe = []
    for c in ORDER:                                       # avoid moves that hand the opponent an instant win
        if b[c] != 0: continue
        r = drop_row(b, c); i = r * W + c; b[i] = me
        bad = False
        r2 = drop_row(b, c)
        if r2 is not None:
            j = r2 * W + c; b[j] = opp; bad = bool(win_cells(b, opp, j)); b[j] = 0
        b[i] = 0
        if not bad: safe.append(c)
    cand = safe or cols
    for d in range(2, max(2, int(depth)) + 1):
        s = Searcher(me, deadline); results = {}
        try:
            alpha = -10 ** 9
            for c in cand:
                r = drop_row(b, c); i = r * W + c; b[i] = me
                v = -s.negamax(b, opp, d - 1, -10 ** 9, -alpha, i)
                b[i] = 0; results[c] = v
                if v > alpha: alpha = v
        except Timeout:
            break
        if results:
            bestv = max(results.values()); top = [c for c, v in results.items() if v >= bestv - 1]
            best = random.choice(top) if len(top) > 1 and d >= 3 else max(results, key=results.get)
            cand = sorted(results, key=lambda c: -results[c]) or cand
        if bestv is not None and bestv > 90000: break
    return best if best is not None else cand[0]


# ==================================================================== config / state
_cfg = {"t": 0, "v": dict(DEFAULT_CFG)}
LOCK = threading.RLock()
QUEUE = {}          # key -> list of tickets
TICKETS = {}        # ticket -> dict
FAILS = {}          # uid -> {"n": consecutive failed searches, "t": last}
GAMES = {}          # gid -> game dict (cache; Firestore is the truth)
GLOCKS = {}         # gid -> RLock

def cfg(force=False):
    if force or time.time() - _cfg["t"] > 20:
        try:
            d = fb.get_db().collection("config").document("ball").get()
            v = dict(DEFAULT_CFG); v.update((d.to_dict() or {}) if d.exists else {}); _cfg["v"] = v
        except Exception: pass
        _cfg["t"] = time.time()
    return _cfg["v"]

def save_cfg(patch):
    v = dict(DEFAULT_CFG); v.update(cfg(True))
    ent = patch.get("entries")
    if ent is not None: v["entries"] = sorted({int(x) for x in ent if 1 <= int(x) <= int(v.get("maxStake", 100))})[:6] or [2, 5, 10]
    for k, lo, hi in (("cutPct", 0, 50), ("practicePerDay", 0, 50), ("botAfterFails", 1, 5), ("searchSec", 4, 40), ("turnSec", 6, 60), ("maxAuto", 0, 10), ("botDepth", 2, 9), ("botMs", 80, 2500), ("maxStake", 1, 1000)):
        if k in patch: v[k] = max(lo, min(hi, int(patch[k])))
    for k in ("enabled", "botsEnabled"):
        if k in patch: v[k] = bool(patch[k])
    fb.get_db().collection("config").document("ball").set(v)
    _cfg.update(t=time.time(), v=v); return v

def public_cfg():
    c = cfg(); return {k: c[k] for k in ("enabled", "entries", "cutPct", "practicePerDay", "botsEnabled", "searchSec", "turnSec", "maxAuto", "botAfterFails")}

def today():  return dt.datetime.now(IST).strftime("%Y%m%d")
def glock(gid):
    with LOCK: return GLOCKS.setdefault(gid, threading.RLock())


# ==================================================================== wallet (Admin SDK, transactional)
def _tx(fn):
    db = fb.get_db(); t = db.transaction()
    @fs.transactional
    def run(tx): return fn(tx, db)
    return run(t)

def _bal(u): return float(u.get("depositBalance", u.get("balance", 0)) or 0), float(u.get("withdrawBalance", 0) or 0)

def _trx(db, tx, uid, title, amount, kind):
    ref = db.collection("users").document(uid).collection("transactions").document()
    tx.set(ref, {"title": title, "amount": amount, "type": "game", "kind": kind, "status": "success", "date": dt.datetime.now(IST).strftime("%d/%m/%Y"),
                 "timestamp": fs.SERVER_TIMESTAMP, "createdAt": NOW()})

def debit(uid, amt, title):
    """take `amt` (deposit balance first, then winnings). Returns False if the wallet is too low."""
    def run(tx, db):
        ref = db.collection("users").document(uid); s = ref.get(transaction=tx)
        if not s.exists: return False
        u = s.to_dict() or {}
        if u.get("banned") or u.get("blocked"): return False
        dep, wd = _bal(u)
        if dep + wd + 1e-9 < amt: return False
        fromDep = min(dep, amt); fromWd = round(amt - fromDep, 2)
        tx.update(ref, {"depositBalance": round(dep - fromDep, 2), "withdrawBalance": round(wd - fromWd, 2)})
        _trx(db, tx, uid, title, f"-₹{amt:g}", "game_entry")
        return True
    return _tx(run)

def credit(uid, amt, title, kind):
    def run(tx, db):
        ref = db.collection("users").document(uid); s = ref.get(transaction=tx)
        if not s.exists: return False
        u = s.to_dict() or {}; dep, wd = _bal(u)
        up = {"withdrawBalance": round(wd + amt, 2)} if kind == "game_win" else {"depositBalance": round(dep + amt, 2)}
        if kind == "game_win": up["totalEarned"] = round(float(u.get("totalEarned", 0) or 0) + amt, 2)
        tx.update(ref, up); _trx(db, tx, uid, title, f"+₹{amt:g}", kind); return True
    return _tx(run)

def lb_add(uid, name, photo, amt):
    db = fb.get_db(); n = dt.datetime.now(IST)
    mon = n - dt.timedelta(days=n.weekday())
    for key in ("d-" + n.strftime("%Y%m%d"), "w-" + mon.strftime("%Y%m%d"), "m-" + n.strftime("%Y%m")):
        pl = {"n": name or "Player", "a": fs.Increment(amt), "g": fs.Increment(amt)}
        if photo: pl["p"] = photo
        db.collection("lb").document(key).set({"players": {uid: pl}, "updatedAt": NOW()}, merge=True)

def stat_add(uid, **inc):
    try:
        db = fb.get_db(); ref = db.collection("ball_stats").document(uid)
        ref.set({k: fs.Increment(v) for k, v in inc.items()}, merge=True)
    except Exception as e: print("[ball] stats:", e, flush=True)


# ==================================================================== games
def player_info(uid):
    db = fb.get_db(); u = (db.collection("users").document(uid).get().to_dict() or {})
    return {"uid": uid, "name": (u.get("appName") or u.get("name") or "Player")[:20], "photo": u.get("photoUrl") or "", "bot": False}

def bot_info():
    return {"uid": "bot:" + uuid.uuid4().hex[:8], "name": random.choice(BOT_NAMES), "photo": "", "avatar": random.randint(1, BOT_AVATARS), "bot": True}

def public_game(g):
    keep = ("id", "uids", "players", "stake", "practice", "board", "turn", "status", "winner", "reason", "moves", "deadline", "auto", "createdAt", "finishedAt", "prize", "cutPct", "turnSec", "winCells", "settled")
    return {k: g.get(k) for k in keep}

def load_game(gid):
    g = GAMES.get(gid)
    if g: return g
    s = fb.get_db().collection("ball_games").document(gid).get()
    if not s.exists: return None
    g = s.to_dict(); g["id"] = gid; GAMES[gid] = g; return g

def save_game(g):
    GAMES[g["id"]] = g
    d = {k: v for k, v in g.items() if k != "id"}
    fb.get_db().collection("ball_games").document(g["id"]).set(d)

def active_game_of(uid):
    with LOCK:
        for g in GAMES.values():
            if g["status"] == "playing" and uid in g["uids"]: return g
    return None

def create_game(p0, p1, stake, practice):
    """p0/p1 player dicts. Takes the entry fee from every human first; refunds if the 2nd debit fails."""
    c = cfg(); gid = uuid.uuid4().hex[:14]; taken = []
    if not practice:
        for p in (p0, p1):
            if p["bot"]: continue
            if not debit(p["uid"], stake, "Coin Battle entry"):
                for q in taken: credit(q, stake, "Coin Battle refund", "game_refund")
                return None, p["uid"]
            taken.append(p["uid"])
    first = random.choice((0, 1))
    g = {"id": gid, "uids": [p0["uid"], p1["uid"]], "players": [p0, p1], "stake": stake, "practice": practice, "board": new_board(), "turn": first, "status": "playing",
         "winner": -1, "reason": "", "moves": [], "auto": [0, 0], "createdAt": NOW(), "cutPct": c["cutPct"], "turnSec": c["turnSec"], "winCells": [], "settled": False,
         "deadline": NOW() + c["turnSec"] * 1000 + 1500}
    save_game(g)
    for p in (p0, p1):
        if not p["bot"]: stat_add(p["uid"], games=1)
    if p0["bot"] or p1["bot"]: _bot_turns(g)
    return g, None

def _prize(g): return round(g["stake"] * 2 * (100 - g["cutPct"]) / 100.0, 2)

def finish(g, winner, reason):
    """winner: 0/1 or -1 draw. Idempotent — pays out exactly once."""
    with glock(g["id"]):
        if g["status"] == "done": return g
        g.update(status="done", winner=winner, reason=reason, finishedAt=NOW(), settled=False)
        humans = [i for i, p in enumerate(g["players"]) if not p["bot"]]
        stake, practice = g["stake"], g["practice"]
        prize = _prize(g) if not practice else 0
        g["prize"] = prize
        try:
            if not practice:
                if winner == -1:
                    for i in humans: credit(g["uids"][i], stake, "Coin Battle — draw refund", "game_refund")
                elif winner in humans:
                    p = g["players"][winner]
                    credit(p["uid"], prize, "Coin Battle — You won", "game_win"); lb_add(p["uid"], p["name"], p["photo"], prize)
                    stat_add(p["uid"], wins=1, won=prize)
                for i in humans:
                    if winner not in (i, -1): stat_add(g["uids"][i], losses=1, lost=stake)
                tot = {"games": 1, "entries": stake * len(humans), "botGames": 1 if len(humans) == 1 else 0}
                tot["payouts"] = prize if winner in humans else 0
                tot["refunds"] = stake * len(humans) if winner == -1 else 0
                fb.get_db().collection("ball_totals").document("all").set({k: fs.Increment(v) for k, v in tot.items()}, merge=True)
            else:
                for i in humans: stat_add(g["uids"][i], practiceGames=1)
            g["settled"] = True
        except Exception as e:
            print("[ball] SETTLE ERROR", g["id"], e, flush=True); g["settleError"] = str(e)[:200]
        save_game(g); return g

def apply_move(g, pi, col, delay=0):
    """apply a drop for player index pi. returns error string or None."""
    b = g["board"]; r = drop_row(b, col)
    if r is None: return "column full"
    i = r * W + col; b[i] = pi + 1
    g["moves"].append({"p": pi, "c": col, "r": r, "d": int(delay)})
    w = win_cells(b, pi + 1, i)
    if w: g["winCells"] = w; finish(g, pi, "connect4"); return None
    if all(b): finish(g, -1, "draw"); return None
    g["turn"] = 1 - pi; g["deadline"] = NOW() + int(delay) + g["turnSec"] * 1000 + 600
    return None

def _bot_turns(g):
    """if it is a bot's turn, play it now (the move carries a 'think' delay so the phone animates it naturally)."""
    c = cfg(); guard = 0
    while g["status"] == "playing" and g["players"][g["turn"]]["bot"] and guard < 3:
        guard += 1; pi = g["turn"]
        col = bot_move(g["board"], pi + 1, c["botDepth"], c["botMs"])
        apply_move(g, pi, col if col is not None else random.choice(valid_cols(g["board"])), delay=random.randint(650, 1500))
    if g["status"] == "playing": save_game(g)

def human_move(uid, gid, col):
    with glock(gid):
        g = load_game(gid)
        if not g: return None, "game not found"
        if uid not in g["uids"]: return None, "not your game"
        if g["status"] != "playing": return public_game(g), None
        pi = g["uids"].index(uid)
        if g["turn"] != pi: return public_game(g), "not your turn"
        err = apply_move(g, pi, int(col))
        if err: return public_game(g), err
        g["auto"][pi] = g["auto"][pi]                     # a real move keeps the AFK counter (only resets on 3 clean moves? keep simple)
        if g["status"] == "playing": _bot_turns(g)
        save_game(g); return public_game(g), None

def tick(gid):
    """anyone in the game may call: handles a missed turn (auto-move; too many misses = forfeit)."""
    with glock(gid):
        g = load_game(gid)
        if not g or g["status"] != "playing": return public_game(g) if g else None
        if NOW() <= g["deadline"]: return public_game(g)
        pi = g["turn"]
        if g["players"][pi]["bot"]: _bot_turns(g); return public_game(g)
        g["auto"][pi] += 1
        if g["auto"][pi] > cfg()["maxAuto"]: finish(g, 1 - pi, "afk"); return public_game(g)
        cols = valid_cols(g["board"]); col = bot_move(g["board"], pi + 1, 3, 150) or random.choice(cols)
        apply_move(g, pi, col)
        if g["status"] == "playing": _bot_turns(g)
        save_game(g); return public_game(g)

def leave(uid, gid):
    with glock(gid):
        g = load_game(gid)
        if not g or uid not in g["uids"] or g["status"] != "playing": return public_game(g) if g else None
        pi = g["uids"].index(uid); finish(g, 1 - pi, "forfeit"); return public_game(g)


# ==================================================================== matchmaking
def _key(practice, stake): return "p" if practice else f"s{stake}"

def find(uid, entry, practice):
    c = cfg()
    if not c["enabled"]: return {"error": "Coin Battle is switched off right now"}
    if practice:
        st = fb.get_db().collection("ball_stats").document(uid).get().to_dict() or {}
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
            if t["uid"] != uid and time.time() - t["ts"] < c["searchSec"] + 4:
                opp = t["player"]
                g, bad = create_game(opp, me, entry, practice)
                QUEUE[key].remove(t)
                if g is None:
                    if bad == me["uid"]: return {"error": "Not enough balance — add money first"}
                    t["status"] = "cancelled"; continue
                t.update(status="matched", gid=g["id"]); FAILS.pop(uid, None); FAILS.pop(opp["uid"], None)
                if practice:
                    _practice_used(uid); _practice_used(opp["uid"])
                return {"status": "matched", "gid": g["id"]}
        tk = uuid.uuid4().hex[:12]
        t = {"id": tk, "uid": uid, "key": key, "entry": entry, "practice": practice, "player": me, "ts": time.time(), "status": "waiting", "gid": None}
        TICKETS[tk] = t; QUEUE.setdefault(key, []).append(t)
        attempt = FAILS.get(uid, {}).get("n", 0) + 1
        return {"status": "waiting", "ticket": tk, "searchSec": c["searchSec"], "attempt": attempt, "botAfter": c["botAfterFails"]}

def _practice_used(uid):
    ref = fb.get_db().collection("ball_stats").document(uid); s = ref.get().to_dict() or {}
    n = (int(s.get("practiceUsed", 0) or 0) + 1) if s.get("practiceDay") == today() else 1
    ref.set({"practiceDay": today(), "practiceUsed": n}, merge=True)

def _drop_ticket(t):
    t["status"] = "cancelled"
    try: QUEUE.get(t["key"], []).remove(t)
    except ValueError: pass

def poll(uid, tk):
    c = cfg()
    with LOCK:
        t = TICKETS.get(tk)
        if not t or t["uid"] != uid: return {"status": "none"}
        if t["status"] == "matched": return {"status": "matched", "gid": t["gid"]}
        if t["status"] != "waiting": return {"status": "cancelled"}
        if time.time() - t["ts"] < c["searchSec"]: return {"status": "waiting", "left": int(c["searchSec"] - (time.time() - t["ts"]))}
        _drop_ticket(t)
        f = FAILS.setdefault(uid, {"n": 0, "t": 0})
        if time.time() - f["t"] > 900: f["n"] = 0
        f["n"] += 1; f["t"] = time.time()
        if c["botsEnabled"] and f["n"] >= c["botAfterFails"]:
            g, bad = create_game(t["player"], bot_info(), t["entry"], t["practice"])
            if g is None: return {"status": "error", "error": "Not enough balance — add money first"}
            f["n"] = 0
            if t["practice"]: _practice_used(uid)
            return {"status": "matched", "gid": g["id"], "bot": True}
        return {"status": "nomatch", "fails": f["n"], "botAfter": c["botAfterFails"]}


# ==================================================================== HTTP
def _cors(resp):
    origin = os.environ.get("CHAT_CORS_ORIGIN", "*")
    resp.headers["Access-Control-Allow-Origin"] = origin; resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"; resp.headers["Vary"] = "Origin"; return resp

def _out(d, code=200): return _cors(Response(jsonify(d).get_data(), status=code, mimetype="application/json"))

_RATE = {}
def _rate(uid, per=40):
    now = time.time(); w = [t for t in _RATE.get(uid, []) if now - t < 10]
    if len(w) >= per: return False
    w.append(now); _RATE[uid] = w; return True

def register(app):
    def uid_of():
        tok = (request.headers.get("Authorization") or "").replace("Bearer ", "").strip()
        info = fb.verify_main_token(tok); return info["uid"]

    def guarded(fn):
        def w(*a, **k):
            if request.method == "OPTIONS": return _cors(Response(status=204))
            try: uid = uid_of()
            except Exception as e: return _out({"ok": False, "error": "Please log in again", "code": "auth"}, 401)
            if not _rate(uid): return _out({"ok": False, "error": "Too many requests — slow down"}, 429)
            try:
                res = fn(uid, request.get_json(silent=True) or {}); res["now"] = NOW(); return _out(res)
            except Exception as e:
                print("[ball] error", fn.__name__, repr(e), flush=True); return _out({"ok": False, "error": "Game server error — try again"}, 500)
        w.__name__ = "ball_" + fn.__name__; return w

    def route(path, methods=("POST", "OPTIONS")):
        def deco(fn): app.add_url_rule(path, view_func=guarded(fn), methods=list(methods)); return fn
        return deco

    @route("/api/ball/config", ("GET", "POST", "OPTIONS"))
    def r_config(uid, d):
        st = fb.get_db().collection("ball_stats").document(uid).get().to_dict() or {}
        used = int(st.get("practiceUsed", 0) or 0) if st.get("practiceDay") == today() else 0
        ag = active_game_of(uid)
        return {"ok": True, "cfg": public_cfg(), "practiceLeft": max(0, cfg()["practicePerDay"] - used), "active": ag["id"] if ag else None,
                "stats": {k: st.get(k, 0) for k in ("games", "wins", "losses", "won", "lost")}}

    @route("/api/ball/find")
    def r_find(uid, d):
        r = find(uid, d.get("entry"), bool(d.get("practice"))); r["ok"] = "error" not in r; return r

    @route("/api/ball/poll")
    def r_poll(uid, d):
        r = poll(uid, str(d.get("ticket", ""))); r["ok"] = r.get("status") != "error"; return r

    @route("/api/ball/cancel")
    def r_cancel(uid, d):
        with LOCK:
            t = TICKETS.get(str(d.get("ticket", "")))
            if t and t["uid"] == uid and t["status"] == "waiting": _drop_ticket(t)
        return {"ok": True}

    @route("/api/ball/move")
    def r_move(uid, d):
        g, err = human_move(uid, str(d.get("gid", "")), d.get("col", -1))
        return {"ok": err is None, "error": err, "game": g}

    @route("/api/ball/tick")
    def r_tick(uid, d):
        g = load_game(str(d.get("gid", "")))
        if not g or uid not in g["uids"]: return {"ok": False, "error": "game not found"}
        return {"ok": True, "game": tick(g["id"])}

    @route("/api/ball/leave")
    def r_leave(uid, d): return {"ok": True, "game": leave(uid, str(d.get("gid", "")))}

    @route("/api/ball/game")
    def r_game(uid, d):
        g = load_game(str(d.get("gid", "")))
        if not g or uid not in g["uids"]: return {"ok": False, "error": "game not found"}
        return {"ok": True, "game": public_game(g)}

    # ---------------- admin (owner session, same login as the panel) ----------------
    @app.get("/api/ball/admin/overview")
    @security.login_required
    def a_overview():
        db = fb.get_db(); tot = db.collection("ball_totals").document("all").get().to_dict() or {}
        games = []
        for s in db.collection("ball_games").order_by("createdAt", direction="DESCENDING").limit(40).stream():
            g = s.to_dict(); games.append({"id": s.id, "t": g.get("createdAt"), "stake": g.get("stake"), "practice": g.get("practice"), "status": g.get("status"), "winner": g.get("winner"), "reason": g.get("reason"),
                                         "prize": g.get("prize"), "players": [{"name": p.get("name"), "bot": p.get("bot")} for p in g.get("players", [])], "moves": len(g.get("moves", []))})
        hn = (tot.get("entries", 0) or 0) - (tot.get("payouts", 0) or 0) - (tot.get("refunds", 0) or 0)
        return jsonify(ok=True, cfg=cfg(True), totals={**{k: tot.get(k, 0) for k in ("games", "botGames", "entries", "payouts", "refunds")}, "houseNet": round(hn, 2)}, games=games, live=sum(1 for g in GAMES.values() if g["status"] == "playing"), queue=sum(len(v) for v in QUEUE.values()))

    @app.post("/api/ball/admin/config")
    @security.login_required
    def a_config():
        return jsonify(ok=True, cfg=save_cfg(request.get_json(silent=True) or {}))

    # cleanup of old finished games (called by jobs)
    return app

def restore():
    """after a restart: reload games that were still being played (money is already taken — they must finish & settle)."""
    n = 0
    for s in fb.get_db().collection("ball_games").where("status", "==", "playing").limit(200).stream():
        g = s.to_dict(); g["id"] = s.id; GAMES[s.id] = g; n += 1
    return n

def janitor():
    """settle games nobody is looking at (phone closed / lost signal): missed turns auto-play, then forfeit -> payout happens anyway."""
    now = NOW()
    for gid in [k for k, g in list(GAMES.items()) if g.get("status") == "playing" and now > g.get("deadline", 0) + 2500]:
        try: tick(gid)
        except Exception as e: print("[ball] janitor", gid, e, flush=True)
    with LOCK:
        for k in [k for k, t in TICKETS.items() if time.time() - t["ts"] > 180]: TICKETS.pop(k, None)
        for k, v in list(QUEUE.items()): QUEUE[k] = [t for t in v if time.time() - t["ts"] < 180]

def purge_old(days=14):
    db = fb.get_db(); cutoff = NOW() - days * 86400000; n = 0
    for s in db.collection("ball_games").where("createdAt", "<", cutoff).limit(300).stream():
        s.reference.delete(); n += 1
    for gid in [k for k, g in GAMES.items() if g.get("status") == "done" and NOW() - (g.get("finishedAt") or 0) > 3600000]: GAMES.pop(gid, None); GLOCKS.pop(gid, None)
    return n
