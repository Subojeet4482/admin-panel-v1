// Leaderboard manager: remove test entries, hide admin/test accounts for good, blue tick ON/OFF.
// Data: lb/{d|w|m}-{key}.players = { uid: { n, a, p?, g? } }   ·   hidden accounts: config/leaderboard.hidden = [uid]   ·   blue ticks: config/verified.uids
import { db, doc, getDoc, setDoc, updateDoc, onSnapshot, deleteField, arrayUnion, arrayRemove } from './firebase.js';
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
let period = 'd', players = {}, hidden = [], ver = new Set(), unsubs = [];

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
        <button class="btn btn-outline" style="padding:4px 8px;font-size:.7rem" onclick="A.lbmRemove('${esc(r.id)}')">Remove</button>
        ${isH ? '' : `<button class="btn btn-danger" style="padding:4px 8px;font-size:.7rem" onclick="A.lbmHide('${esc(r.id)}')">Hide</button>`}
      </div></div>`;
  }).join('') : '<span class="muted">No winners on this board.</span>';
  $('lbm-hidden').innerHTML = hidden.length ? hidden.map(u => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0"><span style="flex:1;word-break:break-all;font-size:.8rem">${esc(u)}</span><button class="btn btn-outline" style="padding:4px 10px;font-size:.72rem" onclick="A.lbmUnhide('${esc(u)}')">Show again</button></div>`).join('') : '<span class="muted">No hidden accounts.</span>';
};
const listen = () => {
  unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = [];
  unsubs.push(onSnapshot(doc(db, 'lb', keysNow()[period]), (s) => { players = (s.exists() && s.data().players) || {}; paint(); }));
  unsubs.push(onSnapshot(doc(db, 'config', 'leaderboard'), (s) => { hidden = (s.exists() && s.data().hidden) || []; paint(); }));
  unsubs.push(onSnapshot(doc(db, 'config', 'verified'), (s) => { ver = new Set(s.exists() ? (s.data().uids || []) : []); paint(); }));
};
const removeFrom = async (uid, keys) => { for (const k of keys) { try { await updateDoc(doc(db, 'lb', k), { ['players.' + uid]: deleteField() }); } catch (e) { /* board may not exist */ } } };

Object.assign(window.A, {
  lbmLoad() { listen(); },
  lbmPeriod(p) { period = p; players = {}; listen(); },
  async lbmRemove(uid) {
    if (!confirm('Remove this player from the ' + ({ d: 'today', w: 'week', m: 'month' })[period] + ' board?')) return;
    try { await removeFrom(uid, [keysNow()[period]]); A.toast('Removed ✓'); } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async lbmHide(uid) {
    if (!confirm('HIDE this account for good? It disappears from today / week / month, never shows again and never gets the monthly reward.')) return;
    try {
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
