"""Service 1 background job: month-end leaderboard reward."""
import time, threading, datetime as dt
import fb, keepalive

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def _order(trx_id, now):
    return f"PZ-{now:%Y%m%d}-{trx_id[-6:].upper()}"


def monthly_reward():
    """1st of the month (after 12:00 AM IST): pay last month's top winners (rewards from config/leaderboard). Runs once per month."""
    from google.cloud import firestore
    now = dt.datetime.now(IST)
    prev = (now.replace(day=1) - dt.timedelta(days=1))
    mk = prev.strftime("%Y%m")
    db = fb.get_db()
    cfg = (db.collection("config").document("leaderboard").get().to_dict() or {})
    rewards = [float(r.get("amount") or 0) for r in (cfg.get("rewards") or [])]
    rewards = [r for r in rewards if r > 0]
    if not rewards or cfg.get("rewardEnabled") is False: return
    marker = db.collection("lb_rewards").document(mk)
    if marker.get().exists: return
    try:
        marker.create({"month": mk, "startedAt": int(time.time() * 1000)})          # create() = sirf ek baar (race safe)
    except Exception:
        return
    players = ((db.collection("lb").document("m-" + mk).get().to_dict() or {}).get("players") or {})
    hidden = set(cfg.get("hidden") or [])          # accounts the admin hid from the leaderboard (tests / admins)
    rank = sorted([(uid, p) for uid, p in players.items() if float(p.get("a") or 0) > 0 and uid not in hidden], key=lambda x: -float(x[1].get("a") or 0))[:len(rewards)]
    paid = []
    for i, (uid, p) in enumerate(rank):
        amt = rewards[i]; uref = db.collection("users").document(uid)
        if not uref.get().exists: continue
        tref = uref.collection("transactions").document()
        order = _order(tref.id, now)
        label = prev.strftime("%B %Y")
        b = db.batch()
        b.set(uref, {"withdrawBalance": firestore.Increment(amt), "totalEarned": firestore.Increment(amt)}, merge=True)
        b.set(tref, {"title": f"Monthly Leaderboard Rank #{i+1}", "amount": f"+₹{amt:g}", "type": "deposit", "status": "success", "kind": "prize",
                     "orderNo": order, "balanceType": "withdraw", "date": now.strftime("%d/%m/%Y"), "createdAt": int(time.time() * 1000)})
        b.set(uref.collection("notifications").document(), {"title": f"🏆 Monthly Rank #{i+1} Reward — ₹{amt:g}",
              "message": f"Congratulations! You finished #{i+1} on the {label} leaderboard (₹{float(p.get('a')):g} winnings). ₹{amt:g} was added to your withdrawal balance. Order {order}.",
              "date": now.strftime("%d %b %Y"), "timestamp": firestore.SERVER_TIMESTAMP, "type": "reward"})
        b.commit(); paid.append({"uid": uid, "rank": i + 1, "amount": amt})
    marker.set({"paid": paid, "doneAt": int(time.time() * 1000)}, merge=True)
    print("[reward] monthly paid:", paid, flush=True)


def _loop():
    """Service 1: sirf month-end leaderboard reward (halka — 15 min mein ek check)."""
    time.sleep(150)
    while True:
        try: monthly_reward()
        except Exception as e: print("[jobs] reward:", e, flush=True)
        time.sleep(900)


def _ball_loop():
    """Coin Battle housekeeping: resume games after a restart, settle abandoned games, drop old finished games."""
    import ballgame, bombgame, referral
    time.sleep(20)
    try: print(f"[ball] restored {ballgame.restore()} running game(s)", flush=True)
    except Exception as e: print("[ball] restore:", e, flush=True)
    try: print(f"[bomb] restored {bombgame.restore()} running game(s)", flush=True)
    except Exception as e: print("[bomb] restore:", e, flush=True)
    last_purge = 0; last_ref = 0
    while True:
        try: ballgame.janitor()
        except Exception as e: print("[ball] janitor:", e, flush=True)
        try: bombgame.janitor()
        except Exception as e: print("[bomb] janitor:", e, flush=True)
        if time.time() - last_ref > 120:      # friend deposited enough? -> referral qualifies -> scratch card issued
            last_ref = time.time()
            try: referral.qualify_pending()
            except Exception as e: print("[ref] qualify:", e, flush=True)
        if time.time() - last_purge > 21600:
            last_purge = time.time()
            try: ballgame.purge_old(14)
            except Exception as e: print("[ball] purge:", e, flush=True)
            try: bombgame.purge_old(14)
            except Exception as e: print("[bomb] purge:", e, flush=True)
        time.sleep(15)


def start():
    keepalive.supervised("ff-jobs", _loop)
    keepalive.supervised("ff-ball", _ball_loop)
