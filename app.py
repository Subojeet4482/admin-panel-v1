"""FF Admin MAIN panel (service 1) — users, user search, wallet, matches, chat manager, settings, gift codes, LB rewards.
Heavy kaam (backup / data center) -> Service 3, Fampay bot -> Service 2. Isi service ka URL user app mein chat-token ke liye bhi chalta hai."""
import os, time, threading
from flask import Flask, jsonify, request, send_from_directory, g, Response
from werkzeug.middleware.proxy_fix import ProxyFix

import fb, security, sysmon, jobs, chatadmin, keepalive, opsapi, panel, ballgame
import admin_lite as lite  # LITE panel (sub-admin: users/wallet/matches/settings)

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")

app = Flask(__name__, static_folder=None)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

ok = lambda **k: jsonify(ok=True, **k)
bad = lambda msg, code=400: (jsonify(ok=False, error=msg), code)


@app.after_request
def headers(r):
    r.headers["X-Content-Type-Options"] = "nosniff"
    r.headers["X-Frame-Options"] = "DENY"
    r.headers["Referrer-Policy"] = "same-origin"
    if request.path.startswith("/api/") or request.path.endswith((".html", ".js", ".css")) or request.path == "/":
        r.headers["Cache-Control"] = "no-store"
    return r


@app.route("/")
@app.route("/admin")
def index():
    # Owner -> main panel (admin.html), admin -> lite panel, koi session nahi -> admin.html ka login screen
    if lite.read_session():
        return Response(lite.HTML, mimetype="text/html")
    return send_from_directory(PUBLIC, "admin.html")


@app.route("/<path:p>")
def static_files(p):
    if p.startswith("api/"):
        return bad("Not found", 404)
    return send_from_directory(PUBLIC, p)


@app.route("/health")
def health():
    return jsonify(ok=True, panel=panel.KEY, uptime=int(time.time() - opsapi.BOOT))


# ------------------------------------------------------------------ auth
# Ek hi login form (email + password + PIN): OWNER_* creds match -> main panel, ADMIN_* creds
# match -> lite panel, koi bhi match nahi -> 1 hi shared counter mein fail ginta hai (5 galat
# attempt -> IP 1 hour lock, disk par save — security.py dekho).
@app.post("/api/login")
def login():
    if not security.creds_ready():
        return bad("Server par OWNER_EMAIL/PASSWORD/PIN ya ADMIN_EMAIL/PASSWORD/PIN env set nahi hain (Render → Environment).", 503)
    ip = security.client_ip()
    wait = security.locked_for(ip)
    if wait:
        return bad(f"Bahut zyada galat attempts. {wait // 60 + 1} minute baad try karo.", 429)
    d = request.get_json(silent=True) or {}
    role = security.check_login_combined(d.get("email"), d.get("password"), d.get("pin"))
    if not role:
        security.register_fail(ip)
        time.sleep(0.8)
        return bad("Email, password ya PIN galat hai", 401)
    security.register_ok(ip)
    resp = jsonify(ok=True, role=role)
    if role == "owner":
        resp.set_cookie(security.SESSION_COOKIE, security.make_session(security.creds()[0]),
                        max_age=int(security.SESSION_HOURS * 3600), httponly=True,
                        samesite="Strict", secure=request.is_secure)
        resp.delete_cookie(lite.COOKIE)
    else:
        resp.set_cookie(lite.COOKIE, lite.make_session(),
                        max_age=lite.SESSION_H * 3600, httponly=True,
                        samesite="Strict", secure=request.is_secure)
        resp.delete_cookie(security.SESSION_COOKIE)
    return resp


@app.get("/api/session")
def session():
    u = security.current_user()
    if u:
        return jsonify(ok=True, ready=security.creds_ready(), role="owner", email=u.get("u"))
    if lite.read_session():
        return jsonify(ok=True, ready=security.creds_ready(), role="admin", email=lite.EMAIL)
    return jsonify(ok=False, ready=security.creds_ready())


@app.post("/api/logout")
def logout():
    resp = jsonify(ok=True)
    resp.delete_cookie(security.SESSION_COOKIE)
    resp.delete_cookie(lite.COOKIE)
    return resp


@app.get("/api/firebase-token")
@security.login_required
def firebase_token():
    """Panel ke Firestore client ko admin claim wala token — service key server par hi rehti hai."""
    try:
        return ok(token=fb.make_custom_token(security.creds()[0]))
    except Exception as e:
        return bad(f"Firebase token nahi bana: {e}", 500)



