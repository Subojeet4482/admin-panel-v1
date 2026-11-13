// Data tools: (1) Firebase storage usage  (2) delete a user's EVERY data (main + chat + proofs db + login accounts)
const $ = (id) => document.getElementById(id);
const esc = A.esc;
const fmt = (b) => { b = Number(b) || 0; if (b < 1024) return b + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < 3); return b.toFixed(b >= 100 ? 0 : b >= 10 ? 1 : 2) + ' ' + u[i]; };
const bar = (pct) => { const p = Math.min(100, Math.max(0, pct)); const c = p >= 85 ? '#dc2626' : p >= 60 ? '#f59e0b' : '#16a34a'; return `<div style="height:10px;border-radius:6px;background:rgba(128,128,128,.25);overflow:hidden;margin:6px 0;"><div style="height:100%;width:${Math.max(p, 1)}%;background:${c};"></div></div>`; };

Object.assign(A, {
  /* ---------- Storage usage ---------- */
  async showStorage(refresh) {
    if (!$('m-storage')) {
      document.body.insertAdjacentHTML('beforeend', `<div class="overlay" id="m-storage"><div class="sheet">
        <div class="sheet-title"><i class="fa-solid fa-database"></i> Firebase Storage</div>
        <div id="st-body"><div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        <div class="btn-row"><button class="btn btn-outline" style="flex:1;" onclick="A.closeModal('m-storage')">Close</button>
        <button class="btn btn-primary" style="flex:1;" onclick="A.showStorage(true)"><i class="fa-solid fa-rotate"></i> Refresh</button></div></div></div>`);
    }
    $('m-storage').classList.add('show');
    $('st-body').innerHTML = '<div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i> Counting… (thoda time lagta hai)</div>';
    try {
      const u = (await A.api('/api/storage/usage' + (refresh ? '?refresh=1' : ''))).usage;
      const block = (title, o, what) => o.error ? `<div class="muted" style="margin:6px 0;">${what}: ${esc(o.error)}</div>` :
        `<div style="margin:10px 0 2px;display:flex;justify-content:space-between;font-weight:800;"><span>${title}</span><span>${fmt(o.bytes)} / ${fmt(o.limit)}</span></div>${bar(o.pct)}
         <div class="muted" style="display:flex;justify-content:space-between;"><span>${o.pct}% used</span><b style="color:var(--text,inherit)">${fmt(o.left)} left</b></div>
         <div class="muted" style="margin-top:2px;">${o.docs != null ? o.docs.toLocaleString() + ' documents' : o.files.toLocaleString() + ' files'}</div>`;
      $('st-body').innerHTML = u.projects.map(p => `<div style="border:1px solid rgba(128,128,128,.3);border-radius:14px;padding:12px;margin-bottom:12px;">
          <div style="font-weight:900;font-size:1rem;">${esc(p.label)} <span class="muted" style="font-weight:600;">${esc(p.project_id || '')}</span></div>
          ${p.firestore ? block('Database (Firestore) ~', p.firestore, 'Database') : ''}
          ${p.firestore && p.firestore.collections ? `<details style="margin-top:8px;"><summary class="muted" style="cursor:pointer;">Biggest collections</summary>${p.firestore.collections.map(c => `<div style="display:flex;justify-content:space-between;font-size:.8rem;padding:3px 0;"><span>${esc(c.name)}</span><span class="muted">${c.docs.toLocaleString()} docs · ${fmt(c.bytes)}</span></div>`).join('')}</details>` : ''}
          ${p.storage ? block('Files (Storage)', p.storage, 'Files') : ''}</div>`).join('') +
        `<div class="muted" style="font-size:.74rem;">${esc(u.note)} Updated: ${new Date(u.at).toLocaleTimeString()}. Limits: Firestore ${'1 GB'} / Storage ${'5 GB'} (free plan; server env FIRESTORE_FREE_GB / STORAGE_FREE_GB se badal sakte ho).</div>`;
    } catch (e) { $('st-body').innerHTML = `<div class="empty-box">${esc(e.message)}</div>`; }
  },

  /* ---------- delete a user + EVERYTHING ---------- */
  async purgeUser(uid, name) {
    if (!uid) return A.toast('No user', 'err');
    const v = await A.askDanger({ title: `Delete ${name || uid} completely?`, text: 'User ka HAR data delete hoga: wallet, transactions, history, match entries, leaderboard, referral, chat (profile, DMs, groups, messages), proofs / likes / comments, aur login account. Undo nahi hoga.', typed: 'DELETE', backup: null, okLabel: 'Delete everything' });
    if (!v) return;
    let jid;
    try { jid = (await A.api(`/api/users/${encodeURIComponent(uid)}/purge`, { body: { pin: v.pin } })).jobId; } catch (e) { return A.fail(e); }
    const barEl = $('job-bar'), txt = $('job-txt'), ic = $('job-ic');
    barEl.className = 'job-bar'; ic.className = 'fa-solid fa-spinner fa-spin'; txt.innerText = 'Deleting user…';
    const tick = async () => {
      let j; try { j = (await A.api('/api/purge/' + jid)).job; } catch (e) { txt.innerText = e.message; return setTimeout(tick, 3000); }
      if (j.status === 'running') { txt.innerText = 'Deleting: ' + j.progress; return setTimeout(tick, 1200); }
      const bad = (j.steps || []).filter(s => !s.ok), good = j.status === 'done';
      barEl.className = 'job-bar ' + (good && !bad.length ? 'ok' : 'err'); ic.className = 'fa-solid ' + (good && !bad.length ? 'fa-circle-check' : 'fa-circle-exclamation');
      txt.innerText = good ? (bad.length ? `Deleted, but ${bad.length} step(s) failed` : 'User fully deleted ✓') : 'Failed: ' + (j.error || '');
      setTimeout(() => barEl.classList.add('hidden'), 6000);
      if (bad.length) alert('Ye steps fail hue:\n\n' + bad.map(s => '• ' + s.step + ': ' + s.error).join('\n'));
      try { A.closeModal('m-user'); } catch (e) {} try { A.dbmCloseUser && A.dbmCloseUser(); } catch (e) {}
      try { A._dbmUsersCache = null; A.loadUsers(true); } catch (e) {}
    };
    tick();
  },
  async deleteUser() { const uid = $('u-id').value; const n = ($('u-title') || {}).innerText; return A.purgeUser(uid, n); },
  async dbmDeleteUserCascade() { if (!A._dbmUser) return; return A.purgeUser(A._dbmUser.id, (A._dbmUser.data && A._dbmUser.data.appName) || A._dbmUser.id); }
});

