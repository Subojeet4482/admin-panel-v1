// Monthly leaderboard reward settings (config/leaderboard). The SERVER pays at 12:00 AM on the 1st.
import { db, doc, getDoc, setDoc, getDocs, collection } from './firebase.js';
const $ = (id) => document.getElementById(id);
let rows = [];
const paint = () => { $('lbrw-rows').innerHTML = rows.map((v, i) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;"><div class="lbrw-rk">${['🥇', '🥈', '🥉'][i] || '#' + (i + 1)}</div><input class="inp" type="number" min="0" value="${v}" placeholder="₹ amount" oninput="A._lbrw[${i}]=this.value" style="margin:0;flex:1;">${rows.length > 1 ? `<button class="btn btn-danger mini" onclick="A.lbrwDel(${i})"><i class="fa-solid fa-xmark"></i></button>` : ''}</div>`).join(''); };
Object.assign(window.A, {
  async showLbReward() {
    $('m-lbrw').classList.add('show');
    try { const c = (await getDoc(doc(db, 'config', 'leaderboard'))).data() || {}; rows = (c.rewards || []).map(r => r.amount); if (!rows.length) rows = [10, 5, 5]; $('lbrw-on').checked = c.rewardEnabled !== false; } catch (e) { rows = [10, 5, 5]; }
    A._lbrw = rows; paint();
    try { const s = await getDocs(collection(db, 'lb_rewards')); const arr = []; s.forEach(d => arr.push({ id: d.id, ...d.data() })); arr.sort((a, b) => b.id.localeCompare(a.id));
      $('lbrw-last').innerHTML = arr.length ? 'Last payouts: ' + arr.slice(0, 3).map(a => `<b>${a.id}</b> (${(a.paid || []).length} paid)`).join(' · ') : 'No payout has run yet.'; } catch (e) {}
  },
  lbrwAdd() { if (rows.length >= 10) return; rows.push(0); A._lbrw = rows; paint(); },
  lbrwDel(i) { rows.splice(i, 1); A._lbrw = rows; paint(); },
  async lbrwSave() {
    const rewards = A._lbrw.map(v => ({ amount: Number(v) || 0 }));
    try { await setDoc(doc(db, 'config', 'leaderboard'), { rewards, rewardEnabled: $('lbrw-on').checked, updatedAt: Date.now() }, { merge: true }); A.toast('Rewards saved ✓'); A.closeModal('m-lbrw'); }
    catch (e) { A.toast('Error: ' + e.message, 'err'); }
  }
});
