/**
 * Core app object: session check, init, rate-limit helpers, config + user data fetch. Feature files extend window.app.
 */
import { collection, getDocs, doc, getDoc, deleteDoc, dbService } from './firebase.js?v=138b436893';

window.app = {
    currentMatch:null, activeTab:'upcoming', selectedCategory:'All', tempImage:null,
    selectedWdMethod:null, selectedCoin:'LTC', selectedNetwork:'Mainnet', recipientVerified:false,
    checkLogin: (cb) => { if(window.db.user_uid) cb(); else window.auth.showAuth(); },
    init: async () => {
        const A = window.app;
        // A saved session hint means the realtime listener (live.js) will deliver the matches -> do not download them twice.
        const hinted = !!(window.__ffHint && window.__ffHint.uid);
        // Everything that does not depend on each other now loads in PARALLEL (was one-after-another).
        // Matches paint the moment they arrive, without waiting for config / notifications.
        const matchesP = hinted ? Promise.resolve() : A.fetchMatches().then(() => { try{ A.renderMatches(); }catch(e){} });
        await Promise.all([ A.fetchConfig(), A.fetchCategories(), A.fetchLeaderboard(), A.fetchNotifications(), matchesP ]);
        // transactions are loaded once, by auth-state.js / live.js (no third copy here)
        A.renderMatches(); A.renderWallet(); A.renderLB();
        // safety net: if the saved-session hint was stale and nothing arrived, load matches normally
        if(hinted) setTimeout(() => { if(!(window.db.matches||[]).length) A.fetchMatches().then(() => A.renderMatches()); }, 5000);
        window.timers.start();
        if(localStorage.getItem('darkMode')==='true') document.body.classList.add('dark');
        try{ localStorage.removeItem('aiMode'); }catch(e){}
        window.app.initSound();
    },
    // Anti-spam: per-action 60s cooldown + in-flight lock
    _lastAction: {}, _busy: {},
    rateLimit: (key, ms) => {
        if(window.app._busy[key]) { window.ui.toast('Request already in progress...'); return false; }
        const t = window.app._lastAction[key]||0;
        const wait = (ms||60000) - (Date.now()-t);
        if(wait>0){ window.ui.toast(`Please wait ${Math.ceil(wait/1000)}s before trying again`); return false; }
        window.app._busy[key]=true;
        return true;
    },
    endAction: (key, success) => {
        window.app._busy[key]=false;
        if(success) window.app._lastAction[key]=Date.now();
    },
    // Auto-delete play/deposit/withdraw history on 1st of every month (keeps totals)
    scheduleMonthlyCleanup: async () => {
        try {
            if(!window.db.user_uid) return;
            const today = new Date();
            const key = `histCleanedMonth_${window.db.user_uid}`;
            const cur = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
            // First run: set the baseline, don't run the cleanup
            if(!localStorage.getItem(key)){ localStorage.setItem(key,cur); return; }
            // Whenever the month changes (on the 1st or the 5th — whichever day they log in), run the cleanup
            if(localStorage.getItem(key)!==cur){
                const snap = await getDocs(collection(dbService,"users",window.db.user_uid,"transactions"));
                for(const d of snap.docs){ try{ await deleteDoc(doc(dbService,"users",window.db.user_uid,"transactions",d.id)); }catch(e){} }
                localStorage.setItem(key,cur);
                window.db.trx=[]; window.app.renderWallet();
            }
        } catch(e){}
    },
    fetchConfig: async () => {
        try {
            const d=(await getDoc(doc(dbService,"config","banner"))).data()||{};
            // Multi-banner support: d.banners = [url, url, ...]; fallback to d.url
            let banners = Array.isArray(d.banners) ? d.banners.filter(Boolean) : [];
            if(!banners.length && d.url) banners=[d.url];
            if(window.app.initBanner) window.app.initBanner(banners);
            if(d.upi) document.getElementById('dep-upi-id').innerText=d.upi;
            if(d.qrUrl){ document.getElementById('dep-qr-img').src=d.qrUrl; document.getElementById('dep-qr-wrap').style.display='block'; }
            if(d.cryptoCoin) document.getElementById('dep-crypto-coin').innerText=d.cryptoCoin;
            if(d.cryptoAddr) document.getElementById('dep-crypto-addr').innerText=d.cryptoAddr;
            if(d.supportNumber) window.db.supportNumber=d.supportNumber;
            window.db.whatsappSupport = { name: d.whatsappName||"", link: d.whatsappLink||d.whatsappNumber||"" };
            window.db.telegramSupport = { name: d.telegramName||"", link: d.telegramLink||d.telegramChannel||"" };
            if(typeof window.app.renderSupportContacts==='function') window.app.renderSupportContacts();
            if(d.notice&&d.notice.trim()!=="") { document.getElementById('notice-text').innerText=d.notice; setTimeout(()=>window.ui.openModal('modal-notice'),2500); }
        } catch(e) { if(window.app.initBanner) window.app.initBanner([]); }
    },
    // Show the right balance for each modal (withdraw modal = withdraw bal, transfer modal = deposit bal, others = total)
    _setLiveBalance: () => {
        const on=(id)=>{ const m=document.getElementById(id); return m && m.classList.contains('active'); };
        const v = on('modal-withdraw') ? window.db.withdrawBalance : on('modal-transfer') ? window.db.depositBalance : window.db.balance;
        document.querySelectorAll('.live-balance').forEach(el=>el.innerText=Number(v||0).toFixed(2));
    },
    // Applies one user doc to the whole UI (used by both fetchUserData and the realtime listener)
    applyUserDoc: (d) => {
        window.db.user_data=d; window.db.joined_ids=d.joined_matches||[];
                // Two balances: depositBalance (normal/play) + withdrawBalance (rewards). Backward compat with old single balance.
                window.db.depositBalance = d.depositBalance!==undefined ? d.depositBalance : (d.balance||0);
                window.db.withdrawBalance = d.withdrawBalance||0;
                window.db.balance = window.db.depositBalance + window.db.withdrawBalance;
                try{ if(window.db.user_uid) localStorage.setItem('ffcb_hint', JSON.stringify({ uid:window.db.user_uid, bal:Math.floor(window.db.balance||0) })); }catch(e){}
                // Ban check
                if(window.app.checkBan(d)) return;
                const _set=(id,v)=>{ const e=document.getElementById(id); if(!e) return; const s=String(v); if(e.dataset.cu) e.dataset.cu=s; e.innerText=s; };
                _set('drawer-bal',window.db.balance.toFixed(2));
                document.getElementById('drawer-game-name').innerText=d.gameName||"Not Set";
                document.getElementById('drawer-game-uid').innerText=d.gameUid||"---";
                _set('stat-played',d.matchesPlayed||0);
                _set('stat-won',d.matchesWon||0);
                _set('stat-earned',d.totalEarned||0);
                window.app._setLiveBalance();
                const bUid=document.getElementById('badge-uid');
                // Profile UID added => badge flips red -> green (also keeps verified state)
                if(d.isUidVerified || (d.gameUid && String(d.gameUid).trim().length>=6)){
                    bUid.classList.remove('unverified');
                    bUid.innerHTML='<i class="fa-solid fa-check-circle"></i> UID';
                } else {
                    bUid.classList.add('unverified');
                    bUid.innerHTML='<i class="fa-solid fa-xmark-circle"></i> UID';
                }
                { const gn=document.getElementById('game-name'); if(d.gameName && gn && document.activeElement!==gn) gn.value=d.gameName; }
                { const gu=document.getElementById('game-uid'); if(d.gameUid && gu && document.activeElement!==gu) gu.value=d.gameUid; }
                window.app.renderWallet();
    },
    fetchUserData: async () => {
        try {
            const snap=await getDoc(doc(dbService,"users",window.db.user_uid));
            if(snap.exists()) window.app.applyUserDoc(snap.data());
        } catch(e){}
    },
    validateAmount: (el) => { if(el.value<0) el.value=""; },
};