/* ---------- Proofs moderation: see real UTR / gift code, delete posts + comments ---------- */
let _pl = 50;
Object.assign(A, {
  async showProofs(more) {
    if (!$('m-proofs')) {
      document.body.insertAdjacentHTML('beforeend', `<div class="overlay" id="m-proofs"><div class="sheet" style="max-height:92vh;overflow-y:auto;">
        <div class="sheet-title"><i class="fa-solid fa-receipt"></i> Proofs</div>
        <div class="muted" style="font-size:.74rem;margin-bottom:8px;">Yaha asli UTR / gift code poora dikhta hai (users ko sirf aadha). <b>Check</b>: proof ka amount asli transaction se match karta hai ya nahi.</div>
        <div id="pr-body"></div>
        <div class="btn-row"><button class="btn btn-outline" style="flex:1;" onclick="A.closeModal('m-proofs')">Close</button>
        <button class="btn btn-primary" style="flex:1;" onclick="A.showProofs(true)">Load more</button></div></div></div>`);
    }
    $('m-proofs').classList.add('show');
    if (more === true) _pl += 50; else _pl = 50;
    $('pr-body').innerHTML = '<div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    try {
      const items = (await A.api('/api/proofs/list?limit=' + _pl)).items;
      const chk = { ok: ['#16a34a', '✓ Matches real transaction'], mismatch: ['#dc2626', '⚠ Amount does NOT match'], missing: ['#dc2626', '⚠ Real transaction not found'] };
      $('pr-body').innerHTML = items.length ? items.map(p => {
        const c = chk[p.check] || chk.ok, r = p.real || {};
        const id = esc(p.id).replace(/'/g, '');
        return `<div style="border:1px solid rgba(128,128,128,.3);border-radius:14px;padding:10px 12px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;"><b>${esc(p.name || '')} <span class="muted" style="font-weight:600;">${esc(p.uid || '')}</span></b><span class="muted" style="font-size:.72rem;">${p.createdAt ? new Date(p.createdAt).toLocaleString() : ''}</span></div>
          <div style="margin:3px 0;font-weight:800;">${esc(p.kind || '')} · ${esc(p.amount || '')} <span class="muted" style="font-weight:600;">${esc(p.via || '')}</span></div>
          ${p.text ? `<div style="margin:4px 0;font-size:.85rem;">“${esc(p.text)}”</div>` : ''}
          <div style="font-size:.78rem;margin:4px 0;"><span style="color:${c[0]};font-weight:800;">${c[1]}</span>
            ${r.utr ? `<br>UTR / Txn: <b style="user-select:all;">${esc(r.utr)}</b>` : ''}${r.giftCode ? `<br>Gift code: <b style="user-select:all;">${esc(r.giftCode)}</b>` : ''}${r.upiId ? `<br>UPI: <b>${esc(r.upiId)}</b>` : ''}${r.status ? `<br>Status: ${esc(r.status)} · Order ${esc(p.orderNo || '')}` : ''}</div>
          <div style="display:flex;gap:8px;margin-top:6px;align-items:center;"><span class="muted" style="font-size:.76rem;flex:1;">👍 ${p.likeCount} · 💬 ${p.commentCount}</span>
            <button class="btn btn-outline" style="padding:6px 10px;" onclick="A.proofComments('${id}')">Comments</button>
            <button class="btn btn-danger" style="padding:6px 10px;" onclick="A.proofDelete('${id}')"><i class="fa-solid fa-trash"></i> Delete</button></div>
          <div id="prc-${id}"></div></div>`;
      }).join('') : '<div class="empty-box">Abhi koi proof nahi</div>';
    } catch (e) { $('pr-body').innerHTML = `<div class="empty-box">${esc(e.message)}</div>`; }
  },
  async proofDelete(id) {
    const v = await A.askDanger({ title: 'Delete this proof?', text: 'Proof, uske likes aur comments delete honge. User ye transaction dobara share kar sakta hai.', backup: null, okLabel: 'Delete proof' });
    if (!v) return;
    try { await A.api(`/api/proofs/${encodeURIComponent(id)}/delete`, { body: { pin: v.pin } }); A.toast('Proof deleted', 'ok'); A.showProofs(); } catch (e) { A.fail(e); }
  },
  async proofComments(id) {
    const box = $('prc-' + id); if (!box) return;
    if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = ''; return; }
    box.dataset.open = '1'; box.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const items = (await A.api(`/api/proofs/${encodeURIComponent(id)}/comments`)).items;
      box.innerHTML = items.length ? items.map(c => `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-top:1px dashed rgba(128,128,128,.3);font-size:.8rem;">
        <div style="flex:1;"><b>${esc(c.name || '')}</b> <span class="muted">${c.at ? new Date(c.at).toLocaleString() : ''}</span><br>${esc(c.text || '')}</div>
        <button class="btn btn-danger" style="padding:4px 8px;" onclick="A.commentDelete('${id}','${esc(c.id).replace(/'/g, '')}')"><i class="fa-solid fa-trash"></i></button></div>`).join('') : '<div class="muted">No comments</div>';
    } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  },
  async commentDelete(pid, cid) {
    const v = await A.askDanger({ title: 'Delete this comment?', text: '', backup: null, okLabel: 'Delete comment' });
    if (!v) return;
    try { await A.api(`/api/proofs/${encodeURIComponent(pid)}/comments/${encodeURIComponent(cid)}/delete`, { body: { pin: v.pin } }); const b = $('prc-' + pid); if (b) { b.dataset.open = ''; } A.proofComments(pid); } catch (e) { A.fail(e); }
  }
});
