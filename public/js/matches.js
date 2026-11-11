// Matches: list, create (BR / CS / Lone Wolf), room creds, results + team-split payouts, booya
import { db, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, increment, onSnapshot, query, where, limit, runTransaction } from './firebase.js';

let _timerID = null;

/* ---------- Game mode config ---------- */
const MODES = {
  BR: { label: 'Battle Royale', short: 'BR', subs: [['Solo', 1], ['Duo', 2], ['Squad', 4]] },
  CS: { label: 'Clash Squad',   short: 'CS', subs: [['1v1', 1], ['2v2', 2], ['3v3', 3], ['4v4', 4], ['5v5', 5], ['6v6', 6]] },
  LW: { label: 'Lone Wolf',     short: 'LW', subs: [['1v1', 1], ['2v2', 2]] }
};
const BR_PRIZES = [
  ['per_kill',  '🎯 Per Kill'],
  ['match_win', '🏆 Match Win'],
  ['top1',      '🥇 1st Prize'],
  ['top2',      '🥈 1st + 2nd'],
  ['top3',      '🥉 1st + 2nd + 3rd']
];
const TEAM_PRIZES = [['match_win', '🏆 Winning Team Prize']];
const RANKS = { 1: ['🥇', '1st'], 2: ['🥈', '2nd'], 3: ['🥉', '3rd'] };
const rankCount = (pm) => pm === 'top3' ? 3 : pm === 'top2' ? 2 : 1;
const r2 = (n) => Math.floor((Number(n) || 0) * 100) / 100;

const rupee = (n) => '₹' + (Math.round((Number(n) || 0) * 100) / 100);
const slotsOf = (p) => Array.isArray(p.slots) && p.slots.length ? p.slots.map(Number) : (p.slot ? [Number(p.slot)] : []);
const takenOf = (parts) => [...new Set(parts.flatMap(slotsOf))].sort((a, b) => a - b);
// how much (and from which wallet) a participant paid — old entries without the split fall back to the match fee (refunded to deposit)
const paidOf = (p, m) => {
  if (p.payDep != null || p.payWd != null) return { dep: Number(p.payDep) || 0, wd: Number(p.payWd) || 0 };
  const paid = p.paid != null ? Number(p.paid) : (Number(m.fee) || 0);
  return { dep: paid, wd: 0 };
};
const depOf = (u) => u.depositBalance !== undefined ? Number(u.depositBalance) || 0 : Number(u.balance || 0);
const live = (m) => (m.participants || []).filter(p => !p.refunded);   // players who can still win

// Which team (1..n) does a slot belong to?
function teamOfSlot(slot, m) {
  const size = m.teamSize || 1;
  if (m.mode === 'CS' || m.mode === 'LW') return slot <= size ? 1 : 2;
  return Math.ceil(slot / size);
}
const teamName = (m, t) => (m.mode === 'CS' || m.mode === 'LW') ? (t === 1 ? 'Team A' : 'Team B') : 'Team ' + t;
const prizeModeLabel = (m) => {
  const f = BR_PRIZES.concat(TEAM_PRIZES).find(x => x[0] === m.prizeMode);
  if (f) return f[1];
  return m.matchType === 'per_kill' ? '🎯 Per Kill' : '🏆 Win Prize';
};
// Unique, readable match ID
function genCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return 'FF-' + s;
}

// Leaderboard keys (same formula as the user app): daily d-YYYYMMDD, weekly w-<Monday YYYYMMDD>, monthly m-YYYYMM
const _pad = (n) => String(n).padStart(2, '0');
const _ymd = (d) => d.getFullYear() + _pad(d.getMonth() + 1) + _pad(d.getDate());
function lbKeys(d) {
  d = d || new Date();
  const mon = new Date(d); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  return ['d-' + _ymd(d), 'w-' + _ymd(mon), 'm-' + d.getFullYear() + _pad(d.getMonth() + 1)];
}

const F = { mode: 'BR', sub: 'Solo', size: 1, prize: 'per_kill' };

