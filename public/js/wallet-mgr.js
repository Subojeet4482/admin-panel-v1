// Wallet Manager: find user by name/ID -> add (+) / cut (−) Deposit or Withdrawal balance, and a Money Ledger
// where EVERY money movement has an order number (deposit, withdrawal, admin add/cut, prize, refund, match entry).
import { db, collection, collectionGroup, getDocs, doc, getDoc, runTransaction } from './firebase.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + (Number(n) || 0).toFixed(2).replace(/\.00$/, '');
const num = (v) => parseFloat(String(v || 0).replace(/[^0-9.]/g, '')) || 0;

const KIND = {
  DP: { label: 'Deposit', cls: 'k-dp', ico: 'fa-arrow-down' }, WD: { label: 'Withdrawal', cls: 'k-wd', ico: 'fa-arrow-up' },
  AD: { label: 'Admin Add', cls: 'k-ad', ico: 'fa-plus' }, AC: { label: 'Admin Cut', cls: 'k-ac', ico: 'fa-minus' },
  PZ: { label: 'Prize', cls: 'k-pz', ico: 'fa-trophy' }, RF: { label: 'Refund', cls: 'k-rf', ico: 'fa-rotate-left' },
  GM: { label: 'Match Entry', cls: 'k-gm', ico: 'fa-gamepad' }, GF: { label: 'Gift Code', cls: 'k-gf', ico: 'fa-gift' }
};
const M = { users: [], user: null, type: 'deposit', mode: 'add', trx: [], filter: 'ALL', uidFilter: '', loaded: false, shown: 120 };

// ---- ORDER NUMBERS (same formula as the user app) ----
A._kindOf = function (t) {
  const k = t.kind; const title = String(t.title || ''), type = String(t.type || '');
  if (k === 'admin_add') return 'AD'; if (k === 'admin_cut') return 'AC'; if (k === 'prize') return 'PZ'; if (k === 'refund') return 'RF'; if (k === 'gift') return 'GF';
  if (type === 'game') return 'GM'; if (type === 'refund') return 'RF';
  if (/^Match win/i.test(title)) return 'PZ';
  if (/^(System .* add|Admin credit|🎁)/i.test(title)) return 'AD';
  if (/^(System .* cut|Admin deduct)/i.test(title)) return 'AC';
  return type === 'withdraw' ? 'WD' : 'DP';
};
A._orderNum = function (t, docId, createdAt) {
  if (t && t.orderNo) return t.orderNo;
  const p = A._kindOf(t || {});
  const ms = createdAt || (t && (t.createdAt || (t.timestamp && t.timestamp.seconds * 1000) || Date.parse(t.date))) || Date.now();
  const d = new Date(ms);
  const ymd = d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const id = String(docId || 'XXXXXX');
  return `${p}-${ymd}-${id.slice(-(p === 'DP' || p === 'WD' ? 4 : 6)).toUpperCase()}`;
};

