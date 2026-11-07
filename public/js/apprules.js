// App Rules editor: up to 3 language buttons, each with its own rule list. Saved to Firestore config/rules.
import { db, doc, getDoc, setDoc } from './firebase.js';
const $ = (id) => document.getElementById(id);
const esc = A.esc;
const DEFAULTS = [
  { code: 'en', label: 'English', items: ['No emulators allowed (mobile only).', 'No hacks, scripts or team-ups.', 'Level 25+ ID required.', 'Wait in the lobby 5 minutes before the match starts.', 'Winners must take a screenshot of the Booyah.'] },
  { code: 'hi', label: 'हिंदी', items: ['एमुलेटर की अनुमति नहीं है (सिर्फ मोबाइल)।', 'हैक, स्क्रिप्ट या टीम-अप की अनुमति नहीं है।', 'लेवल 25+ आईडी ज़रूरी है।', 'मैच शुरू होने से 5 मिनट पहले लॉबी में रहें।', 'विजेता को Booyah का स्क्रीनशॉट लेना होगा।'] },
  { code: 'hg', label: 'Hinglish', items: ['Emulator allowed nahi hai (sirf mobile).', 'Hack, script ya team-up allowed nahi hai.', 'Level 25+ ID zaroori hai.', 'Match start hone se 5 minute pehle lobby mein rahein.', 'Winner ko Booyah ka screenshot lena hoga.'] }
];
let L = [], cur = 0;

function sync() { const t = $('ar-text'), l = $('ar-label'); if (t && L[cur]) { L[cur].items = t.value.split('\n').map(x => x.trim()).filter(Boolean); L[cur].label = (l.value || '').trim() || L[cur].label; } }
function paint() {
  $('ar-tabs').innerHTML = L.map((x, i) => `<button type="button" class="chip ${i === cur ? 'active' : ''}" onclick="A.arTab(${i})">${esc(x.label)}</button>`).join('') +
    (L.length < 3 ? '<button type="button" class="chip" onclick="A.arAdd()"><i class="fa-solid fa-plus"></i> Add language</button>' : '');
  const x = L[cur];
  $('ar-body').innerHTML = `<div class="fade-up"><div class="lbl">Button name (shown to users)</div><input class="inp" id="ar-label" value="${esc(x.label)}" maxlength="14">
    <div class="lbl">Rules — one rule per line</div><textarea class="inp" id="ar-text" rows="9" style="min-height:190px;">${esc(x.items.join('\n'))}</textarea>
    ${L.length > 1 ? '<button class="btn btn-danger btn-full" style="margin-bottom:12px;" onclick="A.arDel()"><i class="fa-solid fa-trash"></i> Remove this language</button>' : ''}</div>`;
}
Object.assign(window.A, {
  async showAppRules() {
    $('m-apprules').classList.add('show');
    try { const s = await getDoc(doc(db, 'config', 'rules')); L = (s.exists() && Array.isArray(s.data().langs) && s.data().langs.length) ? s.data().langs.map(x => ({ code: x.code || 'x', label: x.label || 'Rules', items: x.items || [] })) : JSON.parse(JSON.stringify(DEFAULTS)); }
    catch (e) { L = JSON.parse(JSON.stringify(DEFAULTS)); }
    cur = 0; paint();
  },
  arTab(i) { sync(); cur = i; paint(); },
  arAdd() { sync(); if (L.length >= 3) return; L.push({ code: 'l' + Date.now(), label: 'New', items: [] }); cur = L.length - 1; paint(); },
  arDel() { if (L.length < 2 || !confirm('Remove this language?')) return; L.splice(cur, 1); cur = 0; paint(); },
  async saveAppRules() {
    sync();
    const langs = L.filter(x => x.items.length).map(x => ({ code: x.code, label: x.label, items: x.items }));
    if (!langs.length) return A.toast('Add at least one rule', 'err');
    try { await setDoc(doc(db, 'config', 'rules'), { langs, updatedAt: Date.now() }); A.toast('Rules saved ✓'); A.closeModal('m-apprules'); }
    catch (e) { A.toast('Error: ' + e.message, 'err'); }
  }
});
