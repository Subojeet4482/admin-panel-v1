// Gift codes (admin): fixed / random amount, auto / manual 24-char code, max users, validity, DP / WD, revoke
import { db, doc, getDoc, setDoc, getDocs, updateDoc, deleteDoc, collection } from './firebase.js';
const $ = (id) => document.getElementById(id);
const esc = A.esc;
const G = { type: 'fix', code: 'auto', bal: 'deposit', timer: null };
const SYM = '!@#$%^&*-_+=?';
const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
const genCode = () => {                                    // 24 chars with upper + lower + digit + symbol
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', D = '23456789', ALL = U + L + D + SYM;
  const c = [U[rnd(U.length)], L[rnd(L.length)], D[rnd(D.length)], SYM[rnd(SYM.length)]];
  while (c.length < 24) c.push(ALL[rnd(ALL.length)]);
  for (let i = c.length - 1; i > 0; i--) { const j = rnd(i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  return c.join('');
};
const left = (ms) => { if (ms <= 0) return 'expired'; const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3); return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm ' + (d ? '' : s + 's'); };

Object.assign(window.A, {
  gfType(t) { G.type = t; $('gf-t-fix').classList.toggle('on', t === 'fix'); $('gf-t-rnd').classList.toggle('on', t === 'random'); $('gf-amt-fix').classList.toggle('hidden', t !== 'fix'); $('gf-amt-rnd').classList.toggle('hidden', t !== 'random'); },
  gfCode(m) { G.code = m; $('gf-c-auto').classList.toggle('on', m === 'auto'); $('gf-c-man').classList.toggle('on', m === 'manual'); const i = $('gf-code'); i.readOnly = m === 'auto'; if (m === 'auto') i.value = genCode(); else i.value = ''; A.gfCount(); },
  gfGen() { $('gf-code').value = genCode(); A.gfCount(); },
  gfCount() { const n = $('gf-code').value.length; $('gf-count').innerHTML = `${n} / 24 ${n === 24 ? '<span class="tag green">ready</span>' : ''}`; },
  gfBal(b) { G.bal = b; $('gf-b-dep').classList.toggle('on', b === 'deposit'); $('gf-b-wd').classList.toggle('on', b === 'withdraw'); },
  async gfCreate() {
    const code = $('gf-code').value; if (code.length !== 24 || /\s/.test(code)) return A.toast('Code must be exactly 24 characters (no spaces)', 'err');
    const max = Math.floor(Number($('gf-max-users').value)); if (!(max >= 1 && max <= 2000)) return A.toast('Users: 1 to 2000', 'err');
    const mins = Number($('gf-valid').value) * Number($('gf-unit').value); if (!(mins > 0)) return A.toast('Enter validity time', 'err');
    let pool = [], label = '';
    if (G.type === 'fix') { const a = Math.round(Number($('gf-fix').value) * 100) / 100; if (!(a > 0)) return A.toast('Enter the fixed amount', 'err'); pool = Array(max).fill(a); label = '₹' + a; }
    else { const lo = Math.floor(Number($('gf-min').value)), hi = Math.floor(Number($('gf-max').value)); if (!(lo >= 1 && hi >= lo)) return A.toast('Enter min and max (max ≥ min)', 'err'); pool = Array.from({ length: max }, () => lo + rnd(hi - lo + 1)); label = `₹${lo}–₹${hi}`; }
    const h = await sha(code);
    if ((await getDoc(doc(db, 'gift_codes', h))).exists()) return A.toast('This code already exists', 'err');
    if (!confirm(`Create gift code?\n${label} · ${max} user(s) · ${G.bal === 'deposit' ? 'Deposit' : 'Withdrawal'} balance`)) return;
    try {
      await setDoc(doc(db, 'gift_codes', h), { code, status: 'active', type: G.type, label, pool, max, used: 0, balance: G.bal, expiresAt: Date.now() + mins * 1000, createdAt: Date.now(), note: $('gf-note').value.trim() });
      A.copyText(code); A.toast('Gift code created & copied 🎁'); A.gfCode('auto'); $('gf-note').value = ''; A.gfLoad();
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async gfLoad() {
    if (!$('gf-code').value) A.gfCode(G.code);
    const box = $('gf-list'); clearInterval(G.timer);
    try {
      const s = await getDocs(collection(db, 'gift_codes')); const arr = []; s.forEach(d => arr.push({ id: d.id, ...d.data() }));
      arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      box.innerHTML = arr.length ? arr.map((c, i) => {
        const st = c.status === 'revoked' ? 'revoked' : c.expiresAt < Date.now() ? 'expired' : (c.used >= c.max ? 'full' : 'active');
        return `<div class="card gf-card ${st} fade-up" style="animation-delay:${Math.min(i, 8) * 40}ms">
          <div class="gf-top"><span class="gf-code" onclick="A.copyText('${esc(c.code).replace(/'/g, "\\'")}')" title="Copy">${esc(c.code)} <i class="fa-regular fa-copy"></i></span><span class="st st-${st === 'active' ? 'success' : st === 'revoked' ? 'failed' : 'pending'}">${st}</span></div>
          <div class="gf-meta"><span class="tag">${c.type === 'fix' ? 'Fixed' : 'Random'} ${esc(c.label || '')}</span><span class="tag ${c.balance === 'withdraw' ? 'gold' : ''}">${c.balance === 'withdraw' ? 'WD' : 'DP'} balance</span>${c.note ? `<span class="tag">${esc(c.note)}</span>` : ''}</div>
          <div class="gf-bar"><i style="width:${Math.min(100, (c.used || 0) / c.max * 100)}%"></i></div>
          <div class="gf-row"><span>${c.used || 0} / ${c.max} used</span><span class="gf-left" data-t="${c.expiresAt}" data-s="${st}">${st === 'revoked' ? 'revoked' : left(c.expiresAt - Date.now())}</span></div>
          <div class="btn-row"><button class="btn btn-outline" style="flex:1;" onclick="A.gfUsers('${c.id}')"><i class="fa-solid fa-users"></i> Redeemed</button>
          ${st === 'active' ? `<button class="btn btn-danger" style="flex:1;" onclick="A.gfRevoke('${c.id}')"><i class="fa-solid fa-ban"></i> Revoke</button>` : ''}
          <button class="btn btn-outline" onclick="A.gfDel('${c.id}')"><i class="fa-solid fa-trash"></i></button></div>
          <div id="gfu-${c.id}"></div></div>`;
      }).join('') : '<div class="empty-box" style="padding:24px;">No gift codes yet</div>';
      G.timer = setInterval(() => document.querySelectorAll('.gf-left').forEach(e => { if (e.dataset.s === 'active') e.textContent = left(Number(e.dataset.t) - Date.now()); }), 1000);
    } catch (e) { box.innerHTML = '<p style="color:red">Error: ' + esc(e.message) + '</p>'; }
  },
  async gfRevoke(id) { if (!confirm('Revoke this code? Nobody can redeem it any more.')) return; await updateDoc(doc(db, 'gift_codes', id), { status: 'revoked', revokedAt: Date.now() }); A.toast('Revoked'); A.gfLoad(); },
  async gfDel(id) { if (!confirm('Delete this code and its redeem history?')) return; try { const r = await getDocs(collection(db, 'gift_codes', id, 'redeems')); for (const d of r.docs) await deleteDoc(d.ref); await deleteDoc(doc(db, 'gift_codes', id)); A.toast('Deleted'); A.gfLoad(); } catch (e) { A.toast(e.message, 'err'); } },
  async gfUsers(id) {
    const box = $('gfu-' + id); if (box.innerHTML) { box.innerHTML = ''; return; }
    const r = await getDocs(collection(db, 'gift_codes', id, 'redeems')); const a = []; r.forEach(d => a.push({ id: d.id, ...d.data() })); a.sort((x, y) => y.at - x.at);
    box.innerHTML = a.length ? '<div class="gf-users">' + a.map(u => `<div><b>${esc(u.name || 'User')}</b> <small>${esc(u.id.slice(0, 8))}</small><span>₹${u.amount}</span><small>${esc(u.orderNo || '')}</small></div>`).join('') + '</div>' : '<div class="muted" style="padding:8px;">Nobody has used it yet.</div>';
  }
});
