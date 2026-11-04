// Matches: list, create (BR / CS / Lone Wolf), room creds, results + team-split payouts, booya
import { db, collection, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc, increment, onSnapshot } from './firebase.js';

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
        if (!arr.length) { list.innerHTML = '<p style="text-align:center;padding:20px;color:var(--sub);">No matches yet</p>'; return; }
        list.innerHTML = arr.map((m, i) => {
          const fmt = m.modeShort ? `${m.modeShort} • ${m.subMode}` : (m.teamMode || 'Match');
          const winners = (m.winners || []).map(w => `${(RANKS[w.rank] || ['🏅'])[0]} ${A.esc((w.names || []).join(', '))}`).join(' &nbsp;|&nbsp; ');
          return `
        <div class="card fade-up" style="animation-delay:${Math.min(i * 40, 300)}ms">
          <div class="card-top">
            <div>
              <div class="card-title">${A.esc(m.title)}</div>
              <div class="card-sub match-t" data-t="${m.startTime || ''}">⏳ Loading...</div>
              <div class="card-sub" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;">
                <span class="code-pill">${A.esc(m.matchCode || m.id.slice(0, 8))}</span>
                <span class="tag">${A.esc(fmt)}</span>
                <span class="tag gold">${prizeModeLabel(m)}</span>
              </div>
              <div class="card-sub" style="margin-top:6px;">${A.esc(m.map || 'Bermuda')} • ₹${m.fee} fee • ${m.joined || 0}/${m.total || 48} players</div>
              ${winners ? `<div class="card-sub" style="margin-top:6px;color:#15803d;font-weight:700;">${winners}</div>` : ''}
            </div>
            <span class="badge ${m.status === 'completed' ? 'badge-done' : 'badge-active'}">${m.status || 'active'}</span>
          </div>
          ${A.rosterChips(m)}
          <button class="btn btn-outline btn-full" style="margin-bottom:10px;" onclick="A.showPlayers('${m.id}')"><i class="fa-solid fa-users"></i> Players &amp; Result (${m.joined || 0})</button>
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
    const inp = (id, lbl, ph) => `<div style="flex:1;min-width:120px;"><div class="lbl">${lbl}</div><input class="inp" id="${id}" type="number" min="0" placeholder="${ph || '0'}"></div>`;
    let h = '';
    if (F.prize === 'per_kill') h = inp('m-p-kill', 'Prize per Kill ₹');
    else if (F.prize === 'match_win') h = inp('m-p1', (F.mode === 'BR' ? 'Match Win Prize ₹' : 'Winning Team Prize ₹ (split equally)'));
    else {
      h = inp('m-p1', '🥇 1st Prize ₹');
      if (F.prize !== 'top1') h += inp('m-p2', '🥈 2nd Prize ₹');
      if (F.prize === 'top3') h += inp('m-p3', '🥉 3rd Prize ₹');
    }
    box.innerHTML = `<div class="fade-up" style="display:flex;gap:12px;flex-wrap:wrap;">${h}</div>` +
      (F.size > 1 && F.prize !== 'per_kill' ? '<div class="res-note">Team prize is split equally between all team members.</div>' : '');
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
    const prizes = { 1: g('m-p1'), 2: g('m-p2'), 3: g('m-p3') };
    const perKill = g('m-p-kill');
    if (F.prize === 'per_kill' && perKill <= 0) return A.toast('Enter prize per kill', 'err');
    if (F.prize !== 'per_kill' && prizes[1] <= 0) return A.toast('Enter the prize amount', 'err');
    const n = rankCount(F.prize);
    if (n >= 2 && prizes[2] <= 0) return A.toast('Enter 2nd prize', 'err');
    if (n >= 3 && prizes[3] <= 0) return A.toast('Enter 3rd prize', 'err');
    const prizeTbl = {}; for (let i = 1; i <= n; i++) prizeTbl[i] = prizes[i];
    const poolTotal = F.prize === 'per_kill' ? perKill : Object.values(prizeTbl).reduce((a, b) => a + b, 0);
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
      fee: g('m-fee'),
      map: document.getElementById('m-map').value,
      startTime,
      prizeTime: document.getElementById('m-prize-time').value || '',
      total,
      img: document.getElementById('m-img').value.trim(),
      joined: 0, status: 'upcoming', takenSlots: []
    };
    if (!confirm(`Create ${modeLabel} ${F.sub} match "${title}"?`)) return;
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
    document.getElementById('room-mid').value = id;
    document.getElementById('room-id').value = '';
    document.getElementById('room-pass').value = '';
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
            <div style="font-size:0.72rem;color:var(--sub);">${A.esc(p.gameName || '---')} • FF: ${A.esc(p.gameUid || '---')} • Slot #${p.slot || '-'}</div>
          </div>`;
        });
        list.innerHTML = html;
      }
      const bset = new Set((m.booyaPlayers || []).map(b => b.uid));
      document.getElementById('booya-player-list').innerHTML = players.map(p => `
        <div style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:8px 10px;margin-bottom:6px;border:1px solid #fecaca;">
          <input type="checkbox" id="by-${p.uid}" data-uid="${p.uid}" data-name="${A.esc(p.appName || 'User')}" ${bset.has(p.uid) ? 'checked' : ''} style="width:18px;height:18px;accent-color:#ef4444;">
          <label for="by-${p.uid}" style="font-weight:600;font-size:0.85rem;flex:1;">${A.esc(p.appName || 'User')}<br><span style="font-size:0.68rem;color:var(--sub);">${A.esc(p.gameUid || '---')}</span></label>
        </div>`).join('') || '<p style="font-size:0.78rem;color:var(--sub);">No players</p>';
    } catch (e) { list.innerHTML = '<p style="color:red;padding:20px;">Error loading players</p>'; }
  },

  // Options for a winner dropdown: players (solo) or whole teams (duo/squad/CS/LW)
  _winnerOptions(m) {
    const players = m.participants || [];
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
    const players = m.participants || [];
    if (!val) return null;
    if (val.startsWith('u:')) { const p = players.find(x => x.uid === val.slice(2)); return p ? { label: p.appName || 'User', members: [p] } : null; }
    const t = +val.slice(2);
    const members = players.filter(p => p.slot && teamOfSlot(p.slot, m) === t);
    return members.length ? { label: teamName(m, t), members } : null;
  },

  renderResultPanel(m) {
    const box = document.getElementById('result-panel');
    const players = m.participants || [];
    const pm = m.prizeMode || (m.matchType === 'per_kill' ? 'per_kill' : 'match_win');
    const prizeTimeRow = `
      <div class="lbl" style="margin-top:6px;">Prize Payout Time (shown to players)</div>
      <div style="display:flex;gap:8px;"><input class="inp" id="rs-ptime" type="datetime-local" value="${A.esc(m.prizeTime || '')}" style="background:#fff;margin-bottom:0;flex:1;">
      <button class="btn btn-outline" onclick="A.savePrizeTime()"><i class="fa-solid fa-clock"></i> Save</button></div>`;
    if (m.paid) {
      const w = (m.winners || []).map(x => `<div style="margin-top:6px;">${(RANKS[x.rank] || ['🏅'])[0]} <b>${A.esc((x.names || []).join(', '))}</b>${x.amount ? ' — ₹' + x.amount : ''}</div>`).join('');
      box.innerHTML = `<div class="done-banner"><div style="font-weight:800;">✅ Prizes already paid</div>${w}</div>`;
      return;
    }
    if (!players.length) { box.innerHTML = '<div class="res-box"><div class="res-note">Result options will appear after players join.</div></div>'; return; }
    let h = '';
    if (pm === 'per_kill') {
      const pk = Number((m.prizes && m.prizes[1]) || m.prize) || 0;
      h = `<div class="res-box"><h4>🎯 Per Kill — Enter Kills</h4>
        <div class="res-note">₹${pk} per kill. Enter kills for each player, then credit all.</div>
        ${players.map(p => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <div style="flex:1;font-weight:600;font-size:0.82rem;">${A.esc(p.appName || 'User')}<br><span style="font-size:0.68rem;color:var(--sub);">${A.esc(p.gameUid || '---')}${p.slot ? ' • Slot #' + p.slot : ''}</span></div>
          <input type="number" min="0" placeholder="Kills" class="inp" style="width:80px;margin:0;" data-uid="${p.uid}" data-name="${A.esc(p.appName || 'User')}" data-kill>
        </div>`).join('')}
        ${prizeTimeRow}
        <button class="btn btn-success btn-full" style="margin-top:12px;" onclick="A.creditKills()"><i class="fa-solid fa-coins"></i> Calculate & Credit All</button></div>`;
    } else {
      const n = rankCount(pm), opts = A._winnerOptions(m), team = (m.teamSize || 1) > 1;
      const pr = m.prizes || {};
      let rows = '';
      for (let i = 1; i <= n; i++) {
        const amt = Number(pr[i] || (i === 1 ? m.prize : 0)) || 0;
        rows += `<div class="rank-row" style="animation-delay:${i * 70}ms">
          <div class="rank-head"><span class="medal">${RANKS[i][0]}</span>${pm === 'match_win' ? (team ? 'Winning Team' : 'Match Winner') : RANKS[i][1] + ' Place'}</div>
          <select class="inp" id="rk-w${i}" style="background:#fff;" onchange="A.updateSplit(${i})"><option value="">-- Select ${team ? 'team' : 'player'} --</option>${opts}</select>
          <div class="lbl">Prize Amount ₹</div>
          <input class="inp" id="rk-a${i}" type="number" min="0" value="${amt || ''}" oninput="A.updateSplit(${i})" style="background:#fff;">
          <div class="rank-split" id="rk-s${i}"></div>
        </div>`;
      }
      h = `<div class="res-box"><h4>🏆 Select Winners</h4>
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
  updateSplit(i) {
    const m = A._M, el = document.getElementById('rk-s' + i); if (!el) return;
    const w = A._resolveWinner(m, document.getElementById('rk-w' + i).value);
    const amt = Number(document.getElementById('rk-a' + i).value) || 0;
    el.innerText = w ? (w.members.length > 1 ? `${w.members.length} members × ₹${r2(amt / w.members.length)} each` : `₹${amt} → ${w.label}`) : '';
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

  // 1st / 2nd / 3rd (or single winner): solo player or whole team, amount split equally
  async distributeRanks() {
    const m = A._M, matchId = m.id;
    if (await A._alreadyPaid(matchId)) return;
    const pm = m.prizeMode || 'match_win', n = rankCount(pm);
    const entries = [], used = new Set();
    for (let i = 1; i <= n; i++) {
      const w = A._resolveWinner(m, document.getElementById('rk-w' + i).value);
      const amt = Number(document.getElementById('rk-a' + i).value) || 0;
      if (!w) { if (i === 1) return A.toast('Select the 1st winner', 'err'); continue; }
      if (amt <= 0) return A.toast(`Enter prize amount for ${RANKS[i][1]}`, 'err');
      if (w.members.some(p => used.has(p.uid))) return A.toast('A player cannot win two places', 'err');
      w.members.forEach(p => used.add(p.uid));
      entries.push({ rank: i, label: w.label, members: w.members, amount: amt, per: r2(amt / w.members.length) });
    }
    const sum = entries.map(e => `${RANKS[e.rank][1]}: ${e.label} — ₹${e.amount}${e.members.length > 1 ? ` (₹${e.per} × ${e.members.length})` : ''}`).join('\n');
    if (!confirm(`Credit these prizes?\n\n${sum}`)) return;
    try {
      const writes = [], winMap = {};
      for (const e of entries) for (const p of e.members) {
        winMap[p.uid] = { amt: e.per, rank: e.rank };
        writes.push(...A._credit(p.uid, e.per, `Match win success: ₹${e.per}`, `${RANKS[e.rank][1]} place${e.members.length > 1 ? ' (team prize split)' : ''} — reward added to withdrawal balance.`, e.rank === 1, 0, p.appName));
      }
      await Promise.all(writes);
      const fresh = (await getDoc(doc(db, 'matches', matchId))).data() || {};
      const parts = (fresh.participants || []).map(p => winMap[p.uid] ? { ...p, winAmount: winMap[p.uid].amt, rank: winMap[p.uid].rank } : { ...p, winAmount: 0 });
      const winners = entries.map(e => ({ rank: e.rank, names: e.members.map(p => p.appName || 'User'), amount: e.amount, uids: e.members.map(p => p.uid) }));
      const first = entries.find(e => e.rank === 1);
      await updateDoc(doc(db, 'matches', matchId), {
        status: 'completed', paid: true, participants: parts, winners,
        winnerName: first ? first.members.map(p => p.appName || 'User').join(', ') : 'N/A',
        winnerUid: first ? first.members[0].uid : '', winnerUids: first ? first.members.map(p => p.uid) : [],
        paidAt: Date.now()
      });
      A.toast('Winners credited!'); A.closeModal('m-players'); A.loadMatches();
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  },

  // Per Kill: kills x amount per kill
  async creditKills() {
    const m = A._M, matchId = m.id;
    if (await A._alreadyPaid(matchId)) return;
    const perKill = Number((m.prizes && m.prizes[1]) || m.prize) || 0;
    if (perKill <= 0) return A.toast('Per-kill amount is not set for this match', 'err');
    const credits = [];
    document.querySelectorAll('#result-panel input[data-kill]').forEach(inp => {
      const kills = parseInt(inp.value) || 0;
      if (kills > 0) credits.push({ uid: inp.dataset.uid, name: inp.dataset.name, kills, amt: r2(kills * perKill) });
    });
    if (!credits.length) return A.toast('Enter kills for at least one player', 'err');
    if (!confirm('Credit these rewards?\n' + credits.map(c => `${c.name}: ${c.kills} kills × ₹${perKill} = ₹${c.amt}`).join('\n'))) return;
    try {
      const writes = [], killMap = {};
      for (const c of credits) {
        killMap[c.uid] = c;
        writes.push(...A._credit(c.uid, c.amt, `Match win success: ₹${c.amt} (${c.kills} kills)`, `Per Kill reward: ${c.kills} × ₹${perKill}.`, false, c.kills, c.name));
      }
      await Promise.all(writes);
      const fresh = (await getDoc(doc(db, 'matches', matchId))).data() || {};
      const parts = (fresh.participants || []).map(p => killMap[p.uid] ? { ...p, kills: killMap[p.uid].kills, winAmount: killMap[p.uid].amt } : { ...p, kills: 0, winAmount: 0 });
      const top = [...credits].sort((a, b) => b.kills - a.kills).slice(0, 3);
      await updateDoc(doc(db, 'matches', matchId), {
        status: 'completed', paid: true, participants: parts, paidAt: Date.now(),
        winners: top.map((c, i) => ({ rank: i + 1, names: [c.name], amount: c.amt, kills: c.kills, uids: [c.uid] })),
        winnerName: top[0].name
      });
      A.toast('Kill rewards credited!'); A.closeModal('m-players'); A.loadMatches();
    } catch (e) { A.toast('Error: ' + e.message, 'err'); }
  }
});
