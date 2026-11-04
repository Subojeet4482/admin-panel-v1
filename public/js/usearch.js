// User Search: phone / Gmail / App UID / name -> the full record of that user
import { db, collection, getDocs, doc, getDoc, query, where } from './firebase.js';
const $ = (id) => document.getElementById(id);
const esc = A.esc;
const money = (n) => '₹' + (Number(n) || 0).toFixed(2).replace(/\.00$/, '');
let users = [], tmr = null;
const cp = (v) => `<button class="copy-btn" onclick="A.copyText('${esc(String(v)).replace(/'/g, "\\'")}')"><i class="fa-regular fa-copy"></i></button>`;
const fmtV = (v) => { if (v == null) return '—'; if (typeof v === 'object') { if (v.seconds) return new Date(v.seconds * 1000).toLocaleString(); if (Array.isArray(v)) return v.length + ' item(s)'; return JSON.stringify(v).slice(0, 120); } return String(v); };

Object.assign(window.A, {
  async usOpen() { if (!users.length) { try { const s = await getDocs(collection(db, 'users')); s.forEach(d => users.push({ id: d.id, ...d.data() })); } catch (e) { A.toast(e.message, 'err'); } } setTimeout(() => $('us-q').focus(), 300); },
  usSearch(q) {
    clearTimeout(tmr); tmr = setTimeout(() => {
      q = String(q || '').trim().toLowerCase(); const box = $('us-results'); if (!q) { box.innerHTML = ''; return; }
      const digits = q.replace(/\D/g, '');
      const hit = users.filter(u => (u.email && u.email.toLowerCase().includes(q)) || u.id.toLowerCase() === q || u.id.toLowerCase().startsWith(q) || (digits.length >= 4 && u.phone && String(u.phone).replace(/\D/g, '').includes(digits))
        || [u.appName, u.playerId, u.gameUid, u.gameName].some(v => v && String(v).toLowerCase().includes(q))).slice(0, 10);
      box.innerHTML = hit.length ? hit.map((u, i) => `<div class="mg-res" style="animation-delay:${i * 35}ms" onclick="A.usRecord('${esc(u.id)}')"><div class="mg-av">${esc((u.appName || '?')[0].toUpperCase())}</div><div class="mg-rt"><b>${esc(u.appName || 'No name')}</b><small>${esc(u.email || '—')} · ${esc(u.phone || 'no phone')}</small></div><div class="mg-rb">${money((u.depositBalance !== undefined ? u.depositBalance : u.balance || 0) + (u.withdrawBalance || 0))}</div></div>`).join('') : '<div class="muted" style="padding:10px;">No user found</div>';
    }, 160);
  },
  async usRecord(uid) {
    $('us-results').innerHTML = ''; const box = $('us-record');
    box.innerHTML = '<div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i>Loading full record…</div>';
    try {
      const snap = await getDoc(doc(db, 'users', uid)); if (!snap.exists()) { box.innerHTML = '<div class="empty-box">User not found</div>'; return; }
      const u = snap.data();
      const sub = async (n) => { try { const s = await getDocs(collection(db, 'users', uid, n)); const a = []; s.forEach(d => a.push({ id: d.id, ...d.data() })); return a; } catch (e) { return []; } };
      const [trx, notifs] = await Promise.all([sub('transactions'), sub('notifications')]);
      let deps = []; try { const s = await getDocs(query(collection(db, 'deposit_requests'), where('uid', '==', uid))); s.forEach(d => deps.push({ id: d.id, ...d.data() })); } catch (e) {}
      const mids = (Array.isArray(u.joined_matches) ? u.joined_matches : []).slice(-25); const matches = [];
      for (const m of mids) { try { const d = await getDoc(doc(db, 'matches', typeof m === 'string' ? m : m.id)); if (d.exists()) matches.push({ id: d.id, ...d.data() }); } catch (e) {} }
      const dep = u.depositBalance !== undefined ? u.depositBalance : (u.balance || 0), wd = u.withdrawBalance || 0;
      trx.forEach(t => { t._ms = t.createdAt || (t.timestamp && t.timestamp.seconds * 1000) || Date.parse(t.date) || 0; t._o = A._orderNum(t, t.id, t._ms); }); trx.sort((a, b) => b._ms - a._ms);
      const keys = Object.keys(u).sort();
      box.innerHTML = `<div class="card us-head fade-up"><div class="mgu-top"><div class="mg-av big">${esc((u.appName || '?')[0].toUpperCase())}</div><div style="flex:1;min-width:0;">
          <div class="mgu-name">${esc(u.appName || 'No name')} ${u.isVerified ? '<i class="fa-solid fa-circle-check" style="color:#1d9bf0"></i>' : ''} ${u.isBanned ? '<span class="tag red">BANNED</span>' : ''}</div>
          <div class="mgu-sub">📧 <b>${esc(u.email || '—')}</b> ${u.email ? cp(u.email) : ''}</div><div class="mgu-sub">📱 <b>${esc(u.phone || '—')}</b> ${u.phone ? cp(u.phone) : ''}</div>
          <div class="mgu-sub">App UID: <b>${esc(uid)}</b> ${cp(uid)}</div><div class="mgu-sub">Player ID: <b>${esc(u.playerId || '—')}</b> · FF UID: <b>${esc(u.gameUid || '—')}</b> · ${esc(u.gameName || '')}</div></div></div>
        <div class="mgu-bal"><div><small>Deposit</small><b>${money(dep)}</b></div><div><small>Withdrawal</small><b>${money(wd)}</b></div><div class="tot"><small>Total</small><b>${money(dep + wd)}</b></div></div>
        <div class="us-stats"><div><b>${money(u.totalDeposited)}</b><small>Deposited</small></div><div><b>${money(u.totalWithdrawn)}</b><small>Withdrawn</small></div><div><b>${money(u.totalEarned)}</b><small>Earned</small></div><div><b>${u.matchesPlayed || (u.joined_matches || []).length || 0}</b><small>Matches</small></div><div><b>${u.kills || 0}</b><small>Kills</small></div></div>
        <div class="btn-row" style="margin-top:12px;"><button class="btn btn-success" style="flex:1;" onclick="A.goTab('money');A.moneyOpen().then(()=>A.moneyPick('${esc(uid)}'))"><i class="fa-solid fa-coins"></i> Add / Cut</button><button class="btn btn-outline" style="flex:1;" onclick="A.ledgerForUser('${esc(uid)}');A.goTab('money')"><i class="fa-solid fa-receipt"></i> Ledger</button></div></div>
        <details class="card us-sec fade-up" open><summary><i class="fa-solid fa-receipt"></i> Transactions <b>${trx.length}</b></summary>${trx.slice(0, 80).map(t => { const neg = String(t.amount || '').trim().startsWith('-'); return `<div class="us-row"><div><span class="lg-ord" onclick="A.copyText('${esc(t._o)}')">${esc(t._o)}</span><div class="lg-meta">${esc(t.title || '')} · ${t._ms ? new Date(t._ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : esc(t.date || '')} · <span class="st st-${esc(t.status || 'success')}">${esc(t.status || 'success')}</span>${t.trxId ? ' · ' + esc(t.trxId) : ''}</div></div><b class="${neg ? 'neg' : 'pos'}" style="white-space:nowrap">${esc(t.amount || '')}</b></div>`; }).join('') || '<div class="muted">None</div>'}</details>
        <details class="card us-sec fade-up"><summary><i class="fa-solid fa-building-columns"></i> Deposit requests <b>${deps.length}</b></summary>${deps.map(d => `<div class="us-row"><div><b>${esc(d.id)}</b><div class="lg-meta"><span class="st st-${esc(d.status || 'pending')}">${esc(d.status || 'pending')}</span> · ${d.createdAt ? new Date(d.createdAt).toLocaleString() : ''}</div></div><b>${money(d.amount)}</b></div>`).join('') || '<div class="muted">None</div>'}</details>
        <details class="card us-sec fade-up"><summary><i class="fa-solid fa-gamepad"></i> Matches joined <b>${matches.length}</b></summary>${matches.map(m => `<div class="us-row"><div><b>${esc(m.title || m.id)}</b><div class="lg-meta">${esc(m.matchCode || m.id.slice(0, 8))} · ${esc(m.status || '')} · fee ₹${m.fee || 0}${(m.participants || []).find(p => p.uid === uid) ? ' · slot #' + ((m.participants || []).find(p => p.uid === uid).slot || '-') : ''}</div></div><b>${m.winners && m.winners.some(w => (w.uids || []).includes(uid)) ? '🏆' : ''}</b></div>`).join('') || '<div class="muted">None</div>'}</details>
        <details class="card us-sec fade-up"><summary><i class="fa-solid fa-bell"></i> Notifications <b>${notifs.length}</b></summary>${notifs.slice(0, 30).map(n => `<div class="us-row"><div><b>${esc(n.title || '')}</b><div class="lg-meta">${esc((n.message || n.body || '').slice(0, 140))}</div></div></div>`).join('') || '<div class="muted">None</div>'}</details>
        <details class="card us-sec fade-up"><summary><i class="fa-solid fa-id-card"></i> All profile fields <b>${keys.length}</b></summary>${keys.map(k => `<div class="us-row"><small style="color:var(--sub);min-width:110px;">${esc(k)}</small><span style="word-break:break-all;text-align:right;">${esc(fmtV(u[k]))}</span></div>`).join('')}</details>`;
    } catch (e) { box.innerHTML = '<div class="empty-box">Error: ' + esc(e.message) + '</div>'; }
  }
});