@app.before_request
def _sys_req_start():
    g._t0 = sysmon.req_start()


@app.after_request
def _sys_req_end(resp):
    try:
        if not request.path.startswith(("/api/server/live", "/health")):
            sysmon.req_end(getattr(g, "_t0", time.time()), resp.status_code)
    except Exception:
        pass
    return resp


@app.after_request
def _lite_cache_bust(resp):
    """Lite panel ki list-cache: koi write (POST) kamyab hua to turant saaf."""
    try:
        if request.method == "POST" and resp.status_code < 400 and request.path.startswith(("/api/users", "/api/wallet", "/api/matches")):
            lite.bust_cache()
    except Exception:
        pass
    return resp


opsapi.register_ops(app, bot_status_fn=lambda: {"status": "main"}, extra_env_fn=lambda: {
    "OWNER_EMAIL": bool(os.environ.get("OWNER_EMAIL")), "OWNER_PASSWORD": bool(os.environ.get("OWNER_PASSWORD")), "OWNER_PIN": bool(os.environ.get("OWNER_PIN")),
    "ADMIN_EMAIL": bool(os.environ.get("ADMIN_EMAIL")), "ADMIN_PASSWORD": bool(os.environ.get("ADMIN_PASSWORD")), "ADMIN_PIN": bool(os.environ.get("ADMIN_PIN")),
    "SESSION_SECRET": security.secret_from_env(), "CHAT DB (optional)": fb.chat_separate()})


# ------------------------------------------------------------------ CHAT: token bridge (user app -> chat project)
@app.route("/api/chat/token", methods=["POST", "OPTIONS"])
def chat_token():
    """User app apna main ID token bhejta hai; chat project ke liye custom token milta hai (uid same)."""
    origin = os.environ.get("CHAT_CORS_ORIGIN", "*")
    hdr = {"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin"}
    if request.method == "OPTIONS":
        return Response(status=204, headers=hdr)
    try:
        if not fb.chat_separate():
            return Response('{"ok":false,"error":"separate chat project not configured"}', status=400, mimetype="application/json", headers=hdr)
        tok = (request.headers.get("Authorization") or "").replace("Bearer ", "").strip()
        info = fb.verify_main_token(tok)
        try:  # keep the chat profile's blue tick in sync with the main user record
            if (fb.get_db().collection("users").document(info["uid"]).get().to_dict() or {}).get("isVerified"): chatadmin.set_verified(info["uid"], True)
        except Exception: pass
        return Response(jsonify(ok=True, token=fb.chat_custom_token(info["uid"])).get_data(), mimetype="application/json", headers=hdr)
    except Exception as e:
        return Response(jsonify(ok=False, error=str(e)[:160]).get_data(), status=401, mimetype="application/json", headers=hdr)


# ------------------------------------------------------------------ CHAT: admin manager
@app.get("/api/chatadm/overview")
@security.login_required
def ca_overview():
    try: return ok(**chatadmin.overview())
    except Exception as e: return bad(f"Chat DB error: {e}", 500)


@app.post("/api/chatadm/verify")
@security.login_required
def ca_verify():
    try:
        d = request.get_json(silent=True) or {}
        return ok(synced=chatadmin.set_verified(str(d.get("uid", "")), bool(d.get("verified"))))
    except Exception as e: return bad(str(e), 500)


@app.post("/api/chatadm/verify-sync")
@security.login_required
def ca_verify_sync():
    try: return ok(synced=chatadmin.sync_all_verified())
    except Exception as e: return bad(str(e), 500)


@app.post("/api/chatadm/world")
@security.login_required
def ca_world_save():
    try: return ok(cfg=chatadmin.save_world_cfg(request.get_json(silent=True) or {}))
    except Exception as e: return bad(str(e), 500)


@app.get("/api/chatadm/users")
@security.login_required
def ca_users():
    try: return ok(users=chatadmin.users(request.args.get("q", "")))
    except Exception as e: return bad(f"Chat DB error: {e}", 500)


@app.get("/api/chatadm/user/<uid>")
@security.login_required
def ca_user(uid):
    try:
        d = chatadmin.user_detail(uid)
        return ok(**d) if d else bad("Chat profile nahi mila", 404)
    except Exception as e: return bad(f"Chat DB error: {e}", 500)


