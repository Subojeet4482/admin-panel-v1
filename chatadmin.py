"""Admin ke liye Chat Manager — chat database (alag project ya main) ko Admin SDK se padhta/badalta hai.
Collections (c* prefix): cprofiles, cusernames, cfriends, cblocks, crequests, cchats(/msgs), cgroups(/msgs), cworld, creports, cconfig"""
import time, datetime as dt
import fb, slow

WORLD_DEFAULT = {"name": "Booyah Lounge", "emoji": "🔥", "tagline": "Meet players, flex wins, find your squad", "slow": 0, "locked": False, "ttlHours": 24}


def C():
    return fb.get_chat_db()


def clean(v):
    if isinstance(v, dt.datetime):
        if v.tzinfo is None: v = v.replace(tzinfo=dt.timezone.utc)
        return int(v.timestamp() * 1000)
    if isinstance(v, dict): return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)): return [clean(x) for x in v]
    return v


def _d(s):
    d = clean(s.to_dict() or {}); d["id"] = s.id; return d


def _count(q):
    try:
        return int(q.count().get()[0][0].value)
    except Exception:
        return sum(1 for _ in q.stream())


def overview():
    c = C()
    return {"separate": fb.chat_separate(), "profiles": _count(c.collection("cprofiles")), "banned": _count(c.collection("cprofiles").where("banned", "==", True)),
            "private": _count(c.collection("cprofiles").where("isPrivate", "==", True)),
            "pending_requests": _count(c.collection("crequests").where("status", "==", "pending")),
            "chats": _count(c.collection("cchats")), "groups": _count(c.collection("cgroups")), "world": _count(c.collection("cworld")),
            "reports_open": _count(c.collection("creports").where("status", "==", "open")), "reports": _count(c.collection("creports")),
            "world_cfg": world_cfg()}


def world_cfg():
    s = C().collection("cconfig").document("world").get()
    return {**WORLD_DEFAULT, **(clean(s.to_dict() or {}) if s.exists else {})}


def save_world_cfg(d):
    cur = {"name": str(d.get("name") or WORLD_DEFAULT["name"])[:30], "emoji": str(d.get("emoji") or "🔥")[:4], "tagline": str(d.get("tagline") or "")[:80],
           "slow": max(0, min(120, int(d.get("slow") or 0))), "locked": bool(d.get("locked")),
           "ttlHours": max(1, min(168, int(d.get("ttlHours") or 24)))}
    C().collection("cconfig").document("world").set(cur, merge=True); return cur


def users(q="", limit=40):
    c = C(); q = (q or "").strip().lower(); out = []
    if not q:
        for s in c.collection("cprofiles").order_by("createdAt", direction="DESCENDING").limit(limit).stream(): out.append(_d(s))
        return out
    seen = set()
    for s in c.collection("cprofiles").where("username", ">=", q).where("username", "<=", q + "\uf8ff").limit(limit).stream():
        seen.add(s.id); out.append(_d(s))
    if len(out) < limit:
        for s in slow.paced(c.collection("cprofiles").limit(1500).stream(), 100, 0.3):
            if s.id in seen: continue
            d = s.to_dict() or {}
            if q in str(d.get("name", "")).lower() or q == s.id.lower() or q in str(d.get("username", "")).lower():
                out.append(_d(s)); seen.add(s.id)
                if len(out) >= limit: break
    return out


def _name(uid, cache):
    if uid not in cache:
        s = C().collection("cprofiles").document(uid).get(); d = s.to_dict() or {}
        cache[uid] = {"uid": uid, "name": d.get("name") or "?", "username": d.get("username") or "", "photo": d.get("photo") or ""}
    return cache[uid]


