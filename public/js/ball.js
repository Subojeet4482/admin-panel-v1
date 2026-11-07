// Coin Battle — admin control (settings, totals, recent games). Server: /api/ball/admin/*
const $ = (id) => document.getElementById(id);
const esc = A.esc || ((s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])));
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fill = (c) => { $('bl-enabled').checked = !!c.enabled; $('bl-bots').checked = !!c.botsEnabled; $('bl-entries').value = (c.entries || []).join(','); $('bl-cut').value = c.cutPct; $('bl-prac').value = c.practicePerDay; $('bl-fails').value = c.botAfterFails; $('bl-search').value = c.searchSec; $('bl-turn').value = c.turnSec; $('bl-auto').value = c.maxAuto; $('bl-depth').value = c.botDepth; $('bl-ms').value = c.botMs; };
Object.assign(A, {
  async ballLoad() {
    try {
      const r = await A.api('/api/ball/admin/overview'); fill(r.cfg); const t = r.totals;
      $('ball-stats').innerHTML = [['Games', t.games], ['vs Bot', t.botGames], ['Entries in', inr(t.entries)], ['Prizes paid', inr(t.payouts)], ['Refunds', inr(t.refunds)], ['House net', inr(t.houseNet), t.houseNet >= 0 ? 'ok' : 'bad'], ['Live now', r.live], ['Searching', r.queue]]
        .map(x => `<div class="bs ${x[2] || ''}"><small>${x[0]}</small><b>${x[1]}</b></div>`).join('');
      $('ball-games').innerHTML = r.games.length ? r.games.map(g => {
        const p = g.players || [], nm = (i) => p[i] ? esc(p[i].name) + (p[i].bot ? ' <em class="bot">BOT</em>' : '') : '?';
        const res = g.status !== 'done' ? '<span class="tag gold">LIVE</span>' : g.winner === -1 ? '<span class="tag">DRAW</span>' : `<span class="tag green">${nm(g.winner).replace(/<em.*$/, '')} won</span>`;
        return `<div class="bg-row"><div><b>${nm(0)} <span class="vs">vs</span> ${nm(1)}</b><small>${g.practice ? 'Practice' : inr(g.stake) + ' entry'} · ${g.moves} moves · ${esc(g.reason || '')} · ${new Date(g.t).toLocaleString()}</small></div><div>${res}${g.prize ? `<small style="display:block;text-align:right">${inr(g.prize)}</small>` : ''}</div></div>`;
      }).join('') : '<span class="muted">No games yet</span>';
    } catch (e) { A.fail(e); }
  },
  async ballSave() {
    const n = (id) => parseInt($(id).value, 10);
    try {
      await A.api('/api/ball/admin/config', { body: { enabled: $('bl-enabled').checked, botsEnabled: $('bl-bots').checked, entries: $('bl-entries').value.split(',').map(x => parseInt(x, 10)).filter(x => x > 0), cutPct: n('bl-cut'), practicePerDay: n('bl-prac'), botAfterFails: n('bl-fails'), searchSec: n('bl-search'), turnSec: n('bl-turn'), maxAuto: n('bl-auto'), botDepth: n('bl-depth'), botMs: n('bl-ms') } });
      A.toast('Coin Battle settings saved ✓'); A.ballLoad();
    } catch (e) { A.fail(e); }
  }
});
