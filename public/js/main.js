// Entry point — saare modules yahan load hote hain (order matters: core pehle)
import './firebase.js';
import './core.js';
import './auth.js';
import './dashboard.js';
import './matches.js';
import './finance.js';
import './users.js';
import './dbmanager.js';
import './chat.js';
import './ui-helpers.js';
import './wallet-mgr.js';
import './apprules.js';
import './gift-admin.js';
import './usearch.js';
import './lbreward.js';
import './chatmgr.js';
import './reports.js';
import './ops.js';
import './ball.js';
import './bomb.js';
import './lbmanager.js';
import './referral.js';
import './siblings.js';

// goTab hook: extra loading for finance / chat / reports / backup
const _origGoTab = A.goTab;
A.goTab = function(id){
  _origGoTab.call(A, id);
  if(id==='finance') A._renderFinance();
  if(id==='chat') A.loadChatMod();
  if(id==='reports') A.loadReports('open');
  if(id==='money') A.moneyOpen();
  if(id==='cm') A.cmOpen();
  if(id==='usearch') A.usOpen();
  if(id==='gift') A.gfLoad();
  if(id==='ball') A.ballLoad();
  if(id==='bomb') A.bombLoad();
  if(id==='lbm') A.lbmLoad();
  if(id==='refer') A.referLoad();
};

/* ===== DOUBLE-TAP PROTECTION =====
   Har write/action function ek baar chal rahi ho to dubara tap ignore hoga,
   button disable ho jaata hai, aur khatam hone ke 0.5s baad hi dobara chalega. */
const LOCKED = [
  'sendNotif','delNotif','sendCash','addCat','delCat','saveSettings',
  'createMatch','delMatch','saveRoom','completeMatch','saveBooya',
  'distributeRanks','creditKills','completeNoPayout','savePrizeTime','processTrx',
  'adjustBal','moneyApply','saveAppRules','banUser','unbanUser','verifyUser','unverifyUser','deleteUser',
  'dbmEditSave','dbmDeleteUserCascade','dbmHistDel','dbmAllDel','dbmCGDel','dbmLBReset',
  'resolveReport','pinMsg','softDelMsg','hardDelMsg','banUserChat','deleteGroup',
  'pinChatBanner','clearWorldChat','chatSettings','editBannedWords'
];
const _busy = new Set();
LOCKED.forEach(name=>{
  const fn = A[name];
  if(typeof fn !== 'function') return;
  A[name] = function(...args){
    const key = name+':'+JSON.stringify(args.map(a=>(a && a.nodeType)?'el':a));
    if(_busy.has(key)) return;
    _busy.add(key);
    const ev = window.event;
    const btn = ev && ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if(btn){ btn.disabled = true; btn.style.opacity = '.55'; }
    const done = ()=> setTimeout(()=>{ _busy.delete(key); if(btn){ btn.disabled=false; btn.style.opacity=''; } }, 500);
    let r;
    try { r = fn.apply(A, args); } catch(e){ done(); throw e; }
    Promise.resolve(r).finally(done);
    return r;
  };
});

// panel khulte hi ops strip + panel switcher
const _op = A._openPanel;
A._openPanel = function(){ _op.call(A); A.opsStart(); A.renderSwitcher(); };
