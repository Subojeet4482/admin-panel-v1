// Refer System admin: settings + totals + recent referrals (+ void). Server: referral.py (/api/ref/admin/*)
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (id) => Number($(id).value || 0);
const inr = (v) => '₹' + (Math.round(Number(v || 0) * 100) / 100).toLocaleString('en-IN');

const preview = () => {
  const per = n('rf-per') || 1, dep = n('rf-dep'), rnd = $('rf-mode').value === 'random';
  const amt = rnd ? inr(n('rf-min')) + ' – ' + inr(n('rf-max')) + ' (random)' : inr(n('rf-fixed')) + ' (fixed)';
  $('rf-preview').innerHTML = `<b>Example:</b> every <b>${per}</b> friend${per > 1 ? 's' : ''} who joins${dep > 0 ? ' <b>and deposits ' + inr(dep) + '</b>' : ' (<b>no deposit needed</b>)'} → <b>1 scratch card</b> worth <b>${amt}</b>, added to the user's <b>${$('rf-to').value === 'withdraw' ? 'withdrawable' : 'deposit'} balance</b>.`;
};
const fill = (c) => {
  $('rf-enabled').value = c.enabled ? '1' : '0'; $('rf-per').value = c.referralsPerCard; $('rf-dep').value = c.depositRequired; $('rf-mode').value = c.amountMode;
  $('rf-fixed').value = c.fixedAmount; $('rf-min').value = c.minAmount; $('rf-max').value = c.maxAmount; $('rf-to').value = c.creditTo;
  $('rf-win').value = c.claimWindowHrs; $('rf-maxref').value = c.maxReferralsPerUser; $('rf-maxcard').value = c.maxCardsPerUser; preview();
};
const chip = (s) => s === 'qualified' ? '<span class="tag" style="background:#dcfce7;color:#15803d">Qualified</span>' : s === 'void' ? '<span class="tag" style="background:#fee2e2;color:#b91c1c">Void</span>' : '<span class="tag" style="background:#fef3c7;color:#b45309">Waiting deposit</span>';

Object.assign(window.A, {
  async referLoad() {
    ['rf-enabled', 'rf-per', 'rf-dep', 'rf-mode', 'rf-fixed', 'rf-min', 'rf-max', 'rf-to'].forEach(id => { const e = $(id); if (e && !e._p) { e._p = 1; e.addEventListener('input', preview); e.addEventListener('change', preview); } });
    try {
      const r = await A.api('/api/ref/admin/overview'); if (!r.ok) throw new Error(r.error || 'failed');
      fill(r.cfg); const t = r.totals || {};
      $('rf-stats').innerHTML = [['Friends joined', t.referrals || 0], ['Cards issued', t.cardsIssued || 0], ['Cards scratched', t.cardsScratched || 0], ['Paid out', inr(t.paid)]]
        .map(([k, v]) => `<div style="display:inline-block;min-width:46%;margin:2px 0"><div class="muted" style="font-size:.7rem">${k}</div><div style="font-weight:800;font-size:1.05rem;color:var(--text,#0f172a)">${v}</div></div>`).join('');
      $('rf-list').innerHTML = (r.referrals || []).length ? r.referrals.map(x => `<div style="display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid var(--border,#eee)">
        <div style="flex:1;min-width:0"><div style="font-weight:700">${esc(x.name || 'Player')}</div><div class="muted" style="font-size:.7rem;word-break:break-all">joined with code ${esc(x.code)} · ${x.at ? new Date(x.at).toLocaleString('en-IN') : ''}</div><div class="muted" style="font-size:.66rem;word-break:break-all">${esc(x.referred)}</div></div>
        ${chip(x.status)}${x.status !== 'void' ? `<button class="btn btn-danger" style="padding:4px 9px;font-size:.7rem" onclick="A.referVoid('${esc(x.referred)}')">Void</button>` : ''}</div>`).join('') : '<span class="muted">No referrals yet.</span>';
    } catch (e) { $('rf-list').innerHTML = '<span class="muted">Could not load: ' + esc(e.message || e) + '</span>'; }
  },
  async referSave() {
    try {
      const r = await A.api('/api/ref/admin/config', { body: { enabled: $('rf-enabled').value === '1', referralsPerCard: n('rf-per'), depositRequired: n('rf-dep'), amountMode: $('rf-mode').value, fixedAmount: n('rf-fixed'),
        minAmount: n('rf-min'), maxAmount: n('rf-max'), creditTo: $('rf-to').value, claimWindowHrs: n('rf-win'), maxReferralsPerUser: n('rf-maxref'), maxCardsPerUser: n('rf-maxcard') } });
      if (!r.ok) throw new Error(r.error || 'failed'); fill(r.cfg); A.toast('Refer settings saved ✓');
    } catch (e) { A.toast('Error: ' + (e.message || e), 'err'); }
  },
  async referVoid(uid) {
    if (!confirm('Void this referral? Its referrer loses the credit; unscratched cards that are no longer earned are removed (scratched cards stay).')) return;
    try { const r = await A.api('/api/ref/admin/void', { body: { referred: uid } }); if (!r.ok) throw new Error(r.error || 'failed'); A.toast('Voided ✓'); A.referLoad(); } catch (e) { A.toast('Error: ' + (e.message || e), 'err'); }
  }
});
