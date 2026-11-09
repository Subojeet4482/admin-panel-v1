// Leaderboard manager: remove test entries, hide admin/test accounts for good, blue tick ON/OFF.
// Data: lb/{d|w|m}-{key}.players = { uid: { n, a, p?, g? } }   ·   hidden accounts: config/leaderboard.hidden = [uid]   ·   blue ticks: config/verified.uids
import { db, doc, getDoc, setDoc, updateDoc, onSnapshot, deleteField, arrayUnion, arrayRemove, collection, getDocs, query, where, limit } from './firebase.js';
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
let period = 'd', players = {}, hidden = [], ver = new Set(), unsubs = [];
let found = null, trash = [], names = {};   // found = player picked in "Add / edit"; trash = recently removed entries; names = uid -> {n,pid}

// the server writes the keys in IST — same here
const keysNow = () => {
  const n = new Date(Date.now() + 5.5 * 3600e3), ymd = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  const mon = new Date(n.getTime() - ((n.getUTCDay() + 6) % 7) * 86400e3);
  return { d: 'd-' + ymd(n), w: 'w-' + ymd(mon), m: 'm-' + n.getUTCFullYear() + pad(n.getUTCMonth() + 1) };
};
const inr = (v) => '₹' + (Math.round(Number(v || 0) * 100) / 100).toLocaleString('en-IN');