def game_history(uid, limit=30):
    """Main database se: is user ke matches (game history)."""
    try:
        m = fb.get_db(); u = (m.collection("users").document(uid).get().to_dict() or {})
        ids = (u.get("joined_matches") or [])[-limit:]
        out = []
        for mid in reversed(ids):
            mid = mid if isinstance(mid, str) else (mid or {}).get("id")
            s = m.collection("matches").document(mid).get()
            if not s.exists: continue
            d = s.to_dict() or {}; me = next((p for p in (d.get("participants") or []) if p.get("uid") == uid), {})
            out.append({"id": mid, "title": d.get("title"), "mode": d.get("teamMode") or d.get("modeLabel"), "status": d.get("status"), "fee": d.get("fee"),
                        "win": me.get("winAmount") or 0, "kills": me.get("kills") or 0, "rank": me.get("rank"), "code": d.get("matchCode"), "map": d.get("map")})
        return out
    except Exception as e:
        return [{"error": str(e)}]


def user_detail(uid):
    c = C(); cache = {}
    s = c.collection("cprofiles").document(uid).get()
    if not s.exists: return None
    prof = _d(s)
    fr = (c.collection("cfriends").document(uid).get().to_dict() or {})
    bl = (c.collection("cblocks").document(uid).get().to_dict() or {})
    inc = [_d(x) for x in c.collection("crequests").where("to", "==", uid).limit(60).stream()]
    outg = [_d(x) for x in c.collection("crequests").where("from", "==", uid).limit(60).stream()]
    chats = []
    for x in c.collection("cchats").where("members", "array_contains", uid).limit(60).stream():
        d = _d(x); other = next((m for m in d.get("members", []) if m != uid), None)
        chats.append({"id": x.id, "with": _name(other, cache) if other else None, "lastMsg": d.get("lastMsg"), "lastAt": d.get("lastAt")})
    groups = [{"id": x.id, "name": (x.to_dict() or {}).get("name"), "members": len((x.to_dict() or {}).get("members", []))} for x in c.collection("cgroups").where("members", "array_contains", uid).limit(40).stream()]
    reps = [_d(x) for x in c.collection("creports").where("against", "==", uid).limit(40).stream()] + [_d(x) for x in c.collection("creports").where("from", "==", uid).limit(40).stream()]
    return {"profile": prof, "friends": [_name(f, cache) | {"starred": f in (fr.get("starred") or []), "nick": (fr.get("nicks") or {}).get(f, "")} for f in (fr.get("list") or [])],
            "blocked": [_name(b, cache) for b in (bl.get("list") or [])], "incoming": inc, "outgoing": outg, "chats": chats, "groups": groups, "reports": reps,
            "games": game_history(uid), "verified": is_verified(uid)}


def messages(kind, cid, limit=250):
    c = C()
    if kind == "world": col = c.collection("cworld")
    elif kind == "dm": col = c.collection("cchats").document(cid).collection("msgs")
    elif kind == "group": col = c.collection("cgroups").document(cid).collection("msgs")
    else: raise ValueError("kind galat")
    out = [_d(s) | {"path": s.reference.path} for s in col.order_by("at", direction="DESCENDING").limit(limit).stream()]
    names = {}
    for m in out:
        if m.get("from"): m["fromName"] = _name(m["from"], names)["name"]
    out.reverse(); return out


def soft_delete_message(path):
    parts = path.strip("/").split("/")
    ok = (len(parts) == 2 and parts[0] == "cworld") or (len(parts) == 4 and parts[0] in ("cchats", "cgroups") and parts[2] == "msgs")
    if not ok: raise ValueError("Path galat")
    C().document(path).set({"deleted": True, "text": "", "adminDeleted": True}, merge=True)


def _dbs():
    """Main DB + chat DB (same object when chat is not separate). Blue ticks are written to BOTH, so they survive
    switching the chat to another (empty) Firebase project — just paste its key in FIREBASE_CREDENTIALS_B641 and press Sync."""
    a = fb.get_db(); b = C()
    return [a] if a is b else [a, b]


def _stamp(ref, flag):
    try:
        if ref.get().exists: ref.set({"isVerified": bool(flag), "verifiedAt": dt.datetime.utcnow().isoformat() + "Z" if flag else None}, merge=True)
    except Exception: pass


