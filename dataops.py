"""Admin data operations:
  1) purge_user  — ek user ka HAR data delete (main + chat + proofs database + login accounts), background job.
  2) usage       — Firebase storage kitna use hua / kitna bacha (Firestore estimate + Storage bucket), cached.
Dono dheere-dheere chalte hain (slow.py) taaki Render free plan par bot/panel na ruke.
"""
import os, time, threading, uuid, datetime as dt
from google.cloud import firestore as gfs
from firebase_admin import auth
import fb, slow

# ============================================================== USER PURGE (background job)
JOBS = {}
_LOCK = threading.Lock()


def start_purge(uid):
    uid = str(uid or "").strip()
    if not uid or "/" in uid:
        raise ValueError("uid galat hai")
    with _LOCK:
        for j in JOBS.values():
            if j["uid"] == uid and j["status"] == "running":
                return j["id"]
        jid = uuid.uuid4().hex[:10]
        JOBS[jid] = {"id": jid, "uid": uid, "status": "running", "progress": "start", "steps": [], "started": time.time()}
        while len(JOBS) > 20:
            JOBS.pop(next(iter(JOBS)))
    threading.Thread(target=_run_purge, args=(jid,), daemon=True).start()
    return jid


def job(jid):
    return JOBS.get(jid)


def _run_purge(jid):
    j = JOBS[jid]
    try:
        purge_user(j, j["uid"])
        j["status"] = "done"; j["progress"] = "complete"
    except Exception as e:
        j["status"] = "error"; j["error"] = str(e); j["progress"] = "failed"


def _step(j, name, fn):
    """Ek step chalao; fail ho to baaki steps nahi rukte."""
    j["progress"] = name
    try:
        n = fn()
        j["steps"].append({"step": name, "ok": True, "n": n})
    except Exception as e:
        j["steps"].append({"step": name, "ok": False, "error": str(e)[:220]})


def _del_query(db, q):
    n = 0
    for s in slow.paced(list(q.stream()), 20, 0.4):
        s.reference.delete(); n += 1
    return n


def _del_tree_query(db, q):
    n = 0
    for s in list(q.stream()):
        slow.delete_tree(db, s.reference); n += 1
    return n


def purge_user(j, uid):
    db = fb.get_db()
    uref = db.collection("users").document(uid)
    snap = uref.get()
    j["name"] = (snap.to_dict() or {}).get("appName") or (snap.to_dict() or {}).get("gameName") or uid

    # ---------------- MAIN database ----------------
    _step(j, "Match participation", lambda: _clean_matches(db, uid))
    _step(j, "Leaderboard entries", lambda: _clean_lb(db, uid))
    _step(j, "Game stats + referral", lambda: sum(1 for c, i in (("bomb_stats", uid), ("ball_stats", uid), ("referrals", uid)) if _del_doc(db.collection(c).document(i)))
          + _del_query(db, db.collection("ref_cards").where("uid", "==", uid)))
    _step(j, "Deposit requests", lambda: _del_query(db, db.collection("deposit_requests").where("uid", "==", uid)))
    _step(j, "Blue tick list", lambda: _untick(db, "config", uid))
    _step(j, "User + wallet + history", lambda: (slow.delete_tree(db, uref), 1)[1])

    # ---------------- CHAT database ----------------
    try:
        c = fb.get_chat_db()
    except Exception as e:
        c = None; j["steps"].append({"step": "Chat database", "ok": False, "error": str(e)[:200]})
    if c is not None:
        _step(j, "Chat profile + usernames", lambda: sum(1 for cc, i in (("cprofiles", uid), ("cfriends", uid), ("cblocks", uid)) if _del_doc(c.collection(cc).document(i)))
              + _del_query(c, c.collection("cusernames").where("uid", "==", uid)))
        _step(j, "Removed from others' friend/block lists", lambda: _unlist(c, uid))
        _step(j, "Friend requests + reports", lambda: sum(_del_query(c, c.collection(cn).where(f, "==", uid))
                                                           for cn, f in (("crequests", "from"), ("crequests", "to"), ("creports", "from"), ("creports", "against"))))
        _step(j, "Private chats (DM)", lambda: _del_tree_query(c, c.collection("cchats").where("members", "array_contains", uid)))
        _step(j, "Groups", lambda: _leave_groups(c, uid))
        _step(j, "World chat messages", lambda: _del_query(c, c.collection("cworld").where("from", "==", uid)))
        _step(j, "Blue tick (chat)", lambda: _untick(c, "cconfig", uid))
        if fb.chat_separate():
            _step(j, "Chat login account", lambda: _del_auth(uid, getattr(fb, "_chat_app", None)))

    # ---------------- PROOFS database ----------------
    pdb = fb.get_proofs_db()
    if pdb is None:
        j["steps"].append({"step": "Proofs database", "ok": False, "error": "skipped — env FIREBASE_CREDENTIALS_B642 set nahi hai"})
    else:
        _step(j, "Proofs", lambda: _del_tree_query(pdb, pdb.collection("proofs_feed").where("uid", "==", uid)))
        _step(j, "Likes given", lambda: _del_group(pdb, "likes", uid, "likeCount"))
        _step(j, "Comments written", lambda: _del_group(pdb, "comments", uid, "commentCount"))

    # ---------------- LOGIN account (main) ----------------
    _step(j, "Login account", lambda: _del_auth(uid, None))


