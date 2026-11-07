/**
 * Coin Battle — app side. The game UI is pages/game/coin.html (shown in a full-screen iframe); the SERVER
 * (Main admin panel, /api/ball/*) runs all rules & money. This file only gives that page what it needs
 * (login token, wallet balance, live game updates, deposit / close buttons) through window.ballBridge.
 */
import { authService, dbService, doc, onSnapshot } from '../../js/core/firebase.js?v=138b436893';
import { GAME_API } from '../../js/core/app-config.js?v=138b436893';

const $ = (id) => document.getElementById(id);
let skew = 0;
const uid = () => authService.currentUser && authService.currentUser.uid;
const balance = () => Number((window.db && window.db.balance) || 0);
const toast = (m) => { try { window.ui.toast(m); } catch (e) {} };

async function api(path, body, ms = 75000, base = GAME_API) {
    if (!base) throw new Error('Game server is not set up yet (admin: set GAME_SERVER in app-config.js)');
    const u = authService.currentUser; if (!u) throw new Error('Please log in first');
    const tok = await u.getIdToken(); const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
    let r; try { r = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body || {}), signal: ctl.signal }); }
    catch (e) { clearTimeout(tm); throw new Error(e && e.name === 'AbortError' ? 'Game server is waking up — try again in a minute' : 'Cannot reach the game server'); }
    clearTimeout(tm); let j = {}; try { j = await r.json(); } catch (e) {}
    if (j.now) skew = j.now - Date.now();
    if (!r.ok && !j.status) throw new Error(j.error || 'Server error ' + r.status);
    return j;
}
const myInfo = () => { const d = window.db || {}; const name = d.appName || d.userName || (authService.currentUser && authService.currentUser.displayName) || 'Player'; return { name, photo: d.photoUrl || (authService.currentUser && authService.currentUser.photoURL) || '' }; };

function close() {
    const f = $('ball-frame'); if (f) f.src = 'about:blank';
    $('ball').classList.remove('on'); $('ball').setAttribute('aria-hidden', 'true'); document.body.classList.remove('ball-open');
}

// everything the game page may call
window.ballBridge = {
    api, now: () => Date.now() + skew, balance, me: myInfo, uid,
    avatar: (n) => window.gameArt.avatar(n),
    watch: (gid, cb, err) => onSnapshot(doc(dbService, 'ball_games', gid), (s) => { if (s.exists()) cb({ id: gid, ...s.data() }); }, err),
    sfx: (n) => { try { window.sfx && window.sfx.play(n); } catch (e) {} },
    confirm: (o) => (window.ui && window.ui.confirm ? window.ui.confirm(o) : Promise.resolve(confirm(o.title + '\n' + (o.text || '')))),
    deposit: () => { close(); try { window.ui.openModal('modal-deposit'); } catch (e) {} },
    close,
};

const BOMB_API = GAME_API ? GAME_API.replace(/\/api\/ball$/, '/api/bomb') : '';
const mkCard = () => `<div class="gc-list"><button type="button" class="gc" onclick="ballGame.open()"><img src="assets/img/game/cf/coin-gold.png" alt="Coin Battle" draggable="false"><div><b>Coin Battle</b><span>Connect 4 coins in a row and win cash</span><em>Entry from ₹2 · Win up to 1.8×</em></div><i class="fa-solid fa-play"></i></button><button type="button" class="gc gc-bomb" onclick="bombGame.open()"><img src="assets/img/game/bomb/icon.png" alt="Bomb &amp; Gems" draggable="false" width="84" height="84"><div><b>Bomb &amp; Gems</b><span>Find gems, dodge hidden bombs, win cash</span><em>Entry from ₹2 · Win up to 1.8×</em></div><i class="fa-solid fa-play"></i></button></div>`;

window.ballGame = {
    card: mkCard,
    open() {
        if (!authService.currentUser) { try { window.app.checkLogin(() => window.ballGame.open()); } catch (e) { toast('Please log in'); } return; }
        $('ball-frame').src = 'pages/game/coin.html?v=' + Date.now();
        $('ball').classList.add('on'); $('ball').setAttribute('aria-hidden', 'false'); document.body.classList.add('ball-open');
    },
    close,
};

// ---------------- Bomb & Gems (pages/game/bomb.html, server: /api/bomb/*) ----------------
function closeBomb() {
    const f = $('bomb-frame'); if (f) f.src = 'about:blank';
    $('bomb').classList.remove('on'); $('bomb').setAttribute('aria-hidden', 'true'); document.body.classList.remove('ball-open');
}
window.bombBridge = Object.assign({}, window.ballBridge, {
    api: (path, body, ms) => api(path, body, ms, BOMB_API),
    watch: (gid, cb, err) => onSnapshot(doc(dbService, 'bomb_games', gid), (s) => { if (s.exists()) cb({ id: gid, ...s.data() }); }, err),
    deposit: () => { closeBomb(); try { window.ui.openModal('modal-deposit'); } catch (e) {} },
    close: closeBomb,
});
window.bombGame = {
    open() {
        if (!authService.currentUser) { try { window.app.checkLogin(() => window.bombGame.open()); } catch (e) { toast('Please log in'); } return; }
        $('bomb-frame').src = 'pages/game/bomb.html?v=' + Date.now();
        $('bomb').classList.add('on'); $('bomb').setAttribute('aria-hidden', 'false'); document.body.classList.add('ball-open');
    },
    close: closeBomb,
};