@app.get("/api/chatadm/messages/<kind>/<cid>")
@security.login_required
def ca_messages(kind, cid):
    try: return ok(messages=chatadmin.messages(kind, cid))
    except Exception as e: return bad(str(e), 500)


@app.post("/api/chatadm/msg/delete")
@security.login_required
def ca_msg_delete():
    try: chatadmin.soft_delete_message((request.get_json(silent=True) or {}).get("path", "")); return ok()
    except Exception as e: return bad(str(e), 400)


@app.post("/api/chatadm/user/<uid>/ban")
@security.login_required
def ca_ban(uid):
    d = request.get_json(silent=True) or {}
    try: chatadmin.set_banned(uid, d.get("banned"), d.get("reason", "")); return ok()
    except Exception as e: return bad(str(e), 500)


@app.post("/api/chatadm/<kind>/<cid>/delete")
@security.pin_required
def ca_delete(kind, cid):
    try: chatadmin.delete_chat(kind, cid); return ok()
    except Exception as e: return bad(str(e), 400)


@app.post("/api/chatadm/world/clear")
@security.pin_required
def ca_world_clear():
    try: return ok(deleted=chatadmin.world_clear())
    except Exception as e: return bad(str(e), 500)


@app.get("/api/chatadm/groups")
@security.login_required
def ca_groups():
    try: return ok(groups=chatadmin.groups())
    except Exception as e: return bad(str(e), 500)


@app.get("/api/chatadm/reports")
@security.login_required
def ca_reports():
    try: return ok(reports=chatadmin.reports(request.args.get("status", "open")))
    except Exception as e: return bad(str(e), 500)


@app.post("/api/chatadm/report/<rid>")
@security.login_required
def ca_report(rid):
    d = request.get_json(silent=True) or {}
    try: chatadmin.resolve_report(rid, d.get("status", "resolved"), d.get("note", "")); return ok()
    except Exception as e: return bad(str(e), 500)


# ------------------------------------------------------------------ lite panel routes (merged)
# admin_lite.py ke functions pehle se @login_required (lite ka apna session/cookie check) se decorated
# hain, isliye yahan unhi ko seedha register kar rahe hain — ek hi process, ek hi Firestore connection.
@app.errorhandler(lite.ApiError)
def _lite_api_err(e):
    return jsonify(ok=False, error=e.msg), e.code


@app.errorhandler(500)
def _json_500(e):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error="Server error"), 500
    return e


_LITE_ROUTES = [
    ("/api/users", ["GET"], lite.users),
    ("/api/users/<uid>", ["GET"], lite.user_detail),
    ("/api/users/<uid>/balance", ["POST"], lite.user_balance),
    ("/api/users/<uid>/ban", ["POST"], lite.user_ban),
    ("/api/users/<uid>/unban", ["POST"], lite.user_unban),
    ("/api/wallet", ["GET"], lite.wallet),
    ("/api/wallet/process", ["POST"], lite.wallet_process),
    ("/api/matches", ["GET"], lite.matches),
    ("/api/matches", ["POST"], lite.match_create),
    ("/api/matches/<mid>", ["GET"], lite.match_get),
    ("/api/matches/<mid>/delete", ["POST"], lite.match_delete),
    ("/api/matches/<mid>/room", ["POST"], lite.match_room),
    ("/api/matches/<mid>/complete", ["POST"], lite.match_complete),
    ("/api/matches/<mid>/pay", ["POST"], lite.match_pay),
    ("/api/settings", ["GET"], lite.settings_get),
    ("/api/settings", ["POST"], lite.settings_save),
]
for _rule, _methods, _fn in _LITE_ROUTES:
    app.add_url_rule(_rule, endpoint=f"lite_{_fn.__name__}_{_methods[0]}", view_func=_fn, methods=_methods)


# ------------------------------------------------------------------ 4 Ball Match (game server)
ballgame.register(app)


# ------------------------------------------------------------------ boot
_booted = False
_boot_lock = threading.Lock()


def boot():
    global _booted
    with _boot_lock:
        if _booted:
            return
        _booted = True
    if not security.creds_ready():
        print("[warn] OWNER_* aur ADMIN_* dono missing — login disabled", flush=True)
    if not security.secret_from_env():
        print("[warn] SESSION_SECRET set nahi — restart par sab admin logout ho jayenge", flush=True)
    jobs.start()
    keepalive.start()


boot()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 10000)))