def set_verified(uid, flag):
    """Blue tick ON/OFF for one user. Writes cconfig/verified {uids:[...]} + cprofiles.verified in the main AND the chat database,
    and users.isVerified in the main database. Needs only the Admin SDK key(s)."""
    from google.cloud import firestore as gfs
    uid = str(uid or "").strip()
    if not uid: raise ValueError("UID missing")
    errs = []
    for db in _dbs():
        try:
            db.collection("cconfig").document("verified").set({"uids": gfs.ArrayUnion([uid]) if flag else gfs.ArrayRemove([uid])}, merge=True)
            ref = db.collection("cprofiles").document(uid)
            if ref.get().exists: ref.set({"verified": bool(flag)}, merge=True)
        except Exception as e: errs.append(str(e)[:120])
    _stamp(fb.get_db().collection("users").document(uid), flag)
    if len(errs) == len(_dbs()): raise RuntimeError("chat DB write failed: " + errs[0])
    return True


def sync_all_verified():
    """Rebuild the verified list in every database from users.isVerified == True (run after you change the chat project)."""
    uids = [d.id for d in fb.get_db().collection("users").where("isVerified", "==", True).stream()]
    for db in _dbs():
        db.collection("cconfig").document("verified").set({"uids": uids})
        for u in uids:
            try:
                r = db.collection("cprofiles").document(u)
                if r.get().exists: r.set({"verified": True}, merge=True)
            except Exception: pass
    return len(uids)


def resolve_uid(q):
    """username (chat) / playerId / UID -> uid"""
    q = str(q or "").strip()
    if not q: return None
    ql = q.lower().lstrip("@")
    s = C().collection("cusernames").document(ql).get()
    if s.exists and (s.to_dict() or {}).get("uid"): return s.to_dict()["uid"]
    if fb.get_db().collection("users").document(q).get().exists: return q
    for d in fb.get_db().collection("users").where("playerId", "==", q).limit(1).stream(): return d.id
    for d in fb.get_db().collection("users").where("playerId", "==", q.upper()).limit(1).stream(): return d.id
    return None


def verified_list():
    uids = {d.id for d in fb.get_db().collection("users").where("isVerified", "==", True).stream()}
    try: uids |= set((C().collection("cconfig").document("verified").get().to_dict() or {}).get("uids", []))
    except Exception: pass
    out = []
    for u in sorted(uids):
        m = fb.get_db().collection("users").document(u).get().to_dict() or {}
        p = C().collection("cprofiles").document(u).get().to_dict() or {}
        out.append({"uid": u, "name": p.get("name") or m.get("appName") or "?", "username": p.get("username") or "", "photo": p.get("photo") or m.get("photoUrl") or ""})
    return out


def is_verified(uid):
    try:
        if (fb.get_db().collection("users").document(uid).get().to_dict() or {}).get("isVerified"): return True
        return uid in ((C().collection("cconfig").document("verified").get().to_dict() or {}).get("uids", []))
    except Exception: return False


def set_banned(uid, banned, reason=""):
    C().collection("cprofiles").document(uid).set({"banned": bool(banned), "banReason": reason[:100]}, merge=True)


def delete_chat(kind, cid):
    c = C()
    if kind == "dm": slow.delete_tree(c, c.collection("cchats").document(cid))
    elif kind == "group": slow.delete_tree(c, c.collection("cgroups").document(cid))
    else: raise ValueError("kind galat")


def world_clear():
    c = C(); n = 0
    for s in slow.paced(c.collection("cworld").stream(), 25, 0.5): s.reference.delete(); n += 1
    return n


def groups(limit=80):
    return [_d(s) for s in C().collection("cgroups").order_by("createdAt", direction="DESCENDING").limit(limit).stream()]


def reports(status="open", limit=100):
    q = C().collection("creports")
    if status != "all": q = q.where("status", "==", status)
    names = {}; out = []
    for s in q.limit(limit).stream():
        d = _d(s)
        for k in ("from", "against"):
            if d.get(k): d[k + "Info"] = _name(d[k], names)
        out.append(d)
    out.sort(key=lambda x: -(x.get("createdAt") or 0)); return out


def resolve_report(rid, status, note=""):
    C().collection("creports").document(rid).set({"status": status, "adminNote": note[:200], "resolvedAt": int(time.time() * 1000)}, merge=True)