Object.assign(window.A, {

  /* ---- MATCH LIST ---- */
  _matchesUnsub: null,
  loadMatches() {
    const list = document.getElementById('match-list');
    if (!A._matchesUnsub) list.innerHTML = '<div class="empty-box" style="padding:20px"><i class="fa-solid fa-spinner fa-spin"></i>Loading...</div>';
    try {
      if (A._matchesUnsub) { try { A._matchesUnsub(); } catch (e) {} }
      A._matchesUnsub = onSnapshot(collection(db, 'matches'), (s) => {
        let arr = [];
        s.forEach(d => arr.push({ id: d.id, ...d.data() }));
        arr.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
        arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));   // pinned matches stay on top
        A._ML = {}; arr.forEach(m => A._ML[m.id] = m);
        if (!arr.length) { list.innerHTML = '<p style="text-align:center;padding:20px;color:var(--sub);">No matches yet</p>'; return; }
        list.innerHTML = arr.map((m, i) => {
          const fmt = m.modeShort ? `${m.modeShort} • ${m.subMode}` : (m.teamMode || 'Match');
          const winners = (m.winners || []).map(w => `${(RANKS[w.rank] || ['🏅'])[0]} ${A.esc((w.names || []).join(', '))}`).join(' &nbsp;|&nbsp; ');
          return `
        <div class="card fade-up" style="animation-delay:${Math.min(i * 40, 300)}ms">
          <div class="card-top">
            <div>
              <div class="card-title">${m.pinned ? '📌 ' : ''}${A.esc(m.title)}</div>
              <div class="card-sub match-t" data-t="${m.startTime || ''}">⏳ Loading...</div>
              <div class="card-sub" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;">
                <span class="code-pill">${A.esc(m.matchCode || m.id.slice(0, 8))}</span>
                <span class="tag">${A.esc(fmt)}</span>
                <span class="tag gold">${prizeModeLabel(m)}</span>
              </div>
              <div class="card-sub" style="margin-top:6px;">${A.esc(m.map || 'Bermuda')} • ₹${m.fee} fee • ${m.joined || 0}/${m.total || 48} players</div>
              ${winners ? `<div class="card-sub" style="margin-top:6px;color:#15803d;font-weight:700;">${winners}</div>` : ''}
            </div>
            <span class="badge ${m.status === 'completed' ? 'badge-done' : 'badge-active'}">${m.status === 'live' ? '🔴 LIVE' : (m.status || 'active')}</span>
          </div>
          ${A.rosterChips(m)}
          <button class="btn btn-outline btn-full" style="margin-bottom:10px;" onclick="A.showPlayers('${m.id}')"><i class="fa-solid fa-users"></i> Players &amp; Result (${m.joined || 0})</button>
          <div class="btn-row" style="margin-bottom:10px;">
            <button class="btn btn-outline" style="flex:1;" onclick="A.showEditModal('${m.id}')"><i class="fa-solid fa-pen"></i> Edit</button>
            <button class="btn btn-outline" style="flex:1;" onclick="A.togglePin('${m.id}')"><i class="fa-solid fa-thumbtack"></i> ${m.pinned ? 'Unpin' : 'Pin'}</button>
            ${m.status === 'completed' ? '' : `<button class="btn ${m.status === 'live' ? 'btn-outline' : 'btn-primary'}" style="flex:1;" onclick="A.toggleStart('${m.id}')"><i class="fa-solid fa-play"></i> ${m.status === 'live' ? 'Undo Start' : 'Start'}</button>`}
          </div>
          <div class="btn-row">
            <button class="btn btn-outline" style="flex:1;" onclick="A.showRoomModal('${m.id}')"><i class="fa-solid fa-key"></i> Room</button>
            <button class="btn btn-success" style="flex:1;" onclick="A.completeMatch('${m.id}')"><i class="fa-solid fa-flag-checkered"></i></button>
            <button class="btn btn-danger" style="flex:1;" onclick="A.delMatch('${m.id}')"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`;
        }).join('');
        A.startTimer();
      }, () => { list.innerHTML = '<p style="color:red;padding:20px;">Error loading</p>'; });
    } catch (e) { list.innerHTML = '<p style="color:red;padding:20px;">Error loading</p>'; }
  },
  startTimer() {
    if (_timerID) clearInterval(_timerID);
    _timerID = setInterval(() => {
      const now = Date.now();
      document.querySelectorAll('.match-t').forEach(el => {
        const t = el.getAttribute('data-t');
        if (!t) return;
        const diff = new Date(t).getTime() - now;
        if (diff < 0) { el.innerHTML = "<span class='ended-t'>LIVE / ENDED</span>"; return; }
        const d = Math.floor(diff / 86400000), h = Math.floor((diff % 86400000) / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
        el.innerHTML = `<span class="live-t">⏱ ${d > 0 ? d + 'd ' : ''}${h}h ${m}m ${s}s</span>`;
      });
    }, 1000);
  },

  /* ---- CREATE MATCH: dynamic form ---- */
  showMatchModal() {
    document.getElementById('m-match').classList.add('show');
    A.setMode(F.mode || 'BR');
  },
  setMode(mode) {
    F.mode = mode;
    document.querySelectorAll('#m-mode-tabs .mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const subs = MODES[mode].subs;
    F.sub = subs[0][0]; F.size = subs[0][1];
    document.getElementById('m-sub-chips').innerHTML = subs.map(([n, sz]) =>
      `<button type="button" class="chip ${n === F.sub ? 'active' : ''}" onclick="A.setSub('${n}',${sz})">${mode === 'BR' ? n : n.replace('v', ' v ')}</button>`).join('');
    const prizes = mode === 'BR' ? BR_PRIZES : TEAM_PRIZES;
    F.prize = prizes[0][0];
    A.renderPrizeChips();
    A.applySlots();
  },
  setSub(name, size) {
    F.sub = name; F.size = size;
    document.querySelectorAll('#m-sub-chips .chip').forEach(c => c.classList.toggle('active', c.textContent.replace(/\s/g, '') === name));
    A.applySlots();
  },
  applySlots() {
    const inp = document.getElementById('m-slots');
    if (F.mode === 'BR') {
      inp.readOnly = false; inp.value = 48; inp.max = 48; inp.style.opacity = 1;
    } else {
      inp.readOnly = true; inp.value = F.size * 2; inp.style.opacity = .6;
    }
    A.renderSlotPreview();
  },
  renderSlotPreview() {
    const box = document.getElementById('m-slot-preview');
    let total = Number(document.getElementById('m-slots').value) || 0;
    if (F.mode === 'BR') {
      total = Math.max(F.size, Math.min(48, total));
      total = total - (total % F.size);
      const teams = total / F.size;
      let h = `<div class="sp-title">${total} slots${F.size > 1 ? ' • ' + teams + ' teams of ' + F.size : ''}</div><div class="sp-side">`;
      for (let i = 1; i <= total; i++) h += `<div class="sp-slot" style="animation-delay:${Math.min(i * 12, 400)}ms">${i}</div>`;
      box.innerHTML = h + '</div>';
    } else {
      const side = (cls, name, from) => `<div class="sp-team"><small>${name}</small><div class="sp-side ${cls}">${Array.from({ length: F.size }, (_, i) => `<div class="sp-slot">${from + i}</div>`).join('')}</div></div>`;
      box.innerHTML = `<div class="sp-title">${MODES[F.mode].label} • ${F.sub.replace('v', ' v ')}</div>${side('a', 'TEAM A', 1)}<div class="sp-vs">VS</div>${side('b', 'TEAM B', F.size + 1)}`;
    }
  },
  renderPrizeChips() {
    const prizes = F.mode === 'BR' ? BR_PRIZES : TEAM_PRIZES;
    document.getElementById('m-prize-chips').innerHTML = prizes.map(([k, l]) =>
      `<button type="button" class="chip ${k === F.prize ? 'active' : ''}" onclick="A.setPrize('${k}')">${l}</button>`).join('');
    A.renderPrizeFields();
  },
  setPrize(k) { F.prize = k; A.renderPrizeChips(); },
  renderPrizeFields() {
    const box = document.getElementById('m-prize-fields');
    const kill = '';
    box.innerHTML = kill + '<div id="m-rw" class="fade-up"></div>' +
      (F.size > 1 && F.prize !== 'per_kill' ? '<div class="res-note">Team coin prize is split equally between all team members. Each team member gets their own scratch card.</div>' : '');
    A.rwInit('m', F.prize, F.size > 1, null);
  },
  async createMatch() {
    const g = (id) => { const e = document.getElementById(id); return e ? Number(e.value) || 0 : 0; };
    const title = document.getElementById('m-title').value.trim();
    if (!title) return A.toast('Enter a match name', 'err');
    const startTime = document.getElementById('m-time').value;
    if (!startTime) return A.toast('Select start date & time', 'err');
    let total = Number(document.getElementById('m-slots').value) || 0;
    if (F.mode === 'BR') { total = Math.max(F.size, Math.min(48, total)); total -= total % F.size; }
    else total = F.size * 2;
    const rb = A.rwBuild('m'); if (rb.err) return A.toast(rb.err, 'err');
    const perKill = rb.perKill || 0;
    const n = rankCount(F.prize);
    const prizeTbl = {}; for (let i = 1; i <= n; i++) prizeTbl[i] = rb.prizes[i] || 0;
    const poolTotal = F.prize === 'per_kill' ? perKill : rb.pool;  // 0 when every place is a scratch card
    const isTeam = F.size > 1;
    const modeLabel = MODES[F.mode].label;
    const d = {
      title,
      mode: F.mode, modeLabel, modeShort: MODES[F.mode].short,
      subMode: F.sub, teamSize: F.size,
      type: modeLabel,
      teamMode: F.mode === 'BR' ? 'BR ' + F.sub : modeLabel + ' ' + F.sub,
      matchType: F.prize === 'per_kill' ? 'per_kill' : (isTeam ? 'team_win' : 'win_prize'),
      prizeMode: F.prize,
      prizes: F.prize === 'per_kill' ? {} : prizeTbl,
      prize: poolTotal,
      rewards: rb.rewards,
      fee: g('m-fee'),
      map: document.getElementById('m-map').value,
      startTime,
      prizeTime: document.getElementById('m-prize-time').value || '',
      total,
      img: document.getElementById('m-img').value.trim(),
      joined: 0, status: 'upcoming', takenSlots: []
    };
    if (!confirm(`Create ${modeLabel} ${F.sub} match "${title}"?\n\nRewards:\n` + A._rwLines('m').map(([l, t]) => `${l}: ${t}`).join('\n'))) return;
    try {
      // unique match ID (also used as the document id)
      let code = genCode();
      for (let i = 0; i < 6 && (await getDoc(doc(db, 'matches', code))).exists(); i++) code = genCode();
      d.matchCode = code;
      await setDoc(doc(db, 'matches', code), d);
      A.toast('Match created! ID: ' + code); A.closeModal('m-match'); A.loadMatches();
      ['m-title', 'm-fee', 'm-time', 'm-prize-time', 'm-img'].forEach(id => document.getElementById(id).value = '');
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },
  async delMatch(id) {
    if (!confirm('Delete this match?')) return;
    await deleteDoc(doc(db, 'matches', id));
    A.toast('Deleted'); A.loadMatches();
  },
  showRoomModal(id) {
    const cur = (A._ML && A._ML[id]) || {};
    document.getElementById('room-mid').value = id;
    document.getElementById('room-id').value = cur.roomId || '';
    document.getElementById('room-pass').value = cur.roomPass || '';
    document.getElementById('m-room').classList.add('show');
  },
  async saveRoom() {
    const id = document.getElementById('room-mid').value;
    await updateDoc(doc(db, 'matches', id), {
      roomId: document.getElementById('room-id').value,
      roomPass: document.getElementById('room-pass').value
    });
    A.toast('Room updated!'); A.closeModal('m-room');
  },
  completeMatch(id) { A.showPlayers(id); },

  /* ---- PLAYERS + RESULT PANEL ---- */
  _M: null,
  /** compact "who is in which slot" line shown right on every match card in the list */
  rosterChips(m) {
    const ps = [...(m.participants || [])].sort((a, b) => (a.slot || 999) - (b.slot || 999));
    if (!ps.length) return '<div class="m-roster empty">No players yet</div>';
    const shown = ps.slice(0, 10).map(p => `<span class="rc"><b>${p.slot || '–'}</b>${A.esc(p.appName || 'User')}</span>`).join('');
    return `<div class="m-roster">${shown}${ps.length > 10 ? `<span class="rc more">+${ps.length - 10} more</span>` : ''}</div>`;
  },
  async showPlayers(id) {
    document.getElementById('players-mid').value = id;
    const list = document.getElementById('players-list');
    list.innerHTML = '<div class="empty-box" style="padding:20px"><i class="fa-solid fa-spinner fa-spin"></i>Loading...</div>';
    document.getElementById('result-panel').innerHTML = '';
    document.getElementById('m-players').classList.add('show');
    try {
      const m = (await getDoc(doc(db, 'matches', id))).data() || {};
      m.id = id; A._M = m;
      const players = m.participants || [];
      document.getElementById('players-title').innerText = `Players & Result (${players.length}/${m.total || 48})`;
      document.getElementById('match-code-bar').innerHTML =
        `<span class="code-pill">${A.esc(m.matchCode || id.slice(0, 8))}</span><span class="tag">${A.esc(m.modeShort ? m.modeShort + ' • ' + m.subMode : (m.teamMode || 'Match'))}</span><span class="tag gold">${prizeModeLabel(m)}</span>${m.paid ? '<span class="tag green">PAID</span>' : ''}`;
      A.renderResultPanel(m);
      A.renderPlayerTools(m);

      if (!players.length) { list.innerHTML = '<p style="text-align:center;padding:20px;color:var(--sub);">No players joined yet</p>'; }
      else {
        const sorted = [...players].sort((a, b) => (a.slot || 999) - (b.slot || 999));
        let lastTeam = null, html = '<div style="font-weight:700;font-size:0.82rem;color:var(--sub);margin-bottom:8px;">All Players:</div>';
        sorted.forEach(p => {
          if ((m.teamSize || 1) > 1 && p.slot) {
            const t = teamOfSlot(p.slot, m);
            if (t !== lastTeam) { html += `<div class="tag" style="display:inline-block;margin:6px 0;">${teamName(m, t)}</div>`; lastTeam = t; }
          }
          html += `<div style="display:flex;align-items:center;gap:10px;background:#f8fafc;border-radius:10px;padding:10px;margin-bottom:6px;border:1px solid #f0f0f0;">
            <div class="slot-badge ${p.slot ? '' : 'none'}">${p.slot || '–'}</div>
            <div style="font-weight:700;font-size:0.85rem;">${A.esc(p.appName || 'User')}</div>
            <div style="font-size:0.72rem;color:var(--sub);flex:1;">${A.esc(p.gameName || '---')} • FF: ${A.esc(p.gameUid || '---')} • Slot #${p.slot || '-'}${p.refunded ? ' <b style="color:#b45309;">• REFUNDED</b>' : ''}</div>
            <button class="btn btn-outline" style="padding:6px 9px;font-size:0.7rem;" title="Change slot" onclick="A.changeSlot('${p.uid}')"><i class="fa-solid fa-shuffle"></i></button>
            <button class="btn btn-danger" style="padding:6px 9px;font-size:0.7rem;" title="Kick + refund" onclick="A.kickPlayer('${p.uid}')"><i class="fa-solid fa-user-xmark"></i></button>
          </div>`;
        });
        list.innerHTML = html;
      }
      const bset = new Set((m.booyaPlayers || []).map(b => b.uid));
      document.getElementById('booya-player-list').innerHTML = live(m).map(p => `
        <div style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:8px 10px;margin-bottom:6px;border:1px solid #fecaca;">
          <input type="checkbox" id="by-${p.uid}" data-uid="${p.uid}" data-name="${A.esc(p.appName || 'User')}" ${bset.has(p.uid) ? 'checked' : ''} style="width:18px;height:18px;accent-color:#ef4444;">
          <label for="by-${p.uid}" style="font-weight:600;font-size:0.85rem;flex:1;">${A.esc(p.appName || 'User')}<br><span style="font-size:0.68rem;color:var(--sub);">${A.esc(p.gameUid || '---')}</span></label>
        </div>`).join('') || '<p style="font-size:0.78rem;color:var(--sub);">No players</p>';
    } catch (e) { list.innerHTML = '<p style="color:red;padding:20px;">Error loading players</p>'; }
  },

  // Options for a winner dropdown: players (solo) or whole teams (duo/squad/CS/LW)
  _winnerOptions(m) {
    const players = live(m);
    const size = m.teamSize || 1;
    if (size <= 1) return players.map(p => `<option value="u:${p.uid}">${A.esc(p.appName || 'User')} (${A.esc(p.gameUid || '---')})</option>`).join('');
    const teams = {}, loose = [];
    players.forEach(p => { if (p.slot) (teams[teamOfSlot(p.slot, m)] = teams[teamOfSlot(p.slot, m)] || []).push(p); else loose.push(p); });
    let h = Object.keys(teams).sort((a, b) => a - b).map(t =>
      `<option value="t:${t}">${teamName(m, +t)} — ${teams[t].map(p => A.esc(p.appName || 'User')).join(', ')}</option>`).join('');
    if (loose.length) h += `<optgroup label="No slot chosen">${loose.map(p => `<option value="u:${p.uid}">${A.esc(p.appName || 'User')} (single)</option>`).join('')}</optgroup>`;
    return h;
  },
  _resolveWinner(m, val) {
    const players = live(m);
    if (!val) return null;
    if (val.startsWith('u:')) { const p = players.find(x => x.uid === val.slice(2)); return p ? { label: p.appName || 'User', members: [p] } : null; }
    const t = +val.slice(2);
    const members = players.filter(p => p.slot && teamOfSlot(p.slot, m) === t);
    return members.length ? { label: teamName(m, t), members } : null;
  },

  renderResultPanel(m) {
    const box = document.getElementById('result-panel');
    const players = live(m);
    const pm = m.prizeMode || (m.matchType === 'per_kill' ? 'per_kill' : 'match_win');
    const prizeTimeRow = `
      <div class="lbl" style="margin-top:6px;">Prize Payout Time (shown to players)</div>
      <div style="display:flex;gap:8px;"><input class="inp" id="rs-ptime" type="datetime-local" value="${A.esc(m.prizeTime || '')}" style="background:#fff;margin-bottom:0;flex:1;">
      <button class="btn btn-outline" onclick="A.savePrizeTime()"><i class="fa-solid fa-clock"></i> Save</button></div>`;
    if (m.paid) {
      const w = (m.winners || []).map(x => `<div style="margin-top:6px;">${(RANKS[x.rank] || ['🏅'])[0]} <b>${A.esc((x.names || []).join(', '))}</b>${x.card ? ' — 🎟 Scratch card' : x.amount ? ' — ₹' + x.amount : ''}</div>`).join('');
      box.innerHTML = `<div class="done-banner"><div style="font-weight:800;">✅ Prizes already paid</div>${w}${m.scratchCards ? `<div style="margin-top:8px;color:#7e22ce;font-weight:700;">🎟 ${m.scratchCards} scratch card(s) sent</div>` : ''}</div>`;
      return;
    }
    if (!players.length) { box.innerHTML = '<div class="res-box"><div class="res-note">Result options will appear after players join.</div></div>'; return; }
    let h = '';
    if (pm === 'per_kill') {
      const pk = Number((m.prizes && m.prizes[1]) || m.prize) || 0;
      h = A._rwBox(m, pm) + `<div class="res-box"><h4>🎯 Per Kill — Enter Kills</h4>
        <div class="res-note">${(A._rwPlace(m, 'K').t === 'card') ? '🎟 Scratch card per kill: each player gets one card (kills × card amount).' : '₹' + pk + ' per kill.'} Enter kills for each player, then confirm.</div>
        ${players.map(p => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <div style="flex:1;font-weight:600;font-size:0.82rem;">${A.esc(p.appName || 'User')}<br><span style="font-size:0.68rem;color:var(--sub);">${A.esc(p.gameUid || '---')}${p.slot ? ' • Slot #' + p.slot : ''}</span></div>
          <input type="number" min="0" placeholder="Kills" class="inp" style="width:80px;margin:0;" data-uid="${p.uid}" data-name="${A.esc(p.appName || 'User')}" data-kill>
        </div>`).join('')}
        ${prizeTimeRow}
        <button class="btn btn-success btn-full" style="margin-top:12px;" onclick="A.creditKills()"><i class="fa-solid fa-coins"></i> Calculate & Give Rewards</button></div>`;
    } else {
      const n = rankCount(pm), opts = A._winnerOptions(m), team = (m.teamSize || 1) > 1;
      const pr = m.prizes || {};
      let rows = '';
      for (let i = 1; i <= n; i++) {
        const amt = Number(pr[i] || (i === 1 ? m.prize : 0)) || 0, pl = A._rwPlace(m, String(i));
        rows += `<div class="rank-row" style="animation-delay:${i * 70}ms">
          <div class="rank-head"><span class="medal">${RANKS[i][0]}</span>${pm === 'match_win' ? (team ? 'Winning Team' : 'Match Winner') : RANKS[i][1] + ' Place'}</div>
          <select class="inp" id="rk-w${i}" style="background:#fff;" onchange="A.updateSplit(${i})"><option value="">-- Select ${team ? 'team' : 'player'} --</option>${opts}</select>
          ${pl.t === 'card' ? `<div class="res-note" style="margin:6px 0;">🎟 Gets a scratch card (${A._rwTxt(pl)}) — no coin amount needed.</div><input type="hidden" id="rk-a${i}" value="0">`
            : `<div class="lbl">Prize Amount ₹</div><input class="inp" id="rk-a${i}" type="number" min="0" value="${amt || ''}" oninput="A.updateSplit(${i})" style="background:#fff;">`}
          <div class="rank-split" id="rk-s${i}"></div>
        </div>`;
      }
      h = A._rwBox(m, pm) + `<div class="res-box"><h4>🏆 Select Winners</h4>
        <div class="res-note">${team ? 'The whole team gets the prize — the amount is divided equally between its members.' : 'Only registered players of this match can be selected.'}</div>
        ${rows}${prizeTimeRow}
        <button class="btn btn-success btn-full" style="margin-top:12px;" onclick="A.distributeRanks()"><i class="fa-solid fa-trophy"></i> Confirm & Credit Winners</button></div>`;
    }
    h += `<div class="res-box" style="margin-top:12px;background:#f8fafc;border:1px dashed var(--border);">
      <h4 style="color:var(--text);">📝 Complete without payout</h4>
      <div class="res-note">Just mark the match completed and show a winner name on the match card.</div>
      <input class="inp" id="rs-manual" placeholder="Winner name(s) — e.g. Rahul, Aman" style="background:#fff;">
      <button class="btn btn-outline btn-full" onclick="A.completeNoPayout()"><i class="fa-solid fa-flag-checkered"></i> Mark Completed</button></div>`;
    box.innerHTML = h;
  },
  /* ================= Rewards builder (create + edit): Coin or Scratch Card for 1st / 2nd / 3rd / everyone ================= */
  rwInit(p, pm, team, m) {
    const n = pm === 'per_kill' ? 0 : rankCount(pm), rw = (m && m.rewards) || null, pr = (m && m.prizes) || {};
    const blank = () => ({ mode: 'random', fixed: '', min: '', max: '' });
    const S = { pm, team, keys: [], places: {}, def: blank(), to: 'deposit' };
    for (let i = 1; i <= n; i++) S.keys.push(String(i)); if (pm === 'per_kill') S.keys.push('K'); S.keys.push('R');
    if (rw) { S.to = rw.to || 'deposit'; if (rw.def) S.def = Object.assign(blank(), rw.def, { fixed: rw.def.min }); }
    S.keys.forEach(k => {
      const o = rw && rw.places && rw.places[k], pl = { t: k === 'R' ? 'none' : 'coin', amt: '', diff: false, c: blank() };
      if (o) { pl.t = o.t; if (o.t === 'coin') pl.amt = o.amt; if (o.t === 'card') { pl.diff = !!o.diff; pl.c = { mode: o.mode || 'random', fixed: o.min, min: o.min, max: o.max }; } }
      else if (k === 'K') pl.amt = Number(pr[1] || (m && m.prize)) || '';
      else if (!rw && k !== 'R') pl.amt = Number(pr[k] || (k === '1' ? (m && m.prize) : 0)) || '';
      S.places[k] = pl;
    });
    A._RW = A._RW || {}; A._RW[p] = S; A.rwRender(p);
  },
  _rwLabel(S, k) {
    if (k === 'K') return '🎯 Reward per Kill';
    if (k === 'R') return S.pm === 'per_kill' ? '👥 Everyone who joined' : '👥 Everyone else who joined';
    return S.pm === 'match_win' ? (S.team ? '🏆 Winning Team' : '🏆 Match Winner') : `${RANKS[k][0]} ${RANKS[k][1]} Place`;
  },
  _rwF(n) { return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); },
  _rwTxt(c) { return c.min === c.max ? '₹' + A._rwF(c.min) : `₹${A._rwF(c.min)} – ₹${A._rwF(c.max)}`; },
  _rwCfg(p, k, c) {
    const pill = (m, l) => `<button type="button" class="chip ${c.mode === m ? 'active' : ''}" onclick="A.rwCM('${p}','${k}','${m}')">${l}</button>`;
    const box = (f, ph) => `<input class="inp" type="number" min="0.1" max="999999999" step="any" inputmode="decimal" placeholder="${ph}" value="${c[f] === undefined ? '' : c[f]}" oninput="A.rwC('${p}','${k}','${f}',this.value)" style="background:#fff;flex:1;margin:0;">`;
    return `<div class="chip-row" style="margin:6px 0;">${pill('fixed', '📌 Fixed')}${pill('random', '🎲 Random')}</div>` +
      (c.mode === 'fixed' ? `<div class="lbl">Card amount ₹ (same for everyone) · 0.1 to 999999999</div><div style="display:flex;gap:8px;">${box('fixed', 'e.g. 10')}</div>`
        : `<div class="lbl">Random between (₹ min – ₹ max) · min 0.1, max 999999999</div><div style="display:flex;gap:8px;">${box('min', 'Min ₹')}${box('max', 'Max ₹')}</div>`);
  },
  rwRender(p) {
    const S = A._RW && A._RW[p], box = document.getElementById(p + '-rw'); if (!S || !box) return;
    const needDef = S.keys.some(k => S.places[k].t === 'card' && !S.places[k].diff);
    const dc = S.def, defTxt = dc.mode === 'fixed' ? (Number(dc.fixed) > 0 ? '₹' + dc.fixed : 'not set yet ↓') : (Number(dc.min) > 0 && Number(dc.max) >= Number(dc.min) ? `₹${dc.min} – ₹${dc.max}` : 'not set yet ↓');
    const rows = S.keys.map((k, idx) => {
      const pl = S.places[k];
      const pill = (t, l) => `<button type="button" class="chip ${pl.t === t ? 'active' : ''}" onclick="A.rwT('${p}','${k}','${t}')">${l}</button>`;
      let body = '';
      if (pl.t === 'coin') body = `<div class="lbl">🪙 Coin amount ₹ ${k === 'K' ? '(per kill)' : k === 'R' ? '(each player)' : S.team ? '(split equally in team)' : ''}</div><input class="inp" type="number" min="0.1" max="999999999" step="any" inputmode="decimal" placeholder="e.g. 100 or 0.5" value="${pl.amt}" oninput="A.rwV('${p}','${k}',this.value)" style="background:#fff;margin:0;">`;
      else if (pl.t === 'card') body = pl.diff
        ? `<div class="rw-use">🎟 Different card amount for this place</div>${A._rwCfg(p, k, pl.c)}<button type="button" class="rw-link" onclick="A.rwDiff('${p}','${k}')">↩ Use the default card amount instead</button>`
        : `<div class="rw-use">🎟 ${k === 'K' ? 'Card amount per kill' : 'Card amount'}: <b>${defTxt}</b> <small>(default — Step 2)</small></div>${k === 'K' ? '<div class="res-note" style="margin:0 0 6px;">Each player gets ONE card. Its money = kills × amount (Random: every kill is rolled separately).</div>' : ''}<button type="button" class="rw-link" onclick="A.rwDiff('${p}','${k}')">✎ Give a different amount to this place</button>`;
      else body = '<div class="res-note" style="margin:0;">No reward for this group.</div>';
      return `<div class="rw-card"><div class="rw-head"><span class="rw-n">${idx + 1}</span>${A._rwLabel(S, k)}</div>
        <div class="chip-row" style="margin-bottom:8px;">${pill('coin', '🪙 Coin')}${pill('card', '🎟 Scratch Card')}${k === 'R' ? pill('none', '✖ None') : ''}</div>${body}</div>`;
    }).join('');
    const step2 = needDef ? `<div class="rw-step">Step 2 — 🎟 Scratch card amount</div><div class="rw-card rw-def">${A._rwCfg(p, 'def', S.def)}
        <div class="lbl" style="margin-top:8px;">Card money goes to</div>
        <select class="inp" style="background:#fff;margin:0;" onchange="A.rwTo('${p}',this.value)"><option value="deposit" ${S.to === 'deposit' ? 'selected' : ''}>Deposit balance</option><option value="withdraw" ${S.to === 'withdraw' ? 'selected' : ''}>Withdrawal balance</option></select></div>`
      : (S.keys.some(k => S.places[k].t === 'card') ? `<div class="lbl" style="margin-top:8px;">Card money goes to</div><select class="inp" style="background:#fff;" onchange="A.rwTo('${p}',this.value)"><option value="deposit" ${S.to === 'deposit' ? 'selected' : ''}>Deposit balance</option><option value="withdraw" ${S.to === 'withdraw' ? 'selected' : ''}>Withdrawal balance</option></select>` : '');
    box.innerHTML = `<div class="rw-step">Step 1 — Coin or Scratch Card for each place</div>${rows}${step2}<div class="rw-sum" id="${p}-rw-sum"></div>`;
    A.rwSum(p);
  },
  // plain-text lines "who gets what" for the form + confirm box
  _rwLines(p) {
    const S = A._RW && A._RW[p]; if (!S) return [];
    const f = A._rwF, nz = (v) => Math.round((Number(v) || 0) * 100) / 100, good = (v) => v >= 0.1 && v <= 999999999;
    const cardTxt = (c) => c.mode === 'fixed' ? (good(nz(c.fixed)) ? `fixed ₹${f(nz(c.fixed))}` : '⚠ set amount') : (good(nz(c.min)) && nz(c.max) >= nz(c.min) && good(nz(c.max)) ? `random ₹${f(nz(c.min))} – ₹${f(nz(c.max))}` : '⚠ set min & max');
    return S.keys.map(k => {
      const pl = S.places[k], sfx = k === 'K' ? ' per kill' : '';
      let t;
      if (pl.t === 'coin') t = good(nz(pl.amt)) ? `🪙 ₹${f(nz(pl.amt))}${sfx}${k === 'R' ? ' each' : S.team && k !== 'K' ? ' (split in team)' : ''}` : '🪙 ⚠ set coin amount';
      else if (pl.t === 'card') t = `🎟 Scratch card — ${cardTxt(pl.diff ? pl.c : S.def)}${sfx}${S.team && k !== 'K' && k !== 'R' ? ' (each member)' : ''}`;
      else t = '— nothing';
      return [A._rwLabel(S, k), t];
    });
  },
  rwSum(p) {
    const S = A._RW && A._RW[p], el = document.getElementById(p + '-rw-sum'); if (!S || !el) return;
    const any = S.keys.some(k => S.places[k].t === 'card');
    el.innerHTML = `<div class="rw-sum-t">📋 Summary — who gets what</div>` + A._rwLines(p).map(([l, t]) => `<div class="rw-sum-r"><span>${l}</span><b>${t}</b></div>`).join('') +
      (any ? `<div class="rw-sum-f">🎟 Card money goes to <b>${S.to === 'withdraw' ? 'Withdrawal' : 'Deposit'} balance</b> — added only when the player scratches the card.</div>` : '');
  },
  _rwCfgOf(p, k) { const S = A._RW[p]; return k === 'def' ? S.def : S.places[k].c; },
  rwT(p, k, t) { A._RW[p].places[k].t = t; A.rwRender(p); },
  rwV(p, k, v) { A._RW[p].places[k].amt = v; A.rwSum(p); },
  rwDiff(p, k) { const pl = A._RW[p].places[k]; pl.diff = !pl.diff; if (pl.diff && !pl.c.min && !pl.c.fixed) pl.c = Object.assign({}, A._RW[p].def); A.rwRender(p); },
  rwCM(p, k, m) { A._rwCfgOf(p, k).mode = m; A.rwRender(p); },
  rwC(p, k, f, v) { A._rwCfgOf(p, k)[f] = v; A.rwSum(p); },
  rwTo(p, v) { A._RW[p].to = v; A.rwSum(p); },
  // validate + build what is saved on the match -> {rewards, prizes, pool} or {err}
  rwBuild(p) {
    const S = A._RW && A._RW[p]; if (!S) return { rewards: null, prizes: {}, pool: 0 };
    const MIN = 0.1, MAX = 999999999, nz = (v) => Math.round((Number(v) || 0) * 100) / 100, ok = (v) => v >= MIN && v <= MAX;
    const rd = (c, label) => {
      const pre = (label || 'Scratch card') + ': ';
      if (c.mode === 'fixed') { const v = nz(c.fixed); return ok(v) ? { mode: 'fixed', min: v, max: v } : { err: pre + 'card amount must be between ₹0.1 and ₹999999999' }; }
      const lo = nz(c.min), hi = nz(c.max);
      return (ok(lo) && ok(hi) && hi >= lo) ? { mode: 'random', min: lo, max: hi } : { err: pre + 'Min must be at least ₹0.1, Max not less than Min (up to ₹999999999)' };
    };
    const places = {}, prizes = {}; let pool = 0, def = null, perKill = 0;
    const dd = rd(S.def, 'Default card'); if (!dd.err) def = dd;
    for (const k of S.keys) {
      const pl = S.places[k], lb = String(A._rwLabel(S, k)).replace(/^\S+\s/, '');
      if (pl.t === 'coin') {
        const a = nz(pl.amt); if (!ok(a)) return { err: `${lb}: coin amount must be between ₹0.1 and ₹999999999` };
        places[k] = { t: 'coin', amt: a }; if (k === 'K') { perKill = a; pool = a; } else if (k !== 'R') { prizes[k] = a; pool = nz(pool + a); }
      } else if (pl.t === 'card') {
        const c = rd(pl.diff ? pl.c : S.def, pl.diff ? lb : 'Step 2 scratch card amount'); if (c.err) return { err: c.err };
        places[k] = { t: 'card', mode: c.mode, min: c.min, max: c.max, diff: !!pl.diff }; if (k !== 'R' && k !== 'K') prizes[k] = 0;
      } else places[k] = { t: 'none' };
    }
    const rewards = { places, to: S.to }; if (def) rewards.def = def; // Firestore rejects undefined
    return { rewards, prizes, pool, perKill };
  },
  // at result time: what does place k get? (old matches without a plan = coin for ranks, nothing for the rest)
  _rwPlace(m, k) {
    const o = m.rewards && m.rewards.places && m.rewards.places[k]; if (o) return o;
    if (k === 'K') return { t: 'coin', amt: Number((m.prizes || {})[1] || m.prize) || 0 };
    return k === 'R' ? { t: 'none' } : { t: 'coin', amt: Number((m.prizes || {})[k] || (k === '1' ? m.prize : 0)) || 0 };
  },
  _rwBox(m, pm) {
    if (!m.rewards) return '';
    const S = { pm, team: (m.teamSize || 1) > 1 }, n = pm === 'per_kill' ? 0 : rankCount(pm), keys = []; for (let i = 1; i <= n; i++) keys.push(String(i)); if (pm === 'per_kill') keys.push('K'); keys.push('R');
    const line = (k) => { const o = A._rwPlace(m, k); return `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;"><span>${A._rwLabel(S, k)}</span><b>${o.t === 'coin' ? '🪙 ₹' + o.amt + (k === 'K' ? '/kill' : '') : o.t === 'card' ? '🎟 Card ' + A._rwTxt(o) + (k === 'K' ? '/kill' : '') : '—'}</b></div>`; };
    return `<div class="res-box" style="margin-bottom:10px;background:#faf5ff;border:1px solid #e9d5ff;"><h4 style="color:#7e22ce;">🎁 Reward plan <small style="font-weight:600;">(set in Edit Match)</small></h4><div style="font-size:.82rem;">${keys.map(line).join('')}</div></div>`;
  },
  // result time: who gets scratch cards / participation coins
  _rwCollect(m, entries) {
    const cards = [], used = new Set(), push = (p, c, label, slot, mult) => cards.push({ uid: p.uid, name: p.appName || 'User', min: c.min, max: c.max, label, slot: slot || '', mult: mult || 1 });
    for (const e of entries) { e.members.forEach(p => used.add(p.uid)); if (e.card) e.members.forEach(p => push(p, e.card, `${RANKS[e.rank][1]} place`, 'r' + e.rank)); }
    const R = A._rwPlace(m, 'R'), rest = live(m).filter(p => !used.has(p.uid));
    if (R.t === 'card') rest.forEach(p => push(p, R, entries.length ? 'Participation' : 'Match reward', 'all'));
    return { cards, restCoin: R.t === 'coin' && R.amt > 0 ? { amt: R.amt, players: rest } : null, to: (m.rewards && m.rewards.to) || 'deposit' };
  },
  _rwSummary(sc) {
    let t = '';
    if (sc.restCoin) t += `\n\n🪙 Everyone else: ₹${sc.restCoin.amt} × ${sc.restCoin.players.length} player(s)`;
    if (sc.cards.length) t += '\n\n🎟 Scratch cards: ' + sc.cards.length + ' player(s)\n' + sc.cards.slice(0, 12).map(x => `${x.label}: ${x.name} — ₹${x.min}${x.max > x.min ? '–' + x.max : ''}`).join('\n') + (sc.cards.length > 12 ? '\n…' : '');
    return t;
  },
  async _rwIssue(m, sc) {
    if (!sc.cards.length) return '';
    try {
      const r = await A.api('/api/ref/admin/matchcards', { body: { matchId: m.id, title: m.title || '', creditTo: sc.to, cards: sc.cards } });
      await updateDoc(doc(db, 'matches', m.id), { scratchCards: r.issued || 0 });
      return ` + ${r.issued} scratch card(s) sent`;
    } catch (e) { A._scFail = 'Cash credited, but scratch cards FAILED: ' + (e.message || e) + ' — send them from the Scratch Cards panel.'; return ''; }
  },

  updateSplit(i) {
    const m = A._M, el = document.getElementById('rk-s' + i); if (!el) return;
    const w = A._resolveWinner(m, document.getElementById('rk-w' + i).value);
    const amt = Number(document.getElementById('rk-a' + i).value) || 0;
    el.innerText = w ? (amt <= 0 ? '' : w.members.length > 1 ? `${w.members.length} members × ₹${r2(amt / w.members.length)} each` : `₹${amt} → ${w.label}`) : '';
  },
  async savePrizeTime() {
    const id = document.getElementById('players-mid').value;
    await updateDoc(doc(db, 'matches', id), { prizeTime: document.getElementById('rs-ptime').value || '' });
    A.toast('Prize time saved');
  },
  async saveBooya() {
    const matchId = document.getElementById('players-mid').value;
    const checked = document.querySelectorAll('#booya-player-list input[type=checkbox]:checked');
    const booyaPlayers = Array.from(checked).map(cb => ({ uid: cb.dataset.uid, name: cb.dataset.name }));
    A.toast('Booya saved!');
    return updateDoc(doc(db, 'matches', matchId), { booyaPlayers }).catch(e => A.toast('Error: ' + e.message, 'err'));
  },
  async _alreadyPaid(matchId) {
    const m = (await getDoc(doc(db, 'matches', matchId))).data() || {};
    if (m.paid) { A.toast('This match has already been paid!', 'err'); return true; }
    return false;
  },
  async completeNoPayout() {
    const id = document.getElementById('players-mid').value;
    const txt = (document.getElementById('rs-manual').value || '').trim();
    if (!confirm('Mark this match as completed?')) return;
    const upd = { status: 'completed', winnerName: txt || 'N/A' };
    if (txt) upd.winners = [{ rank: 1, names: txt.split(',').map(s => s.trim()).filter(Boolean), amount: 0 }];
    await updateDoc(doc(db, 'matches', id), upd);
    A.toast('Match completed!'); A.closeModal('m-players'); A.loadMatches();
  },

  // credit one user (wallet + notification + transaction)
  _credit(uid, amt, title, msg, win, kills, name) {
    const upd = { withdrawBalance: increment(amt), totalEarned: increment(amt) };
    if (win) upd.matchesWon = increment(1);
    if (kills) upd.kills = increment(kills);
    const today = new Date().toLocaleDateString(), now = Date.now();
    const tref = doc(collection(db, 'users', uid, 'transactions'));
    const orderNo = A._orderNum({ kind: 'prize' }, tref.id, now);
    // leaderboard: winnings of this prize in today's / this week's / this month's board
    const lbWrites = lbKeys().map(k => setDoc(doc(db, 'lb', k), { players: { [uid]: { n: name || 'User', a: increment(amt) } }, updatedAt: now }, { merge: true }));
    return [
      ...lbWrites,
      setDoc(doc(db, 'users', uid), upd, { merge: true }),
      addDoc(collection(db, 'users', uid, 'notifications'), { title: `Match win success: ₹${amt}`, message: msg + ` (Order ${orderNo})`, date: today, timestamp: new Date() }),
      setDoc(tref, { title: title, amount: `+₹${amt}`, type: 'deposit', status: 'success', kind: 'prize', orderNo, balanceType: 'withdraw', date: today, createdAt: now })
    ];
  },

  // 1st / 2nd / 3rd (or single winner): solo player or whole team. Each place = coin or scratch card (set when the match was made)
  async distributeRanks() {
    const m = A._M, matchId = m.id;
    if (await A._alreadyPaid(matchId)) return;
    const pm = m.prizeMode || 'match_win', n = rankCount(pm);
    const entries = [], used = new Set();
    for (let i = 1; i <= n; i++) {
      const w = A._resolveWinner(m, document.getElementById('rk-w' + i).value);
      const pl = A._rwPlace(m, String(i)), card = pl.t === 'card' ? pl : null;
      const amt = card ? 0 : (Number(document.getElementById('rk-a' + i).value) || 0);
      if (!w) { if (i === 1) return A.toast('Select the 1st winner', 'err'); continue; }
      if (!card && amt <= 0) return A.toast(`Enter prize amount for ${RANKS[i][1]}`, 'err');
      if (w.members.some(p => used.has(p.uid))) return A.toast('A player cannot win two places', 'err');
      w.members.forEach(p => used.add(p.uid));
      entries.push({ rank: i, label: w.label, members: w.members, amount: amt, per: r2(amt / w.members.length), card });
    }
    const sc = A._rwCollect(m, entries);
    const sum = entries.map(e => `${RANKS[e.rank][1]}: ${e.label} — ${e.card ? '🎟 Scratch card ' + A._rwTxt(e.card) + (e.members.length > 1 ? ` (each of ${e.members.length})` : '') : '₹' + e.amount + (e.members.length > 1 ? ` (₹${e.per} × ${e.members.length})` : '')}`).join('\n');
    if (!confirm(`Give these rewards?\n\n${sum}${A._rwSummary(sc)}`)) return;
    try {
      const writes = [], winMap = {};
      for (const e of entries) for (const p of e.members) {
        winMap[p.uid] = { amt: e.per, rank: e.rank };
        if (e.card) { if (e.rank === 1) writes.push(setDoc(doc(db, 'users', p.uid), { matchesWon: increment(1) }, { merge: true })); }
        else writes.push(...A._credit(p.uid, e.per, `Match win success: ₹${e.per}`, `${RANKS[e.rank][1]} place${e.members.length > 1 ? ' (team prize split)' : ''} — reward added to withdrawal balance.`, e.rank === 1, 0, p.appName));
      }
      if (sc.restCoin) for (const p of sc.restCoin.players) {
        winMap[p.uid] = { amt: sc.restCoin.amt, rank: 0 };
        writes.push(...A._credit(p.uid, sc.restCoin.amt, `Match reward: ₹${sc.restCoin.amt}`, 'Thanks for playing — participation reward added to withdrawal balance.', false, 0, p.appName));
      }
      await Promise.all(writes);
      const fresh = (await getDoc(doc(db, 'matches', matchId))).data() || {};
      const parts = (fresh.participants || []).map(p => { const w = winMap[p.uid]; return w ? (w.rank ? { ...p, winAmount: w.amt, rank: w.rank } : { ...p, winAmount: w.amt }) : { ...p, winAmount: 0 }; });
      const winners = entries.map(e => ({ rank: e.rank, names: e.members.map(p => p.appName || 'User'), amount: e.amount, uids: e.members.map(p => p.uid), ...(e.card ? { card: true } : {}) }));
      const first = entries.find(e => e.rank === 1);
      await updateDoc(doc(db, 'matches', matchId), {
        status: 'completed', paid: true, participants: parts, winners,
        winnerName: first ? first.members.map(p => p.appName || 'User').join(', ') : 'N/A',
        winnerUid: first ? first.members[0].uid : '', winnerUids: first ? first.members.map(p => p.uid) : [],
        paidAt: Date.now()
      });
      A._scFail = ''; const scMsg = await A._rwIssue(m, sc);
      A.toast(A._scFail || ('Rewards given!' + scMsg), A._scFail ? 'err' : undefined); A.closeModal('m-players'); A.loadMatches();
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },

  // Per Kill: kills x coin per kill, OR one scratch card per player (money = kills x card amount). Plus the "everyone who joined" reward.
  async creditKills() {
    const m = A._M, matchId = m.id;
    if (await A._alreadyPaid(matchId)) return;
    const K = A._rwPlace(m, 'K'), kcard = K.t === 'card', perKill = kcard ? 0 : (Number(K.amt) || 0);
    if (!kcard && perKill <= 0) return A.toast('Per-kill amount is not set for this match', 'err');
    const credits = [];
    document.querySelectorAll('#result-panel input[data-kill]').forEach(inp => {
      const kills = parseInt(inp.value) || 0;
      if (kills > 0) credits.push({ uid: inp.dataset.uid, name: inp.dataset.name, kills, amt: kcard ? 0 : r2(kills * perKill) });
    });
    if (!credits.length) return A.toast('Enter kills for at least one player', 'err');
    const sc = A._rwCollect(m, []);
    if (kcard) credits.forEach(c => sc.cards.push({ uid: c.uid, name: c.name, min: K.min, max: K.max, label: `${c.kills} kill${c.kills > 1 ? 's' : ''}`, slot: 'k', mult: Math.min(50, c.kills) }));
    const kLine = (c) => kcard ? `${c.name}: ${c.kills} kills → 🎟 1 card (${c.kills} × ${A._rwTxt(K)})` : `${c.name}: ${c.kills} kills × ₹${perKill} = ₹${c.amt}`;
    const extra = A._rwSummary({ restCoin: sc.restCoin, cards: sc.cards.filter(x => x.slot !== 'k') });
    if (!confirm('Give these rewards?\n' + credits.map(kLine).join('\n') + extra)) return;
    try {
      const writes = [], killMap = {};
      for (const c of credits) {
        killMap[c.uid] = c;
        if (kcard) writes.push(setDoc(doc(db, 'users', c.uid), { kills: increment(c.kills) }, { merge: true }));
        else writes.push(...A._credit(c.uid, c.amt, `Match win success: ₹${c.amt} (${c.kills} kills)`, `Per Kill reward: ${c.kills} × ₹${perKill}.`, false, c.kills, c.name));
      }
      if (sc.restCoin) for (const p of sc.restCoin.players) writes.push(...A._credit(p.uid, sc.restCoin.amt, `Match reward: ₹${sc.restCoin.amt}`, 'Thanks for playing — participation reward added to withdrawal balance.', false, 0, p.appName));
      await Promise.all(writes);
      const fresh = (await getDoc(doc(db, 'matches', matchId))).data() || {};
      const parts = (fresh.participants || []).map(p => killMap[p.uid] ? { ...p, kills: killMap[p.uid].kills, winAmount: killMap[p.uid].amt } : { ...p, kills: 0, winAmount: 0 });
      const top = [...credits].sort((a, b) => b.kills - a.kills).slice(0, 3);
      await updateDoc(doc(db, 'matches', matchId), {
        status: 'completed', paid: true, participants: parts, paidAt: Date.now(),
        winners: top.map((c, i) => ({ rank: i + 1, names: [c.name], amount: c.amt, kills: c.kills, uids: [c.uid], ...(kcard ? { card: true } : {}) })),
        winnerName: top[0].name
      });
      A._scFail = ''; const scMsg = await A._rwIssue(m, sc);
      A.toast(A._scFail || ((kcard ? 'Kill cards sent!' : 'Kill rewards credited!') + scMsg), A._scFail ? 'err' : undefined); A.closeModal('m-players'); A.loadMatches();
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },

  /* ================= NEW: pin / start / edit / kick / refund / slots / add player ================= */
  async togglePin(id) {
    const m = (A._ML && A._ML[id]) || {};
    await updateDoc(doc(db, 'matches', id), { pinned: !m.pinned, pinnedAt: m.pinned ? 0 : Date.now() });
    A.toast(m.pinned ? 'Unpinned' : 'Pinned on top');
  },
  async toggleStart(id) {
    const m = (A._ML && A._ML[id]) || {};
    if (m.status === 'live') {
      if (!confirm('Undo start? Room ID & password will be visible to players again.')) return;
      await updateDoc(doc(db, 'matches', id), { status: 'upcoming', startedAt: 0 });
      return A.toast('Back to upcoming');
    }
    if (!confirm('Start this match? Players will see "Game Started" instead of Room ID & password, and nobody can join any more.')) return;
    await updateDoc(doc(db, 'matches', id), { status: 'live', startedAt: Date.now() });
    A.toast('Match started — players see "Game Started"');
  },

  showEditModal(id) {
    const m = (A._ML && A._ML[id]) || null;
    if (!m) return A.toast('Match not found', 'err');
    A._E = m;
    const pm = m.prizeMode || (m.matchType === 'per_kill' ? 'per_kill' : 'match_win');
    const pr = m.prizes || {};
    const inp = (i, lbl, val) => `<div style="flex:1;min-width:110px;"><div class="lbl">${lbl}</div><input class="inp" id="${i}" type="number" min="0" value="${val || ''}"></div>`;
    let pf = '';
    if (m.paid) pf = '<div class="res-note">Prize already paid — rewards are locked.</div>';
    else pf = '<div id="e-rw"></div>';
    const maps = ['Bermuda', 'Bermuda Remastered', 'Purgatory', 'Kalahari', 'Alpine', 'NexTerra', 'Solara'];
    if (m.map && !maps.includes(m.map)) maps.push(m.map);
    const fixedSlots = m.mode === 'CS' || m.mode === 'LW';
    let box = document.getElementById('m-edit');
    if (!box) { box = document.createElement('div'); box.className = 'overlay'; box.id = 'm-edit'; document.body.appendChild(box); }
    box.innerHTML = `<div class="sheet">
      <div class="sheet-title"><i class="fa-solid fa-pen"></i> Edit Match</div>
      <div class="res-note">Mode / format (${A.esc(m.teamMode || m.modeLabel || '')}) cannot be changed — create a new match for that.</div>
      <div class="lbl">Match Name</div><input class="inp" id="e-title" value="${A.esc(m.title || '')}">
      <div class="lbl">Map</div><select class="inp" id="e-map" style="background:#fff;">${maps.map(x => `<option ${x === (m.map || 'Bermuda') ? 'selected' : ''}>${A.esc(x)}</option>`).join('')}</select>
      <div class="lbl">Start Date &amp; Time</div><input class="inp" id="e-time" type="datetime-local" step="1" value="${A.esc(m.startTime || '')}" style="background:#fff;">
      <div style="display:flex;gap:12px;">
        <div style="flex:1;"><div class="lbl">Entry Fee ₹</div><input class="inp" id="e-fee" type="number" min="0" value="${Number(m.fee) || 0}"></div>
        <div style="flex:1;"><div class="lbl">Total Slots</div><input class="inp" id="e-total" type="number" min="1" max="48" value="${m.total || 48}" ${fixedSlots ? 'readonly style="opacity:.6"' : ''}></div>
      </div>
      <div class="lbl">Prize &amp; Rewards</div><div>${pf}</div>
      <div class="lbl" style="margin-top:10px;">Prize Payout Time (optional)</div><input class="inp" id="e-ptime" type="datetime-local" value="${A.esc(m.prizeTime || '')}" style="background:#fff;">
      <div style="display:flex;gap:12px;">
        <div style="flex:1;"><div class="lbl">Room ID</div><input class="inp" id="e-room" value="${A.esc(m.roomId || '')}"></div>
        <div style="flex:1;"><div class="lbl">Room Password</div><input class="inp" id="e-pass" value="${A.esc(m.roomPass || '')}"></div>
      </div>
      <div class="lbl">Banner Image URL</div><input class="inp" id="e-img" value="${A.esc(m.img || '')}" placeholder="https://...">
      <div class="btn-row">
        <button class="btn btn-outline" style="flex:1;" onclick="A.closeModal('m-edit')">Cancel</button>
        <button class="btn btn-primary" style="flex:1;" onclick="A.saveEdit()"><i class="fa-solid fa-floppy-disk"></i> Save</button>
      </div></div>`;
    if (!m.paid) A.rwInit('e', pm, (m.teamSize || 1) > 1, m);
    box.classList.add('show');
  },
  async saveEdit() {
    const m = A._E; if (!m) return;
    const g = (i) => { const e = document.getElementById(i); return e ? Number(e.value) || 0 : 0; };
    const v = (i) => (document.getElementById(i) || {}).value || '';
    const title = v('e-title').trim();
    if (!title) return A.toast('Enter a match name', 'err');
    if (!v('e-time')) return A.toast('Select start date & time', 'err');
    const parts = m.participants || [];
    let total = m.total || 48;
    if (!(m.mode === 'CS' || m.mode === 'LW')) {
      total = Math.max(1, Math.min(48, g('e-total')));
      const size = m.teamSize || 1;
      if (size > 1) total -= total % size;
      const maxSlot = Math.max(0, ...takenOf(parts));
      if (total < Math.max(parts.length, maxSlot)) return A.toast(`Slots cannot be less than ${Math.max(parts.length, maxSlot)} (players / highest slot already taken)`, 'err');
    }
    const upd = { title, map: v('e-map'), startTime: v('e-time'), prizeTime: v('e-ptime'), total, roomId: v('e-room').trim(), roomPass: v('e-pass').trim(), img: v('e-img').trim() };
    const fee = g('e-fee');
    if (fee !== (Number(m.fee) || 0)) {
      if (parts.length && !confirm(`Fee ₹${m.fee} → ₹${fee}.\n${parts.length} players already joined — they keep their old entry (refunds return what they paid). Continue?`)) return;
      upd.fee = fee;
      if (parts.length) upd.participants = parts.map(p => (p.payDep != null || p.payWd != null || p.paid != null) ? p : { ...p, paid: Number(m.fee) || 0 });
    }
    if (!m.paid) {
      const pm = m.prizeMode || (m.matchType === 'per_kill' ? 'per_kill' : 'match_win');
      const rb = A.rwBuild('e'); if (rb.err) return A.toast(rb.err, 'err');
      const n = rankCount(pm), tbl = {}; for (let i = 1; i <= n; i++) tbl[i] = rb.prizes[i] || 0;
      if (pm === 'per_kill') { upd.prize = rb.perKill || 0; upd.prizes = {}; }
      else { upd.prizes = tbl; upd.prize = rb.pool; }
      upd.rewards = rb.rewards;
    }
    try {
      await updateDoc(doc(db, 'matches', m.id), upd);
      A.toast('Match updated!'); A.closeModal('m-edit');
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },

  // ---- shared: write refund (wallet + notification + transaction) inside a transaction. `us` = user snapshot read BEFORE any write.
  _refundWrites(tx, uid, us, m, p, why) {
    const { dep, wd } = paidOf(p, m);
    const amt = Math.round((dep + wd) * 100) / 100;
    if (!us.exists() || amt <= 0) return 0;
    const u = us.data(), now = Date.now(), date = new Date().toLocaleDateString();
    const tref = doc(collection(db, 'users', uid, 'transactions'));
    const orderNo = A._orderNum({ kind: 'refund' }, tref.id, now);
    tx.update(doc(db, 'users', uid), {
      depositBalance: Math.round((depOf(u) + dep) * 100) / 100,
      withdrawBalance: Math.round((Number(u.withdrawBalance || 0) + wd) * 100) / 100
    });
    tx.set(tref, { title: `Refund: ${m.title}`, amount: `+₹${amt}`, type: 'deposit', status: 'success', kind: 'refund', orderNo, balanceType: dep >= wd ? 'deposit' : 'withdraw', by: 'admin', note: why, date, createdAt: now });
    tx.set(doc(collection(db, 'users', uid, 'notifications')), { title: `Entry refunded: ₹${amt}`, message: `${m.title} — ${why}. ₹${amt} returned to your wallet (Order ${orderNo}).`, date, timestamp: new Date() });
    return amt;
  },

  // Kick a player out of the match and give the entry fee back
  async kickPlayer(uid) {
    const mid = document.getElementById('players-mid').value;
    const m0 = A._M || {}, p0 = (m0.participants || []).find(x => x.uid === uid) || {};
    const back = paidOf(p0, m0);
    if (!confirm(`Kick ${p0.appName || 'this player'} from the match?\nTheir entry ₹${back.dep + back.wd} will be refunded.`)) return;
    try {
      let amt = 0;
      await runTransaction(db, async (tx) => {
        const mref = doc(db, 'matches', mid), ms = await tx.get(mref), us = await tx.get(doc(db, 'users', uid));
        if (!ms.exists()) throw new Error('Match not found');
        const m = { id: mid, ...ms.data() };
        if (m.paid) throw new Error('Prizes already paid — cannot kick now');
        const parts = m.participants || [], p = parts.find(x => x.uid === uid);
        if (!p) throw new Error('Player is not in this match');
        const left = parts.filter(x => x.uid !== uid);
        amt = p.refunded ? 0 : A._refundWrites(tx, uid, us, m, p, 'removed from match by admin');
        tx.update(mref, { participants: left, takenSlots: takenOf(left), joined: left.length });
        if (us.exists()) {
          const u = us.data();
          tx.update(doc(db, 'users', uid), { joined_matches: (u.joined_matches || []).filter(i => i !== mid), matchesPlayed: Math.max(0, (Number(u.matchesPlayed) || 0) - 1) });
        }
      });
      A.toast(`Kicked${amt ? ' + refunded ' + rupee(amt) : ''}`);
      A.showPlayers(mid);
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },

  // Refund players who did not come into the game (they stay in the list, marked REFUNDED, and cannot win)
  async refundNoShow() {
    const mid = document.getElementById('players-mid').value;
    const uids = Array.from(document.querySelectorAll('#ns-list input[type=checkbox]:checked')).map(c => c.dataset.uid);
    if (!uids.length) return A.toast('Tick the players who did not join the game', 'err');
    if (!confirm(`Refund entry fee to ${uids.length} player(s) who did not play?`)) return;
    try {
      let total = 0;
      await runTransaction(db, async (tx) => {
        const mref = doc(db, 'matches', mid), ms = await tx.get(mref);
        if (!ms.exists()) throw new Error('Match not found');
        const m = { id: mid, ...ms.data() };
        const snaps = {};
        for (const u of uids) snaps[u] = await tx.get(doc(db, 'users', u));
        const now = Date.now();
        const parts = (m.participants || []).map(p => {
          if (!uids.includes(p.uid)) return p;
          if (p.refunded) return p;
          if (Number(p.winAmount) > 0) throw new Error(`${p.appName || 'Player'} already got a prize`);
          const a = A._refundWrites(tx, p.uid, snaps[p.uid], m, p, 'you did not play in the game');
          total += a;
          return { ...p, refunded: true, refundAmount: a, refundedAt: now };
        });
        tx.update(mref, { participants: parts });
      });
      A.toast(`Refunded ${rupee(total)} to ${uids.length} player(s)`);
      A.showPlayers(mid);
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },

  // Move a player to another slot (if that slot is taken, the two players swap)
  async changeSlot(uid) {
    const mid = document.getElementById('players-mid').value;
    const m0 = A._M || {}, p0 = (m0.participants || []).find(x => x.uid === uid) || {};
    const v = prompt(`New slot number for ${p0.appName || 'player'} (1–${m0.total || 48}). If that slot is taken, both players swap.`, p0.slot || '');
    if (v === null) return;
    const ns = parseInt(v, 10);
    if (!ns || ns < 1 || ns > (m0.total || 48)) return A.toast('Invalid slot', 'err');
    try {
      await runTransaction(db, async (tx) => {
        const mref = doc(db, 'matches', mid), ms = await tx.get(mref);
        if (!ms.exists()) throw new Error('Match not found');
        const m = ms.data(), parts = m.participants || [];
        const me = parts.find(x => x.uid === uid); if (!me) throw new Error('Player not in match');
        const other = parts.find(x => x.uid !== uid && slotsOf(x).includes(ns));
        const oldSlot = me.slot || null;
        const np = parts.map(x => {
          if (x.uid === uid) return { ...x, slot: ns, slots: [ns] };
          if (other && x.uid === other.uid) return oldSlot ? { ...x, slot: oldSlot, slots: [oldSlot] } : (() => { const { slot, slots, ...rest } = x; return rest; })();
          return x;
        });
        tx.update(mref, { participants: np, takenSlots: takenOf(np) });
      });
      A.toast('Slot changed'); A.showPlayers(mid);
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },

  // Add a player by hand (UID / app name / email). Optionally charge the entry fee from his wallet.
  async addPlayer() {
    const mid = document.getElementById('players-mid').value;
    const q = (document.getElementById('ap-user').value || '').trim();
    const slotV = parseInt(document.getElementById('ap-slot').value, 10) || 0;
    const charge = document.getElementById('ap-charge').value === '1';
    if (!q) return A.toast('Enter user UID / app name / email', 'err');
    try {
      let uid = '';
      if (!/\s/.test(q) && (await getDoc(doc(db, 'users', q))).exists()) uid = q;
      for (const f of ['appName', 'email']) {
        if (uid) break;
        const r = await getDocs(query(collection(db, 'users'), where(f, '==', q), limit(1)));
        r.forEach(d => { uid = d.id; });
      }
      if (!uid) return A.toast('User not found', 'err');
      let who = '';
      await runTransaction(db, async (tx) => {
        const mref = doc(db, 'matches', mid), uref = doc(db, 'users', uid);
        const ms = await tx.get(mref), us = await tx.get(uref);
        if (!ms.exists() || !us.exists()) throw new Error('Match / user not found');
        const m = { id: mid, ...ms.data() }, u = us.data(), parts = m.participants || [];
        if (m.paid || m.status === 'completed') throw new Error('Match already completed');
        if (parts.some(x => x.uid === uid)) throw new Error('Player is already in this match');
        if (parts.length >= (m.total || 48)) throw new Error('Match is full');
        if (slotV) {
          if (slotV < 1 || slotV > (m.total || 48)) throw new Error('Invalid slot');
          if (takenOf(parts).includes(slotV)) throw new Error('Slot already taken');
        }
        const fee = Number(m.fee) || 0, dep = depOf(u), wd = Number(u.withdrawBalance || 0);
        let payDep = 0, payWd = 0;
        const now = Date.now();
        const upd = { joined_matches: [...new Set([...(u.joined_matches || []), mid])], matchesPlayed: (Number(u.matchesPlayed) || 0) + 1 };
        if (charge && fee > 0) {
          if (dep + wd < fee) throw new Error('User has not enough balance');
          payDep = Math.min(dep, fee); payWd = Math.round((fee - payDep) * 100) / 100;
          upd.depositBalance = Math.round((dep - payDep) * 100) / 100; upd.withdrawBalance = Math.round((wd - payWd) * 100) / 100;
          tx.set(doc(collection(db, 'users', uid, 'transactions')), { title: `Joined ${m.title}`, amount: `-₹${fee}`, type: 'game', status: 'success', date: new Date().toLocaleDateString(), timestamp: new Date(), createdAt: now });
        }
        tx.update(uref, upd);
        const entry = { uid, appName: u.appName || 'User', gameName: u.gameName || '', gameUid: u.gameUid || '', payDep, payWd, addedByAdmin: true, ...(slotV ? { slot: slotV, slots: [slotV] } : {}) };
        const np = [...parts, entry];
        tx.update(mref, { participants: np, takenSlots: takenOf(np), joined: np.length });
        who = u.appName || 'User';
      });
      A.toast(`${who} added${charge ? ' (fee charged)' : ' (free entry)'}`);
      document.getElementById('ap-user').value = ''; document.getElementById('ap-slot').value = '';
      A.showPlayers(mid);
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },

  // "Add player" form + "no-show refund" list (inside the Players modal)
  renderPlayerTools(m) {
    const box = document.getElementById('players-tools'); if (!box) return;
    const parts = m.participants || [];
    const ns = parts.length ? parts.map(p => `
      <label style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:8px 10px;margin-bottom:6px;border:1px solid #fde68a;${p.refunded ? 'opacity:.55;' : ''}">
        <input type="checkbox" data-uid="${p.uid}" ${p.refunded ? 'disabled' : ''} style="width:18px;height:18px;accent-color:#d97706;">
        <span style="flex:1;font-weight:600;font-size:0.82rem;">${A.esc(p.appName || 'User')}<br><span style="font-size:0.68rem;color:var(--sub);">${A.esc(p.gameUid || '---')}${p.slot ? ' • Slot #' + p.slot : ''}</span></span>
        <span style="font-size:0.72rem;font-weight:700;">${p.refunded ? 'Refunded ' + rupee(p.refundAmount) : rupee(paidOf(p, m).dep + paidOf(p, m).wd)}</span>
      </label>`).join('') : '<p style="font-size:0.78rem;color:var(--sub);">No players</p>';
    box.innerHTML = `
      <div style="background:#fffbeb;border-radius:14px;padding:14px;margin-top:14px;border:1px solid #fde68a;">
        <div style="font-weight:800;font-size:0.88rem;color:#b45309;margin-bottom:6px;">↩ Refund — players who did not join the game</div>
        <div style="font-size:0.72rem;color:var(--sub);margin-bottom:10px;">Tick the players who never came in. Their entry fee goes back to the wallet it came from. They stay in the list as REFUNDED and cannot win.</div>
        <div id="ns-list">${ns}</div>
        <button class="btn btn-primary btn-full" style="margin-top:8px;" onclick="A.refundNoShow()"><i class="fa-solid fa-rotate-left"></i> Refund Selected</button>
      </div>
      ${m.paid ? '' : `<div style="background:#eff6ff;border-radius:14px;padding:14px;margin-top:14px;border:1px solid #bfdbfe;">
        <div style="font-weight:800;font-size:0.88rem;color:#1d4ed8;margin-bottom:8px;">➕ Add Player</div>
        <input class="inp" id="ap-user" placeholder="User UID / app name / email">
        <div style="display:flex;gap:10px;">
          <input class="inp" id="ap-slot" type="number" min="1" placeholder="Slot (optional)" style="flex:1;">
          <select class="inp" id="ap-charge" style="flex:1;background:#fff;"><option value="0">Free entry</option><option value="1">Charge entry fee</option></select>
        </div>
        <button class="btn btn-primary btn-full" onclick="A.addPlayer()"><i class="fa-solid fa-user-plus"></i> Add to Match</button>
      </div>`}`;
  },

});