def _del_doc(ref):
    s = ref.get()
    if s.exists:
        ref.delete(); return True
    return False


def _del_auth(uid, app):
    try:
        auth.delete_user(uid, app=app) if app is not None else auth.delete_user(uid)
        return 1
    except auth.UserNotFoundError:
        return 0


def _clean_matches(db, uid):
    n = 0
    for m in slow.paced(list(db.collection("matches").stream()), 15, 0.4):
        md = m.to_dict() or {}
        parts = [p for p in (md.get("participants") or []) if not (isinstance(p, dict) and p.get("uid") == uid)]
        slots = [s for s in (md.get("takenSlots") or []) if not (isinstance(s, dict) and s.get("uid") == uid)]
        removed = len(md.get("participants") or []) - len(parts)
        if removed > 0 or len(slots) != len(md.get("takenSlots") or []):
            m.reference.update({"participants": parts, "takenSlots": slots, "joined": max(0, int(md.get("joined") or 0) - removed)}); n += 1
    return n


def _clean_lb(db, uid):
    n = 0
    for s in list(db.collection("lb").stream()):
        if uid in ((s.to_dict() or {}).get("players") or {}):
            s.reference.update({"players." + uid: gfs.DELETE_FIELD}); n += 1
    return n


def _untick(db, col, uid):
    r = db.collection(col).document("verified")
    if r.get().exists:
        r.update({"uids": gfs.ArrayRemove([uid])}); return 1
    return 0


def _unlist(c, uid):
    n = 0
    for col in ("cfriends", "cblocks"):
        for s in list(c.collection(col).where("list", "array_contains", uid).stream()):
            upd = {"list": gfs.ArrayRemove([uid])}
            if uid in ((s.to_dict() or {}).get("starred") or []):
                upd["starred"] = gfs.ArrayRemove([uid])
            s.reference.update(upd); n += 1
    return n


def _leave_groups(c, uid):
    n = 0
    for s in list(c.collection("cgroups").where("members", "array_contains", uid).stream()):
        d = s.to_dict() or {}
        rest = [m for m in (d.get("members") or []) if m != uid]
        if not rest:
            slow.delete_tree(c, s.reference)
        else:
            upd = {"members": gfs.ArrayRemove([uid])}
            if uid in (d.get("admins") or []):
                upd["admins"] = gfs.ArrayRemove([uid])
            s.reference.update(upd)
        n += 1
    return n


def _del_group(pdb, sub, uid, counter):
    """Proofs ke likes/comments jo is user ne diye — collection-group query (index chahiye ho to error mein link aata hai)."""
    n = 0
    for s in list(pdb.collection_group(sub).where("uid", "==", uid).stream()):
        parent = s.reference.parent.parent
        s.reference.delete(); n += 1
        try:
            parent.update({counter: gfs.Increment(-1)})
        except Exception:
            pass
    return n


# ============================================================== STORAGE USAGE
_CACHE = {"t": 0, "data": None}
GIB = 1024 ** 3


