// Fruit Slash — admin control (settings, totals, recent games). Server: /api/fruit/admin/*
const $ = (id) => document.getElementById(id);
const esc = A.esc || ((s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])));
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fill = (c) => { $('fr-enabled').checked = !!c.enabled; $('fr-free').checked = c.freeEnabled !== false; $('fr-entries').value = (c.entries || []).join(','); $('fr-cut').value = c.cutPct; $('fr-dur').value = c.durationSec; $('fr-search').value = c.paidSearchSec; $('fr-max').value = c.maxStake; };
Object.assign(A, {
  async fruitLoad() {
    try {
      const r = await A.api('/api/fruit/admin/overview'); fill(r.cfg); const t = r.totals;
      $('fruit-stats').innerHTML = [['Games', t.games], ['Entries in', inr(t.entries)], ['Prizes paid', inr(t.payouts)], ['House net', inr(t.houseNet), t.houseNet >= 0 ? 'ok' : 'bad'], ['Live now', r.live], ['Searching', r.queue]]
        .map(x => `<div class="bs ${x[2] || ''}"><small>${x[0]}</small><b>${x[1]}</b></div>`).join('');
      $('fruit-games').innerHTML = r.games.length ? r.games.map(g => {
        const p = g.players || [], nm = (i) => p[i] ? esc(p[i].name) : '?', sc = g.scores || [0, 0];
        const res = g.status !== 'done' ? '<span class="tag gold">LIVE</span>' : g.winner < 0 ? '<span class="tag">Draw — refunded</span>' : `<span class="tag green">${nm(g.winner)} won</span>`;
        return `<div class="bg-row"><div><b>${nm(0)} <span class="vs">vs</span> ${nm(1)}</b><small>${inr(g.stake)} entry · score ${sc[0]} – ${sc[1]} · ${esc(g.reason || '')} · ${new Date(g.t).toLocaleString()}</small></div><div>${res}${g.prize ? `<small style="display:block;text-align:right">${inr(g.prize)}</small>` : ''}</div></div>`;
      }).join('') : '<span class="muted">No games yet</span>';
    } catch (e) { A.fail(e); }
  },
  async fruitToggle(el) {
    const on = el.checked;
    try { await A.api('/api/fruit/admin/config', { body: { enabled: on } }); A.toast('Fruit Slash ' + (on ? 'ON — visible in the app' : 'OFF — hidden from the app') + ' ✓'); }
    catch (e) { el.checked = !on; A.fail(e); }
  },
  async fruitSave() {
    const n = (id) => parseInt($(id).value, 10);
    try {
      await A.api('/api/fruit/admin/config', { body: { enabled: $('fr-enabled').checked, freeEnabled: $('fr-free').checked, entries: $('fr-entries').value.split(',').map(x => parseInt(x, 10)).filter(x => x > 0), cutPct: n('fr-cut'), durationSec: n('fr-dur'), paidSearchSec: n('fr-search'), maxStake: n('fr-max') } });
      A.toast('Fruit Slash settings saved ✓'); A.fruitLoad();
    } catch (e) { A.fail(e); }
  }
});