const paint = () => {
  const rows = Object.keys(players).map(id => ({ id, ...players[id] })).filter(r => Number(r.a) > 0).sort((a, b) => Number(b.a) - Number(a.a));
  $('lbm-key').textContent = keysNow()[period];
  ['d', 'w', 'm'].forEach(p => { const b = $('lbm-p-' + p); if (b) b.className = 'btn ' + (p === period ? 'btn-primary' : 'btn-outline'); });
  $('lbm-list').innerHTML = rows.length ? rows.map((r, i) => {
    const isH = hidden.includes(r.id), isV = ver.has(r.id);
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#eee);${isH ? 'opacity:.5' : ''}">
      <div style="width:30px;font-weight:800;text-align:center">${['🥇', '🥈', '🥉'][i] || '#' + (i + 1)}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:700">${esc(r.n || 'User')}${isV ? ' <i class="fa-solid fa-circle-check" style="color:#0a84ff"></i>' : ''}${isH ? ' <span class="muted">(hidden)</span>' : ''}</div>
        <div class="muted" style="font-size:.7rem;word-break:break-all">${esc(r.id)}</div></div>
      <div style="font-weight:800;white-space:nowrap">${inr(r.a)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:150px">
        <button class="btn btn-outline" style="padding:4px 8px;font-size:.7rem" onclick="A.lbmTick('${esc(r.id)}',${!isV})">${isV ? 'Tick OFF' : 'Blue tick'}</button>
        <button class="btn btn-outline" style="padding:4px 8px;font-size:.7rem" onclick="A.lbmEdit('${esc(r.id)}')">Edit ₹</button>
        <button class="btn btn-outline" style="padding:4px 8px;font-size:.7rem" onclick="A.lbmRemove('${esc(r.id)}')">Remove</button>
        ${isH ? '' : `<button class="btn btn-danger" style="padding:4px 8px;font-size:.7rem" onclick="A.lbmHide('${esc(r.id)}')">Hide</button>`}
      </div></div>`;
  }).join('') : '<span class="muted">No winners on this board.</span>';
  paintHidden(); paintTrash(); paintFound();
};

const keySet = () => Object.values(keysNow());
const label = () => ({ d: 'Today', w: 'This week', m: 'This month' })[period];

// name + Player ID for hidden accounts (looked up once)
const loadName = async (uid) => {
  if (names[uid] !== undefined) return; names[uid] = null;
  try { const x = await getDoc(doc(db, 'users', uid)); if (x.exists()) { const u = x.data(); names[uid] = { n: u.appName || u.gameName || u.name || 'User', pid: u.playerId || '' }; paintHidden(); } } catch (e) {}
};
const paintHidden = () => {
  const el = $('lbm-hidden'); if (!el) return;
  el.innerHTML = hidden.length ? hidden.map(u => { loadName(u); const x = names[u];
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0"><div style="flex:1;min-width:0"><div style="font-weight:700;font-size:.85rem">${esc(x ? x.n : 'User')}${x && x.pid ? ' · ID ' + esc(x.pid) : ''}</div><div class="muted" style="font-size:.7rem;word-break:break-all">${esc(u)}</div></div><button class="btn btn-outline" style="padding:4px 10px;font-size:.72rem" onclick="A.lbmUnhide('${esc(u)}')">Show again</button></div>`; }).join('') : '<span class="muted">—</span>';
};

// recently removed (so a wrong Remove / Hide can be undone)
const trashView = () => trash.filter(t => keySet().includes(t.k)).sort((a, b) => b.at - a.at);
const paintTrash = () => {
  const el = $('lbm-trash'); if (!el) return; const v = trashView(); const nm = { d: 'Today', w: 'Week', m: 'Month' };
  el.innerHTML = v.length ? v.map(t => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#eee)">
      <div style="flex:1;min-width:0"><div style="font-weight:700">${esc(t.n)} <span class="muted" style="font-weight:600">· ${nm[t.k[0]] || ''} board</span></div><div class="muted" style="font-size:.7rem;word-break:break-all">${esc(t.uid)}</div></div>
      <div style="font-weight:800;white-space:nowrap">${inr(t.a)}</div>
      <button class="btn btn-primary" style="padding:5px 10px;font-size:.72rem" onclick="A.lbmRestore('${esc(t.uid)}','${esc(t.k)}')">Restore</button></div>`).join('') : '<span class="muted">Nothing removed recently.</span>';
};
const writeTrash = async (fn) => {
  const x = await getDoc(doc(db, 'config', 'lbTrash')); const cur = (x.exists() && x.data().items) || [], live = keySet();
  await setDoc(doc(db, 'config', 'lbTrash'), { items: fn(cur).filter(t => live.includes(t.k)).slice(-40), updatedAt: Date.now() });
};
const saveTrash = async (uid, keys) => {
  const add = [];
  for (const k of keys) { try { const x = await getDoc(doc(db, 'lb', k)); const e = x.exists() && x.data().players && x.data().players[uid]; if (e && Number(e.a) > 0) add.push({ uid, k, n: e.n || 'User', a: Number(e.a), p: e.p || '', at: Date.now() }); } catch (err) {} }
  if (add.length) await writeTrash(items => items.filter(t => !add.some(a => a.uid === t.uid && a.k === t.k)).concat(add));
};

// "Add / edit a top player" card
const paintFound = () => {
  const el = $('lbm-found'); if (!el) return;
  if (!found) { el.innerHTML = ''; return; }
  const cur = players[found.uid];
  el.innerHTML = `<div style="background:var(--bg,#f6f7fb);border-radius:10px;padding:10px;font-size:.82rem;margin-bottom:10px">
    <b>${esc(found.n)}</b>${found.pid ? ' · Player ID ' + esc(found.pid) : ''}<div class="muted" style="font-size:.7rem;word-break:break-all">${esc(found.uid)}</div>
    ${cur ? `<div style="margin-top:4px">On the ${label()} board now: <b>${inr(cur.a)}</b></div>` : ''}
    ${hidden.includes(found.uid) ? '<div style="margin-top:4px;color:#dc2626"><b>Hidden account</b> — it will be shown again when you save.</div>' : ''}</div>`;
};
const syncChecks = () => ['d', 'w', 'm'].forEach(p => { const c = $('lbm-sp-' + p); if (c) c.checked = (p === period); });
const listen = () => {
  unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = [];
  unsubs.push(onSnapshot(doc(db, 'lb', keysNow()[period]), (s) => { players = (s.exists() && s.data().players) || {}; paint(); }));
  unsubs.push(onSnapshot(doc(db, 'config', 'leaderboard'), (s) => { hidden = (s.exists() && s.data().hidden) || []; paint(); }));
  unsubs.push(onSnapshot(doc(db, 'config', 'lbTrash'), (x) => { trash = (x.exists() && x.data().items) || []; paintTrash(); }));
  unsubs.push(onSnapshot(doc(db, 'config', 'verified'), (s) => { ver = new Set(s.exists() ? (s.data().uids || []) : []); paint(); }));
};
const removeFrom = async (uid, keys) => { for (const k of keys) { try { await updateDoc(doc(db, 'lb', k), { ['players.' + uid]: deleteField() }); } catch (e) { /* board may not exist */ } } };

Object.assign(window.A, {
  async lbmFind() {
    const q = ($('lbm-find').value || '').trim(); if (!q) return A.toast('Enter a Player ID or UID', 'err');
    try {
      let uid = null, u = null;
      if (q.length >= 20) { const x = await getDoc(doc(db, 'users', q)); if (x.exists()) { uid = x.id; u = x.data(); } }
      if (!u) { const r = await getDocs(query(collection(db, 'users'), where('playerId', '==', q), limit(1))); if (!r.empty) { uid = r.docs[0].id; u = r.docs[0].data(); } }
      if (!u) { found = null; $('lbm-found').innerHTML = '<div style="color:#dc2626;font-size:.82rem;margin-bottom:10px">No player found for ' + esc(q) + '</div>'; return; }
      found = { uid, n: u.appName || u.gameName || u.name || 'User', pid: u.playerId || '', p: u.photoUrl || '' };
      paintFound(); $('lbm-amt').focus();
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async lbmSet() {
    if (!found) return A.toast('Find a player first', 'err');
    const amt = Math.round(Number($('lbm-amt').value) * 100) / 100;
    if (!(amt > 0)) return A.toast('Enter an amount above 0', 'err');
    const kk = keysNow(), sel = ['d', 'w', 'm'].filter(p => $('lbm-sp-' + p).checked);
    if (!sel.length) return A.toast('Select Today / This week / This month', 'err');
    const names2 = sel.map(p => ({ d: 'Today', w: 'This week', m: 'This month' })[p]).join(', ');
    if (!confirm('Put ' + found.n + ' on the leaderboard with ' + inr(amt) + ' (' + names2 + ')?\nThe top order follows this amount.')) return;
    try {
      if (hidden.includes(found.uid)) await updateDoc(doc(db, 'config', 'leaderboard'), { hidden: arrayRemove(found.uid) });
      const e = { n: found.n, a: amt }; if (found.p) e.p = found.p;
      for (const p of sel) await setDoc(doc(db, 'lb', kk[p]), { players: { [found.uid]: e }, updatedAt: Date.now() }, { merge: true });
      A.toast('Leaderboard updated ✓'); $('lbm-amt').value = '';
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async lbmEdit(uid) {
    const cur = players[uid]; if (!cur) return;
    const v = prompt('New amount (₹) for ' + (cur.n || 'User') + ' on the ' + label() + ' board:', cur.a); if (v === null) return;
    const amt = Math.round(Number(v) * 100) / 100;
    if (!(amt > 0)) return A.toast('Enter an amount above 0 (use Remove to delete)', 'err');
    try { await updateDoc(doc(db, 'lb', keysNow()[period]), { ['players.' + uid + '.a']: amt, updatedAt: Date.now() }); A.toast('Amount updated ✓'); }
    catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async lbmRestore(uid, k) {
    const t = trash.find(x => x.uid === uid && x.k === k); if (!t) return;
    try {
      if (hidden.includes(uid)) { if (!confirm('This account is hidden. Show it again and restore?')) return; await updateDoc(doc(db, 'config', 'leaderboard'), { hidden: arrayRemove(uid) }); }
      const e = { n: t.n, a: Number(t.a) }; if (t.p) e.p = t.p;
      await setDoc(doc(db, 'lb', k), { players: { [uid]: e }, updatedAt: Date.now() }, { merge: true });
      await writeTrash(items => items.filter(x => !(x.uid === uid && x.k === k)));
      A.toast('Restored ✓');
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  lbmLoad() { syncChecks(); listen(); },
  lbmPeriod(p) { period = p; players = {}; syncChecks(); listen(); },
  async lbmRemove(uid) {
    if (!confirm('Remove this player from the ' + ({ d: 'today', w: 'week', m: 'month' })[period] + ' board?')) return;
    try { await saveTrash(uid, [keysNow()[period]]); await removeFrom(uid, [keysNow()[period]]); A.toast('Removed ✓ — you can bring it back from "Recently removed"'); } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async lbmHide(uid) {
    if (!confirm('HIDE this account for good? It disappears from today / week / month, never shows again and never gets the monthly reward.')) return;
    try {
      await saveTrash(uid, keySet());
      await setDoc(doc(db, 'config', 'leaderboard'), { hidden: arrayUnion(uid), updatedAt: Date.now() }, { merge: true });
      await removeFrom(uid, Object.values(keysNow())); A.toast('Hidden ✓');
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async lbmHideInput() {
    const uid = ($('lbm-uid').value || '').trim(); if (!uid) return A.toast('Enter a UID', 'err');
    await A.lbmHide(uid); $('lbm-uid').value = '';
  },
  async lbmUnhide(uid) {
    try { await updateDoc(doc(db, 'config', 'leaderboard'), { hidden: arrayRemove(uid) }); A.toast('Visible again ✓'); } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async lbmTick(uid, on) {
    try { await A.api('/api/chatadm/verify', { body: { uid, verified: !!on } }); A.toast(on ? 'Blue tick ON ✓' : 'Blue tick OFF ✓'); }
    catch (e) { A.toast('Error: ' + (e.message || e), 'err'); }
  }
});