def _size(v):
    if v is None or isinstance(v, bool): return 1
    if isinstance(v, str): return len(v.encode("utf-8")) + 1
    if isinstance(v, (int, float)): return 8
    if isinstance(v, dt.datetime): return 8
    if isinstance(v, (bytes, bytearray)): return len(v)
    if isinstance(v, (list, tuple)): return sum(_size(x) for x in v)
    if isinstance(v, dict): return sum(len(str(k)) + 1 + _size(x) for k, x in v.items())
    return 16


def _doc_bytes(snap):
    return len(snap.reference.path) + 1 + _size(snap.to_dict() or {}) + 32      # Firestore ka documented formula (approx)


def _count(q):
    try:
        return int(q.count().get()[0][0].value)
    except Exception:
        return -1


def _avg(q, k=12):
    sizes = []
    for s in q.limit(k).stream():
        sizes.append(_doc_bytes(s))
    return (sum(sizes) / len(sizes)) if sizes else 0


def _firestore_usage(db):
    cols = {}                                     # name -> query used for count/sample
    subs = set()
    for c in db.collections():
        cols[c.id] = db.collection(c.id)
        for d in c.limit(3).stream():
            for sc in d.reference.collections():
                subs.add(sc.id)
    for sname in subs:
        if sname not in cols:
            cols[sname + "  (sub)"] = db.collection_group(sname)
    rows = []
    for name, q in cols.items():
        n = _count(q)
        if n <= 0:
            rows.append({"name": name, "docs": max(n, 0), "bytes": 0}); continue
        rows.append({"name": name, "docs": n, "bytes": int(n * _avg(q))})
    # users ke andar ka data "users" row mein nahi aata (alag collection-group) — top-level + sub dono alag dikhte hain
    rows.sort(key=lambda r: r["bytes"], reverse=True)
    return {"docs": sum(r["docs"] for r in rows), "bytes": sum(r["bytes"] for r in rows), "collections": rows[:14]}


def _bucket_usage(app, project_id):
    from firebase_admin import storage
    name = (os.environ.get("FIREBASE_STORAGE_BUCKET") if app is None else "") or f"{project_id}.firebasestorage.app"
    b = storage.bucket(name, app=app) if app is not None else storage.bucket(name)
    files = size = 0
    for bl in b.list_blobs(max_results=20000):
        files += 1; size += int(bl.size or 0)
    return {"bucket": name, "files": files, "bytes": size}


def _project(label, db, app, project_id):
    out = {"label": label, "project_id": project_id}
    fs_limit = int(float(os.environ.get("FIRESTORE_FREE_GB", "1")) * GIB)
    st_limit = int(float(os.environ.get("STORAGE_FREE_GB", "5")) * GIB)
    try:
        f = _firestore_usage(db); f["limit"] = fs_limit; f["left"] = max(0, fs_limit - f["bytes"]); f["pct"] = round(100 * f["bytes"] / fs_limit, 2)
        out["firestore"] = f
    except Exception as e:
        out["firestore"] = {"error": str(e)[:200]}
    try:
        s = _bucket_usage(app, project_id); s["limit"] = st_limit; s["left"] = max(0, st_limit - s["bytes"]); s["pct"] = round(100 * s["bytes"] / st_limit, 2)
        out["storage"] = s
    except Exception as e:
        out["storage"] = {"error": str(e)[:160]}
    return out


def usage(refresh=False):
    if not refresh and _CACHE["data"] and time.time() - _CACHE["t"] < 900:
        return _CACHE["data"]
    projects = []
    main_db = fb.get_db()
    projects.append(_project("Main (game data)", main_db, None, fb.firebase_status().get("project_id") or ""))
    if fb.chat_separate():
        try:
            cdb = fb.get_chat_db(); projects.append(_project("Chat", cdb, getattr(fb, "_chat_app", None), getattr(fb._chat_app, "project_id", "") or ""))
        except Exception as e:
            projects.append({"label": "Chat", "firestore": {"error": str(e)[:200]}})
    if fb.proofs_env():
        pdb = fb.get_proofs_db()
        if pdb is None:
            projects.append({"label": "Proofs", "firestore": {"error": fb.proofs_status().get("error") or "key galat"}})
        else:
            projects.append(_project("Proofs", pdb, getattr(fb, "_proofs_app", None), getattr(fb._proofs_app, "project_id", "") or ""))
    data = {"at": int(time.time() * 1000), "projects": projects,
            "note": "Firestore size ek ANDAZA hai (document count x sample size). Exact numbers + aaj ke reads/writes: Firebase Console -> Usage."}
    _CACHE["t"] = time.time(); _CACHE["data"] = data
    return data


