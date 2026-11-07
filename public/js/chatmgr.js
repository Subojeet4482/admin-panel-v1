// Chat Manager: overview + world-room settings, users (profile, friends, requests, chats, game history), groups, reports
const $ = (id) => document.getElementById(id);
const esc = A.esc;
const ago = (ms) => { if (!ms) return '—'; const d = Date.now() - ms; if (d < 6e4) return 'now'; if (d < 36e5) return Math.floor(d / 6e4) + 'm ago'; if (d < 864e5) return Math.floor(d / 36e5) + 'h ago'; return Math.floor(d / 864e5) + 'd ago'; };
const av = (n, p) => p ? `<img class="cm-av" src="${esc(p)}" onerror="this.outerHTML='<div class=\\'cm-av t\\'>${esc((n || '?')[0] || '?')}</div>'">` : `<div class="cm-av t">${esc((n || '?')[0] || '?').toUpperCase()}</div>`;
const CM = { sub: 'ov', q: '', t: null, cur: null };

Object.assign(window.A, {
  cmOpen() { A.cmSub(CM.sub); A.cmBadge(); },
  async cmBadge() { try { const o = await A.api('/api/chatadm/overview'); const d = $('cm-dot'); if (d) { d.textContent = o.reports_open; d.style.display = o.reports_open ? 'flex' : 'none'; } } catch (e) {} },
  cmSub(s) {
    CM.sub = s; document.querySelectorAll('#cm-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.s === s));
    const body = $('cm-body'); body.innerHTML = '<div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i>Loading…</div>';
    ({ ov: A.cmOverview, us: A.cmUsers, gr: A.cmGroups, rp: A.cmReports })[s]();
  },
  /* ---------- overview + world room settings ---------- */
  async cmOverview() {
    try {
      const o = await A.api('/api/chatadm/overview'), w = o.world_cfg;
      const stat = (ic, v, l, c) => `<div class="cm-stat" style="--c:${c}"><i class="fa-solid ${ic}"></i><b>${v}</b><span>${l}</span></div>`;
      $('cm-body').innerHTML = `
        <div class="card cm-db fade-up"><i class="fa-solid fa-database"></i><div style="flex:1;"><b>Chat database</b><small>${o.separate ? 'Separate project (FIREBASE_CREDENTIALS_B641)' : 'Main project (set FIREBASE_CREDENTIALS_B641 to use a separate chat database)'}</small></div><span class="tag ${o.separate ? 'green' : 'gold'}">${o.separate ? 'SEPARATE' : 'MAIN'}</span></div>
        <div class="cm-stats fade-up">${stat('fa-user', o.profiles, 'Profiles', '#6366f1')}${stat('fa-user-plus', o.pending_requests, 'Pending req.', '#f59e0b')}${stat('fa-comments', o.chats, 'Friend chats', '#0ea5e9')}${stat('fa-user-group', o.groups, 'Groups', '#8b5cf6')}${stat('fa-earth-asia', o.world, 'World msgs', '#ec4899')}${stat('fa-flag', o.reports_open, 'Open reports', '#ef4444')}${stat('fa-ban', o.banned, 'Banned', '#64748b')}${stat('fa-lock', o.private, 'Private', '#14b8a6')}</div>
        <div class="card fade-up"><div class="card-h"><i class="fa-solid fa-earth-asia"></i> World room</div>
          <div style="display:flex;gap:10px;"><div style="width:84px;"><div class="lbl" style="margin-top:0;">Emoji</div><input class="inp" id="cw-emoji" value="${esc(w.emoji)}" maxlength="4" style="text-align:center;font-size:1.3rem;"></div><div style="flex:1;"><div class="lbl" style="margin-top:0;">Room name</div><input class="inp" id="cw-name" value="${esc(w.name)}" maxlength="30"></div></div>
          <div class="lbl">Tagline</div><input class="inp" id="cw-tag" value="${esc(w.tagline)}" maxlength="80">
          <div style="display:flex;gap:10px;align-items:center;"><div style="flex:1;"><div class="lbl" style="margin-top:0;">Slow mode (seconds, 0 = off)</div><input class="inp" id="cw-slow" type="number" min="0" max="120" value="${w.slow || 0}"></div>
          <label class="ls-switch2" style="margin-top:14px;"><input type="checkbox" id="cw-lock" ${w.locked ? 'checked' : ''}><i></i><span>Lock</span></label></div>
          <div class="lbl">World &amp; group message life (hours, 1–168). Friend chats (DM) always live 7 days</div><input class="inp" id="cw-ttl" type="number" min="1" max="168" value="${w.ttlHours || 24}">
          <div class="muted" style="margin:-4px 0 10px;font-size:.7rem;">Default 24h. Expired messages are hidden in the app at once and deleted from the database by the Backup Center (daily) + by users' phones.</div>
          <button class="btn btn-primary btn-full" onclick="A.cmSaveWorld()"><i class="fa-solid fa-floppy-disk"></i> Save world room</button>
          <div class="btn-row" style="margin-top:10px;"><button class="btn btn-outline" style="flex:1;" onclick="A.cmMsgs('world','world','World room')"><i class="fa-solid fa-eye"></i> View messages</button><button class="btn btn-danger" style="flex:1;" onclick="A.cmWorldClear()"><i class="fa-solid fa-broom"></i> Clear all</button></div></div>
        <div class="card fade-up"><div class="card-h"><i class="fa-solid fa-circle-check" style="color:#1d9bf0"></i> Blue ticks</div>
          <div class="muted" style="margin-bottom:10px;font-size:.74rem;">Blue tick user: glowing blue tick + pink-purple name, and can <b>edit / delete any message</b> (World, groups, chats he is in). Works in the main chat database and in any separate chat project you connect later.</div>
          <div style="display:flex;gap:8px;"><input class="inp" id="bt-q" placeholder="@username / Player ID / UID" autocomplete="off" style="flex:1;"><button class="btn btn-primary" onclick="A.cmTickGive()"><i class="fa-solid fa-circle-check"></i> Give</button></div>
          <div id="bt-list" style="margin-top:10px;"></div>
          <button class="btn btn-outline btn-full" style="margin-top:8px;" onclick="A.cmSyncTicks()"><i class="fa-solid fa-rotate"></i> Sync blue ticks to chat database</button></div>
        <div class="muted fade-up" style="padding:0 6px;">Rules: max 20 friends per user · messages can be edited / deleted by the sender only within 10 minutes.</div>`;
    A.cmTickList();
    } catch (e) { $('cm-body').innerHTML = `<div class="empty-box" style="padding:24px;">${esc(e.message)}<br><small>Check FIREBASE_CREDENTIALS_B641 and the chat project.</small></div>`; }
  },
  async cmTickList() {
    const box = $('bt-list'); if (!box) return;
    try {
      const r = await A.api('/api/chatadm/verified');
      box.innerHTML = r.users.length ? r.users.map(u => `<div class="cm-row">${av(u.name, u.photo)}<div class="mg-rt"><b>${esc(u.name)} <i class="fa-solid fa-circle-check" style="color:#1d9bf0"></i></b><small>${u.username ? '@' + esc(u.username) + ' · ' : ''}${esc(u.uid.slice(0, 10))}…</small></div><button class="btn btn-danger" style="padding:6px 10px;" onclick="A.cmTick('${esc(u.uid)}',false)"><i class="fa-solid fa-xmark"></i></button></div>`).join('') : '<div class="muted" style="padding:6px 0;">No blue tick users yet</div>';
    } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  },
  async cmTickGive() {
    const q = ($('bt-q').value || '').trim(); if (!q) return A.toast('Enter @username, Player ID or UID', 'err');
    try { await A.api('/api/chatadm/verify-by', { body: { q, verified: true } }); A.toast('Blue tick given ✓', 'ok'); $('bt-q').value = ''; A.cmTickList(); } catch (e) { A.fail(e); }
  },
  async cmTick(uid, on, reload) {
    if (!on && !confirm('Remove blue tick?')) return;
    try { await A.api('/api/chatadm/verify', { body: { uid, verified: on } }); A.toast(on ? 'Blue tick given ✓' : 'Blue tick removed', 'ok'); if (reload) A.cmUser(uid); else A.cmTickList(); } catch (e) { A.fail(e); }
  },
  async cmSyncTicks() { try { const r = await A.api('/api/chatadm/verify-sync', { body: {} }); A.toast(r.synced + ' blue ticks synced', 'ok'); } catch (e) { A.fail(e); } },
  async cmSaveWorld() {
    try { await A.api('/api/chatadm/world', { body: { emoji: $('cw-emoji').value, name: $('cw-name').value, tagline: $('cw-tag').value, slow: parseInt($('cw-slow').value, 10) || 0, locked: $('cw-lock').checked, ttlHours: parseInt($('cw-ttl').value, 10) || 24 } }); A.toast('World room saved ✓'); } catch (e) { A.fail(e); }
  },
  async cmWorldClear() {
    const v = await A.askDanger({ title: 'Clear the whole world chat?', text: 'All world-room messages are deleted. (Use Data Center → Chat Messages to back them up first.)', typed: 'CLEAR', backup: null, okLabel: 'Clear' }); if (!v) return;
    try { const r = await A.api('/api/chatadm/world/clear', { body: { pin: v.pin } }); A.toast(r.deleted + ' messages deleted'); } catch (e) { A.fail(e); }
  },
  /* ---------- users ---------- */
  async cmUsers() {
    $('cm-body').innerHTML = `<div class="card"><div class="mg-search"><i class="fa-solid fa-magnifying-glass"></i><input class="inp" id="cm-q" placeholder="Search username / name / UID" value="${esc(CM.q)}" oninput="A.cmUserSearch(this.value)" autocomplete="off"></div></div><div id="cm-ulist"></div><div id="cm-udetail"></div>`;
    A.cmUserSearch(CM.q, true);
  },
  cmUserSearch(q, now) {
    CM.q = q; clearTimeout(CM.t);
    CM.t = setTimeout(async () => {
      const box = $('cm-ulist'); if (!box) return; box.innerHTML = '<div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i></div>';
      try { const r = await A.api('/api/chatadm/users?q=' + encodeURIComponent(q || ''));
        box.innerHTML = r.users.length ? r.users.map((u, i) => `<div class="mg-res" style="animation-delay:${Math.min(i, 8) * 30}ms" onclick="A.cmUser('${esc(u.id)}')">${av(u.name, u.photo)}<div class="mg-rt"><b>${esc(u.name)} ${u.banned ? '<span class="tag red">BANNED</span>' : ''} ${u.isPrivate ? '<i class="fa-solid fa-lock" style="font-size:.7rem;color:var(--sub)"></i>' : ''}</b><small>@${esc(u.username)} · ${u.online ? '🟢 online' : 'seen ' + ago(u.lastSeen)}</small></div></div>`).join('') : '<div class="empty-box" style="padding:20px;">No chat users found</div>';
      } catch (e) { box.innerHTML = `<div class="empty-box">${esc(e.message)}</div>`; }
    }, now ? 0 : 280);
  },
  async cmUser(uid) {
    const box = $('cm-udetail'); box.innerHTML = '<div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i>Loading full record…</div>'; $('cm-ulist').innerHTML = '';
    try {
      const d = await A.api('/api/chatadm/user/' + uid), p = d.profile; CM.cur = uid;
      const person = (x) => `<div class="cm-row">${av(x.name, x.photo)}<div class="mg-rt"><b>${esc(x.name)} ${x.starred ? '⭐' : ''}</b><small>@${esc(x.username || '')}${x.nick ? ' · nickname: ' + esc(x.nick) : ''}</small></div></div>`;
      const sec = (title, n, inner, open) => `<details class="card us-sec fade-up" ${open ? 'open' : ''}><summary>${title} <b>${n}</b></summary><div>${inner || '<div class="muted" style="padding:10px 0;">None</div>'}</div></details>`;
      box.innerHTML = `<div class="card us-head fade-up"><div class="mgu-top">${av(p.name, p.photo).replace('cm-av', 'cm-av big')}<div style="flex:1;min-width:0;"><div class="mgu-name">${esc(p.name)} ${d.verified ? '<i class="fa-solid fa-circle-check" style="color:#1d9bf0"></i>' : ''} ${p.banned ? '<span class="tag red">BANNED</span>' : ''}</div>
          <div class="mgu-sub">@<b>${esc(p.username)}</b> · ${p.isPrivate ? '🔒 Private' : '🌍 Public'} · ${p.online ? '🟢 online' : 'seen ' + ago(p.lastSeen)}</div><div class="mgu-sub">UID: <b>${esc(p.id)}</b> <button class="copy-btn" onclick="A.copyText('${esc(p.id)}')"><i class="fa-regular fa-copy"></i></button></div>${p.bio ? `<div class="mgu-sub">“${esc(p.bio)}”</div>` : ''}</div></div>
          <div class="us-stats"><div><b>${d.friends.length}/20</b><small>Friends</small></div><div><b>${d.incoming.filter(r => r.status === 'pending').length}</b><small>Incoming</small></div><div><b>${d.outgoing.filter(r => r.status === 'pending').length}</b><small>Sent</small></div><div><b>${d.blocked.length}</b><small>Blocked</small></div><div><b>${d.games.length}</b><small>Games</small></div></div>
          <div class="btn-row" style="margin-top:12px;"><button class="btn ${d.verified ? 'btn-outline' : 'btn-primary'}" style="flex:1;" onclick="A.cmTick('${esc(p.id)}',${!d.verified},true)"><i class="fa-solid fa-circle-check" style="color:#1d9bf0"></i> ${d.verified ? 'Remove blue tick' : 'Give blue tick'}</button></div>
          <div class="btn-row" style="margin-top:8px;"><button class="btn ${p.banned ? 'btn-success' : 'btn-danger'}" style="flex:1;" onclick="A.cmBan('${esc(p.id)}',${!p.banned})"><i class="fa-solid ${p.banned ? 'fa-unlock' : 'fa-ban'}"></i> ${p.banned ? 'Unban from chat' : 'Ban from chat'}</button><button class="btn btn-outline" style="flex:1;" onclick="A.moneyFromChat('${esc(p.id)}')"><i class="fa-solid fa-id-card"></i> App record</button></div></div>
        ${sec('<i class="fa-solid fa-comments"></i> Friend chats', d.chats.length, d.chats.map(c => `<div class="cm-row click" onclick="A.cmMsgs('dm','${esc(c.id)}','${esc(p.name)} ↔ ${esc(c.with ? c.with.name : '?')}')">${av(c.with && c.with.name, c.with && c.with.photo)}<div class="mg-rt"><b>${esc(c.with ? c.with.name : '?')}</b><small>${esc(c.lastMsg || 'no messages')} · ${ago(c.lastAt)}</small></div><i class="fa-solid fa-chevron-right" style="color:var(--sub)"></i></div>`).join(''), true)}
        ${sec('<i class="fa-solid fa-user-group"></i> Friends', d.friends.length, d.friends.map(person).join(''))}
        ${sec('<i class="fa-solid fa-gamepad"></i> Game history', d.games.length, d.games.map(g => g.error ? `<div class="muted">${esc(g.error)}</div>` : `<div class="us-row"><div><b>${esc(g.title || g.id)}</b><div class="lg-meta">${esc(g.code || '')} · ${esc(g.mode || '')} · ${esc(g.status || '')}${g.kills ? ' · ' + g.kills + ' kills' : ''}${g.rank ? ' · rank ' + esc(g.rank) : ''}</div></div><b class="${g.win > 0 ? 'pos' : ''}">${g.win > 0 ? '+₹' + g.win : '₹' + (g.fee || 0)}</b></div>`).join(''))}
        ${sec('<i class="fa-solid fa-user-plus"></i> Requests', d.incoming.length + d.outgoing.length, d.incoming.map(r => `<div class="us-row"><span>⬅ from <b>${esc(r.fromName || r.from.slice(0, 6))}</b></span><span class="st st-${r.status === 'pending' ? 'pending' : r.status === 'accepted' ? 'success' : 'failed'}">${esc(r.status)}</span></div>`).join('') + d.outgoing.map(r => `<div class="us-row"><span>➡ to <b>${esc(r.to.slice(0, 8))}…</b></span><span class="st st-${r.status === 'pending' ? 'pending' : r.status === 'accepted' ? 'success' : 'failed'}">${esc(r.status)}</span></div>`).join(''))}
        ${sec('<i class="fa-solid fa-ban"></i> Blocked users', d.blocked.length, d.blocked.map(person).join(''))}
        ${sec('<i class="fa-solid fa-users-line"></i> Groups', d.groups.length, d.groups.map(g => `<div class="cm-row click" onclick="A.cmMsgs('group','${esc(g.id)}','${esc(g.name)}')"><div class="mg-rt"><b>${esc(g.name)}</b><small>${g.members} members</small></div><i class="fa-solid fa-chevron-right" style="color:var(--sub)"></i></div>`).join(''))}
        ${sec('<i class="fa-solid fa-flag"></i> Reports (about / by this user)', d.reports.length, d.reports.map(r => `<div class="us-row"><div><b>${esc(r.reason || '')}</b><div class="lg-meta">${esc(r.fromName || '')} → ${esc(r.againstName || '')} · ${ago(r.createdAt)}</div></div><span class="st st-${r.status === 'open' ? 'pending' : 'success'}">${esc(r.status)}</span></div>`).join(''))}`;
    } catch (e) { box.innerHTML = `<div class="empty-box">${esc(e.message)}</div>`; }
  },
  moneyFromChat(uid) { A.goTab('usearch'); A.usOpen().then(() => A.usRecord(uid)); },
  async cmBan(uid, banned) {
    const reason = banned ? (prompt('Reason for the ban (optional)') || '') : '';
    if (banned && reason === null) return;
    try { await A.api('/api/chatadm/user/' + uid + '/ban', { body: { banned, reason } }); A.toast(banned ? 'User banned from chat' : 'User unbanned'); A.cmUser(uid); } catch (e) { A.fail(e); }
  },
  /* ---------- messages viewer ---------- */
  async cmMsgs(kind, id, title) {
    $('m-cmsgs').classList.add('show'); $('cmm-title').innerHTML = '<i class="fa-solid fa-eye"></i> ' + esc(title); $('cmm-list').innerHTML = '<div class="empty-box"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    try { const r = await A.api(`/api/chatadm/messages/${kind}/${encodeURIComponent(id)}`);
      $('cmm-list').innerHTML = r.messages.length ? r.messages.map(m => `<div class="cm-msg ${m.deleted ? 'del' : ''}"><div class="cm-msg-t"><b>${esc(m.fromName || m.name || '?')}</b><small>${new Date(m.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}${m.edited ? ' · edited' : ''}${m.adminDeleted ? ' · removed by admin' : ''}</small>${m.deleted ? '' : `<button onclick="A.cmDelMsg('${esc(m.path)}',this)"><i class="fa-solid fa-trash"></i></button>`}</div><div>${m.deleted ? '<i>deleted</i>' : esc(m.text)}</div></div>`).join('') : '<div class="empty-box" style="padding:24px;">No messages</div>';
      const l = $('cmm-list'); l.scrollTop = l.scrollHeight;
    } catch (e) { $('cmm-list').innerHTML = `<div class="empty-box">${esc(e.message)}</div>`; }
  },
  async cmDelMsg(path, btn) { if (!confirm('Remove this message for everyone?')) return; try { await A.api('/api/chatadm/msg/delete', { body: { path } }); const row = btn.closest('.cm-msg'); row.classList.add('del'); row.lastElementChild.innerHTML = '<i>removed by admin</i>'; btn.remove(); } catch (e) { A.fail(e); } },
  /* ---------- groups + reports ---------- */
  async cmGroups() {
    try { const r = await A.api('/api/chatadm/groups');
      $('cm-body').innerHTML = r.groups.length ? r.groups.map((g, i) => `<div class="card cm-grp fade-up" style="animation-delay:${Math.min(i, 8) * 35}ms"><div class="cm-gem">${esc(g.emoji || '👥')}</div><div style="flex:1;min-width:0;"><b>${esc(g.name)}</b><small>${(g.members || []).length} members · ${ago(g.lastAt)} · ${esc(g.lastMsg || '')}</small></div>
        <button class="btn btn-outline mini" onclick="A.cmMsgs('group','${esc(g.id)}','${esc(g.name)}')"><i class="fa-solid fa-eye"></i></button><button class="btn btn-danger mini" onclick="A.cmDelChat('group','${esc(g.id)}','${esc(g.name)}')"><i class="fa-solid fa-trash"></i></button></div>`).join('') : '<div class="empty-box" style="padding:30px;">No groups yet</div>';
    } catch (e) { $('cm-body').innerHTML = `<div class="empty-box">${esc(e.message)}</div>`; }
  },
  async cmDelChat(kind, id, name) {
    const v = await A.askDanger({ title: `Delete "${name}"?`, text: 'The whole conversation and all its messages are removed.', typed: 'DELETE', backup: null, okLabel: 'Delete' }); if (!v) return;
    try { await A.api(`/api/chatadm/${kind}/${encodeURIComponent(id)}/delete`, { body: { pin: v.pin } }); A.toast('Deleted'); A.cmSub(CM.sub); } catch (e) { A.fail(e); }
  },
  async cmReports(status) {
    status = status || 'open';
    try { const r = await A.api('/api/chatadm/reports?status=' + status);
      $('cm-body').innerHTML = `<div class="chip-row" style="margin-bottom:12px;"><button class="chip ${status === 'open' ? 'active' : ''}" onclick="A.cmReports('open')">Open</button><button class="chip ${status === 'resolved' ? 'active' : ''}" onclick="A.cmReports('resolved')">Resolved</button><button class="chip ${status === 'all' ? 'active' : ''}" onclick="A.cmReports('all')">All</button></div>` +
        (r.reports.length ? r.reports.map((x, i) => `<div class="card cm-rep fade-up" style="animation-delay:${Math.min(i, 8) * 35}ms"><div class="gf-top"><b>${esc(x.kind === 'dm' ? 'Friend chat' : x.kind === 'group' ? 'Group' : 'World')} report</b><span class="st st-${x.status === 'open' ? 'pending' : 'success'}">${esc(x.status)}</span></div>
          <div class="lg-meta" style="margin:4px 0 8px;">${esc(x.fromName || '')} reported <b>${esc(x.againstName || '')}</b> · ${ago(x.createdAt)}</div><div style="font-size:.86rem;margin-bottom:10px;">${esc(x.reason || '')}</div>
          <div class="btn-row">${x.chatId && x.chatId !== 'world' ? `<button class="btn btn-outline" style="flex:1;" onclick="A.cmMsgs('${x.kind === 'group' ? 'group' : 'dm'}','${esc(x.chatId)}','Reported chat')"><i class="fa-solid fa-eye"></i> View chat</button>` : ''}${x.against ? `<button class="btn btn-outline" style="flex:1;" onclick="A.cmSub('us');setTimeout(()=>A.cmUser('${esc(x.against)}'),350)"><i class="fa-solid fa-user"></i> User</button>` : ''}
          ${x.status === 'open' ? `<button class="btn btn-success" style="flex:1;" onclick="A.cmResolve('${esc(x.id)}')"><i class="fa-solid fa-check"></i> Resolve</button>` : ''}</div></div>`).join('') : '<div class="empty-box" style="padding:30px;">No reports</div>');
    } catch (e) { $('cm-body').innerHTML = `<div class="empty-box">${esc(e.message)}</div>`; }
  },
  async cmResolve(id) { const note = prompt('Note (optional)'); if (note === null) return; try { await A.api('/api/chatadm/report/' + id, { body: { status: 'resolved', note } }); A.toast('Resolved'); A.cmReports('open'); A.cmBadge(); } catch (e) { A.fail(e); } }
});