Object.assign(A, {
  /* ================= tab ================= */
  async moneyOpen() { if (!M.users.length) await A.moneyLoadUsers(); },
  async moneyLoadUsers() {
    try { const s = await getDocs(collection(db, 'users')); M.users = []; s.forEach(d => M.users.push({ id: d.id, ...d.data() })); } catch (e) { A.toast('Users load error: ' + e.message, 'err'); }
  },
  moneySub(w) {
    $('mg-t-adj').classList.toggle('on', w === 'adj'); $('mg-t-led').classList.toggle('on', w === 'led');
    $('mg-adj').classList.toggle('hidden', w !== 'adj'); $('mg-led').classList.toggle('hidden', w !== 'led');
    if (w === 'led') A.ledgerLoad(false);
  },
  async openLedger() { A.goTab('money'); A.moneySub('led'); },

  /* ================= find user ================= */
  moneySearch(q) {
    q = String(q || '').trim().toLowerCase(); const box = $('mg-results');
    if (!q) { box.innerHTML = ''; return; }
    const hit = M.users.filter(u => [u.appName, u.playerId, u.gameUid, u.gameName, u.phone, u.email, u.id].some(v => v && String(v).toLowerCase().includes(q))).slice(0, 8);
    box.innerHTML = hit.length ? hit.map((u, i) => `<div class="mg-res" style="animation-delay:${i * 35}ms" onclick="A.moneyPick('${esc(u.id)}')">
        <div class="mg-av">${esc((u.appName || '?').slice(0, 1).toUpperCase())}</div>
        <div class="mg-rt"><b>${esc(u.appName || 'No name')}</b><small>ID ${esc(u.playerId || '—')} · FF ${esc(u.gameUid || '—')} · ${esc(u.id.slice(0, 8))}</small></div>
        <div class="mg-rb">${money(A._bal(u).dep + A._bal(u).wd)}</div></div>`).join('')
      : '<div class="muted" style="padding:10px;">No user found</div>';
  },
  _bal(u) { return { dep: u.depositBalance !== undefined ? Number(u.depositBalance) : Number(u.balance || 0), wd: Number(u.withdrawBalance || 0) }; },
  async moneyPick(uid) {
    if (!M.users.length) await A.moneyLoadUsers();
    let u = M.users.find(x => x.id === uid);
    try { const s = await getDoc(doc(db, 'users', uid)); if (s.exists()) { u = { id: uid, ...s.data() }; const i = M.users.findIndex(x => x.id === uid); if (i >= 0) M.users[i] = u; else M.users.push(u); } } catch (e) {}
    if (!u) return A.toast('User not found', 'err');
    M.user = u; $('mg-results').innerHTML = ''; $('mg-q').value = '';
    const b = A._bal(u);
    const cp = (v) => `<button class="copy-btn" onclick="A.copyText('${esc(v)}')"><i class="fa-regular fa-copy"></i></button>`;
    $('mg-user').style.display = 'block';
    $('mg-user').innerHTML = `<div class="mgu-top"><div class="mg-av big">${esc((u.appName || '?').slice(0, 1).toUpperCase())}</div>
      <div style="flex:1;min-width:0;"><div class="mgu-name">${esc(u.appName || 'No name')} ${u.isVerified ? '<i class="fa-solid fa-circle-check" style="color:#1d9bf0"></i>' : ''} ${u.isBanned ? '<span class="tag red">BANNED</span>' : ''}</div>
      <div class="mgu-sub">Player ID: <b>${esc(u.playerId || '—')}</b> ${u.playerId ? cp(u.playerId) : ''}</div>
      <div class="mgu-sub">FF UID: <b>${esc(u.gameUid || '—')}</b> ${u.gameUid ? cp(u.gameUid) : ''} · ${esc(u.gameName || '')}</div>
      <div class="mgu-sub">UID: <b>${esc(uid)}</b> ${cp(uid)}</div></div></div>
      <div class="mgu-bal"><div><small>Deposit</small><b>${money(b.dep)}</b></div><div><small>Withdrawal</small><b>${money(b.wd)}</b></div><div class="tot"><small>Total</small><b>${money(b.dep + b.wd)}</b></div></div>
      <div class="btn-row" style="margin-top:10px;"><button class="btn btn-outline" style="flex:1;" onclick="A.ledgerForUser('${esc(uid)}')"><i class="fa-solid fa-receipt"></i> View ledger</button></div>`;
    $('mg-form').style.display = 'block';
    $('bt-dep-v').innerText = money(b.dep); $('bt-wd-v').innerText = money(b.wd);
    $('mg-done').innerHTML = ''; $('mg-amt').value = ''; $('mg-note').value = '';
    A.moneyPreview();
  },
  async moneyFromUser() { const uid = $('u-id').value; A.closeModal('m-user'); A.goTab('money'); A.moneySub('adj'); await A.moneyOpen(); A.moneyPick(uid); },

  /* ================= add / cut ================= */
  moneyType(t) { M.type = t; $('bt-deposit').classList.toggle('on', t === 'deposit'); $('bt-withdraw').classList.toggle('on', t === 'withdraw'); A.moneyPreview(); },
  moneyMode(m) { M.mode = m; $('pm-add').classList.toggle('on', m === 'add'); $('pm-cut').classList.toggle('on', m === 'cut'); A.moneyPreview(); },
  moneyQuick(v) {
    const b = M.user ? A._bal(M.user) : { dep: 0, wd: 0 };
    const inp = $('mg-amt'); inp.value = v === 'all' ? (M.type === 'withdraw' ? b.wd : b.dep) : (Number(inp.value || 0) + v);
    A.moneyPreview();
  },
  moneyPreview() {
    const box = $('mg-preview'), btn = $('mg-go'); if (!M.user) return;
    const b = A._bal(M.user), cur = M.type === 'withdraw' ? b.wd : b.dep, amt = parseFloat($('mg-amt').value) || 0;
    const after = M.mode === 'add' ? cur + amt : cur - amt, bad = M.mode === 'cut' && amt > cur;
    const lbl = M.type === 'withdraw' ? 'Withdrawal balance' : 'Deposit balance';
    box.className = 'mg-preview ' + (M.mode === 'add' ? 'up' : 'down') + (bad ? ' bad' : '');
    box.innerHTML = amt > 0 ? `<span>${lbl}</span><b>${money(cur)}</b><i class="fa-solid fa-arrow-right"></i><b class="res">${money(after)}</b>${bad ? '<em>User has only ' + money(cur) + '</em>' : ''}` : `<span>${lbl}: <b>${money(cur)}</b></span>`;
    btn.className = 'btn btn-full ' + (M.mode === 'add' ? 'btn-success' : 'btn-danger');
    btn.innerHTML = M.mode === 'add' ? `<i class="fa-solid fa-plus"></i> Add ${amt > 0 ? money(amt) : ''}` : `<i class="fa-solid fa-minus"></i> Cut ${amt > 0 ? money(amt) : ''}`;
    btn.disabled = !(amt > 0) || bad;
  },
  async moneyApply() {
    const u = M.user; if (!u) return A.toast('Select a user first', 'err');
    const amt = Math.round((parseFloat($('mg-amt').value) || 0) * 100) / 100;
    if (!(amt > 0)) return A.toast('Enter amount', 'err');
    const note = $('mg-note').value.trim();
    const add = M.mode === 'add', wd = M.type === 'withdraw';
    const field = wd ? 'withdrawBalance' : 'depositBalance', label = wd ? 'withdrawal' : 'deposit';
    if (!confirm(`${add ? 'ADD' : 'CUT'} ${money(amt)} ${add ? 'to' : 'from'} ${u.appName || 'user'} — ${label} balance?`)) return;
    const uref = doc(db, 'users', u.id), tref = doc(collection(db, 'users', u.id, 'transactions')), nref = doc(collection(db, 'users', u.id, 'notifications'));
    const now = Date.now(), kind = add ? 'admin_add' : 'admin_cut';
    const orderNo = A._orderNum({ kind }, tref.id, now);
    const date = new Date().toLocaleDateString();
    try {
      await runTransaction(db, async (tx) => {
        const s = await tx.get(uref); const d = s.exists() ? s.data() : {};
        const cur = field === 'depositBalance' ? (d.depositBalance !== undefined ? Number(d.depositBalance) : Number(d.balance || 0)) : Number(d.withdrawBalance || 0);
        if (!add && cur + 0.0001 < amt) throw new Error(`User only has ${money(cur)} in ${label} balance`);
        const upd = { [field]: Math.round((cur + (add ? amt : -amt)) * 100) / 100 };
        if (add && !wd) upd.totalDeposited = Number(d.totalDeposited || 0) + amt;
        if (!add && wd) upd.totalWithdrawn = Number(d.totalWithdrawn || 0) + amt;
        if (!s.exists()) throw new Error('User document not found');
        tx.update(uref, upd);
        const title = add ? `Admin credit: ₹${amt}` : `Admin deduction: ₹${amt}`;
        tx.set(tref, { title, amount: `${add ? '+' : '-'}₹${amt}`, type: add ? 'deposit' : 'withdraw', status: 'success', kind, orderNo, balanceType: wd ? 'withdraw' : 'deposit', by: 'admin', note, date, createdAt: now });
        tx.set(nref, { title: add ? `🎁 ₹${amt} added by Admin` : `₹${amt} deducted by Admin`, message: `Order ${orderNo} • ${add ? 'Added to' : 'Deducted from'} your ${label} balance.${note ? ' Reason: ' + note : ''}`, date, timestamp: new Date() });
      });
    } catch (e) { return A.toast(e.message, 'err'); }
    await A.moneyPick(u.id);
    $('mg-done').innerHTML = `<div class="mg-ok ${add ? 'up' : 'down'}"><div class="mg-ok-ico"><i class="fa-solid ${add ? 'fa-check' : 'fa-minus'}"></i></div>
      <div><b>${add ? 'Added' : 'Cut'} ${money(amt)}</b><small>${esc(u.appName || '')} · ${label} balance</small></div>
      <div class="mg-ord"><small>ORDER NO</small><span>${esc(orderNo)}</span><button class="copy-btn" onclick="A.copyText('${esc(orderNo)}')"><i class="fa-regular fa-copy"></i> Copy</button></div></div>`;
    A.toast('Done · ' + orderNo);
    M.loaded = false;   // ledger reloads next time
  },

  /* ================= LEDGER ================= */
  async ledgerLoad(force) {
    if (!M.users.length) await A.moneyLoadUsers();
    if (M.loaded && !force) { A.ledgerRender(); return; }
    $('lg-list').innerHTML = '<div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i>Loading ledger…</div>';
    try {
      const s = await getDocs(collectionGroup(db, 'transactions'));
      M.trx = [];
      s.forEach(d => {
        const t = d.data(); const uid = d.ref.parent.parent ? d.ref.parent.parent.id : '?';
        const ms = t.createdAt || (t.timestamp && t.timestamp.seconds * 1000) || Date.parse(t.date) || 0;
        const raw = String(t.amount == null ? '' : t.amount), neg = raw.trim().startsWith('-');
        const k = A._kindOf(t);
        M.trx.push({ id: d.id, uid, t, ms, k, order: A._orderNum(t, d.id, ms), amt: (neg ? -1 : 1) * num(raw) });
      });
      M.trx.sort((a, b) => b.ms - a.ms); M.loaded = true; M.shown = 120;
      A.ledgerRender();
    } catch (e) { $('lg-list').innerHTML = `<div class="muted" style="padding:16px;">Error: ${esc(e.message)}</div>`; }
  },
  ledgerForUser(uid) { M.uidFilter = uid; A.moneySub('led'); },
  ledgerClearUser() { M.uidFilter = ''; A.ledgerRender(); },
  ledgerFilter(k) { M.filter = k; M.shown = 120; A.ledgerRender(); },
  ledgerMore() { M.shown += 120; A.ledgerRender(); },
  _uname(uid) { const u = M.users.find(x => x.id === uid); return u ? (u.appName || 'No name') : 'Unknown'; },
  ledgerRender() {
    const q = ($('lg-q').value || '').trim().toLowerCase();
    // chips
    const counts = { ALL: 0 }; M.trx.forEach(r => { if (!M.uidFilter || r.uid === M.uidFilter) { counts.ALL++; counts[r.k] = (counts[r.k] || 0) + 1; } });
    $('lg-chips').innerHTML = [['ALL', 'All', '']].concat(Object.keys(KIND).map(k => [k, KIND[k].label, KIND[k].cls])).map(([k, l, c]) =>
      `<button type="button" class="chip ${M.filter === k ? 'active' : ''} ${c}" onclick="A.ledgerFilter('${k}')">${l} <i>${counts[k] || 0}</i></button>`).join('');
    const up = $('lg-user');
    if (M.uidFilter) { up.style.display = 'flex'; up.innerHTML = `<i class="fa-solid fa-user"></i><b>${esc(A._uname(M.uidFilter))}</b><small>${esc(M.uidFilter.slice(0, 10))}…</small><button onclick="A.ledgerClearUser()"><i class="fa-solid fa-xmark"></i></button>`; } else up.style.display = 'none';
    let rows = M.trx.filter(r => (!M.uidFilter || r.uid === M.uidFilter) && (M.filter === 'ALL' || r.k === M.filter));
    if (q) rows = rows.filter(r => r.order.toLowerCase().includes(q) || r.uid.toLowerCase().includes(q) || A._uname(r.uid).toLowerCase().includes(q) || String(r.t.trxId || '').toLowerCase().includes(q) || String(r.t.note || '').toLowerCase().includes(q)
      || (() => { const u = M.users.find(x => x.id === r.uid); return u && ((u.playerId && String(u.playerId).toLowerCase().includes(q)) || (u.gameUid && String(u.gameUid).includes(q))); })());
    const ok = rows.filter(r => !['failed', 'rejected', 'cancelled'].includes(r.t.status) && r.t.status !== 'pending');
    const inn = ok.filter(r => r.amt > 0).reduce((a, r) => a + r.amt, 0), out = ok.filter(r => r.amt < 0).reduce((a, r) => a + r.amt, 0);
    $('lg-sum').innerHTML = `<div><small>Entries</small><b>${rows.length}</b></div><div class="in"><small>Money in</small><b>${money(inn)}</b></div><div class="out"><small>Money out</small><b>${money(Math.abs(out))}</b></div><div><small>Net</small><b>${money(inn + out)}</b></div>`;
    const list = $('lg-list');
    if (!rows.length) { list.innerHTML = '<div class="empty-box" style="padding:24px;">No entries</div>'; return; }
    list.innerHTML = rows.slice(0, M.shown).map((r, i) => {
      const K = KIND[r.k] || KIND.DP, t = r.t, st = t.status || 'success', pos = r.amt >= 0;
      const when = r.ms ? new Date(r.ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : (t.date || '');
      return `<div class="lg-row ${K.cls}" style="animation-delay:${Math.min(i, 12) * 25}ms">
        <div class="lg-ico"><i class="fa-solid ${K.ico}"></i></div>
        <div class="lg-mid">
          <div class="lg-ord" onclick="A.copyText('${esc(r.order)}')" title="Copy order no">${esc(r.order)} <i class="fa-regular fa-copy"></i></div>
          <div class="lg-user" onclick="A.ledgerForUser('${esc(r.uid)}')"><b>${esc(A._uname(r.uid))}</b> <small>${esc(r.uid.slice(0, 8))}</small></div>
          <div class="lg-meta"><span class="tag">${K.label}</span> <span class="st st-${esc(st)}">${esc(st)}</span> ${t.method ? '<span class="tag">' + esc(t.method) + '</span>' : ''} ${t.balanceType ? '<span class="tag">' + esc(t.balanceType) + ' bal</span>' : ''} · ${esc(when)}</div>
          ${t.trxId ? `<div class="lg-meta">UTR/Txn: <b>${esc(t.trxId)}</b></div>` : ''}${t.note ? `<div class="lg-meta">📝 ${esc(t.note)}</div>` : ''}
        </div>
        <div class="lg-amt ${pos ? 'pos' : 'neg'}">${pos ? '+' : '−'}${money(Math.abs(r.amt))}</div></div>`;
    }).join('') + (rows.length > M.shown ? `<button class="btn btn-outline btn-full" onclick="A.ledgerMore()">Show more (${rows.length - M.shown})</button>` : '');
  }
});