# ============================================================== PROOFS MODERATION (admin)
def _n(v):
    try:
        return float(str(v).replace("₹", "").replace(",", "").replace("-", "").replace("+", "").strip())
    except Exception:
        return None


def proofs_list(limit=50):
    """Latest proofs + asli transaction ka data (full UTR / gift code) — sirf admin ko dikhta hai."""
    pdb = fb.get_proofs_db()
    if pdb is None:
        raise RuntimeError("Proofs database connect nahi: Render env FIREBASE_CREDENTIALS_B642 set karo")
    from google.cloud.firestore import Query
    limit = max(1, min(int(limit or 50), 200))
    snaps = list(pdb.collection("proofs_feed").order_by("createdAt", direction=Query.DESCENDING).limit(limit).stream())
    main = fb.get_db()
    refs = [main.collection("users").document(s.to_dict().get("uid", "_")).collection("transactions").document(s.to_dict().get("trxId", "_")) for s in snaps]
    real = {}
    try:
        for t in main.get_all(refs):
            real[t.reference.path] = t.to_dict() if t.exists else None
    except Exception:
        pass
    out = []
    for s, r in zip(snaps, refs):
        d = s.to_dict() or {}
        t = real.get(r.path)
        item = {"id": s.id, "uid": d.get("uid"), "name": d.get("name"), "kind": d.get("kind"), "tone": d.get("tone"), "amount": d.get("amount"),
                "via": d.get("via"), "refLabel": d.get("refLabel"), "refMask": d.get("refMask"), "orderNo": d.get("orderNo"), "text": d.get("text"),
                "createdAt": d.get("createdAt"), "likeCount": d.get("likeCount", 0), "commentCount": d.get("commentCount", 0), "trxId": d.get("trxId")}
        if t is None:
            item["check"] = "missing"                      # asli transaction nahi mili -> fake ho sakta hai
        else:
            ok_amt = _n(t.get("amount")) == _n(d.get("amount"))
            item["check"] = "ok" if ok_amt else "mismatch"
            item["real"] = {"method": t.get("method"), "status": t.get("status"), "amount": t.get("amount"), "utr": t.get("trxId"),
                            "giftCode": t.get("giftCode"), "upiId": t.get("upiId"), "type": t.get("type")}
        out.append(item)
    return out


def proof_delete(pid):
    pdb = fb.get_proofs_db()
    if pdb is None:
        raise RuntimeError("Proofs database connect nahi")
    ref = pdb.collection("proofs_feed").document(pid)
    s = ref.get()
    if not s.exists:
        return {"deleted": False}
    d = s.to_dict() or {}
    slow.delete_tree(pdb, ref)
    try:                                                    # user dobara share kar sake
        if d.get("uid") and d.get("trxId"):
            fb.get_db().collection("users").document(d["uid"]).collection("transactions").document(d["trxId"]).update({"isShared": False, "proofId": ""})
    except Exception:
        pass
    return {"deleted": True}


def proof_comments(pid):
    pdb = fb.get_proofs_db()
    if pdb is None:
        raise RuntimeError("Proofs database connect nahi")
    from google.cloud.firestore import Query
    return [{"id": c.id, **(c.to_dict() or {})} for c in pdb.collection("proofs_feed").document(pid).collection("comments").order_by("at", direction=Query.DESCENDING).limit(100).stream()]


def comment_delete(pid, cid):
    pdb = fb.get_proofs_db()
    if pdb is None:
        raise RuntimeError("Proofs database connect nahi")
    c = pdb.collection("proofs_feed").document(pid).collection("comments").document(cid)
    if c.get().exists:
        c.delete()
        try:
            pdb.collection("proofs_feed").document(pid).update({"commentCount": gfs.Increment(-1)})
        except Exception:
            pass
        return {"deleted": True}
    return {"deleted": False}
