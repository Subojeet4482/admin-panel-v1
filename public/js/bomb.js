// Bomb & Gems — admin control (settings, totals, recent games). Server: /api/bomb/admin/*
const $ = (id) => document.getElementById(id);
const esc = A.esc || ((s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])));
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fill = (c) => { $('bm-enabled').checked = !!c.enabled; $('bm-bots').checked = !!c.botsEnabled; $('bm-entries').value = (c.entries || []).join(','); $('bm-cut').value = c.cutPct; $('bm-prac').value = c.practicePerDay; $('bm-fails').value = c.botAfterFails; $('bm-search').value = c.searchSec; $('bm-psearch').value = c.paidSearchSec; $('bm-turn').value = c.turnSec; $('bm-auto').value = c.maxAuto; $('bm-minb').value = c.minBombs; $('bm-maxb').value = c.maxBombs; $('bm-ms').value = c.botMs; };
Object.assign(A, {
  async bombLoad() {
    try {
      const r = await A.api('/api/bomb/admin/overview'); fill(r.cfg); const t = r.totals;
      $('bomb-stats').innerHTML = [['Games', t.games], ['vs Bot', t.botGames], ['Entries in', inr(t.entries)], ['Prizes paid', inr(t.payouts)], ['House net', inr(t.houseNet), t.houseNet >= 0 ? 'ok' : 'bad'], ['Live now', r.live], ['Searching', r.queue]]
        .map(x => `<div class="bs ${x[2] || ''}"><small>${x[0]}</small><b>${x[1]}</b></div>`).join('');
      $('bomb-games').innerHTML = r.games.length ? r.games.map(g => {
        const p = g.players || [], nm = (i) => p[i] ? esc(p[i].name) + (p[i].bot ? ' <em class="bot">BOT</em>' : '') : '?';
        const res = g.status !== 'done' ? '<span class="tag gold">LIVE</span>' : `<span class="tag green">${nm(g.winner).replace(/<em.*$/, '')} won</span>`;
        return `<div class="bg-row"><div><b>${nm(0)} <span class="vs">vs</span> ${nm(1)}</b><small>${g.practice ? 'Practice' : inr(g.stake) + ' entry'} · ${g.moves} moves · ${esc(g.reason || '')} · ${new Date(g.t).toLocaleString()}</small></div><div>${res}${g.prize ? `<small style="display:block;text-align:right">${inr(g.prize)}</small>` : ''}</div></div>`;
      }).join('') : '<span class="muted">No games yet</span>';
    } catch (e) { A.fail(e); }
  },
  async bombSave() {
    const n = (id) => parseInt($(id).value, 10);
    try {
      await A.api('/api/bomb/admin/config', { body: { enabled: $('bm-enabled').checked, botsEnabled: $('bm-bots').checked, entries: $('bm-entries').value.split(',').map(x => parseInt(x, 10)).filter(x => x > 0), cutPct: n('bm-cut'), practicePerDay: n('bm-prac'), botAfterFails: n('bm-fails'), searchSec: n('bm-search'), paidSearchSec: n('bm-psearch'), turnSec: n('bm-turn'), maxAuto: n('bm-auto'), minBombs: n('bm-minb'), maxBombs: n('bm-maxb'), botMs: n('bm-ms') } });
      A.toast('Bomb & Gems settings saved ✓'); A.bombLoad();
    } catch (e) { A.fail(e); }
  }
});
