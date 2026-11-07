/**
 * Reacts to Firebase login/logout: loads user data, toggles drawer + header state.
 */
import { onAuthStateChanged, authService } from './firebase.js?v=138b436893';

onAuthStateChanged(authService, async (user) => {
    if(user && window.auth._needsVerify && window.auth._needsVerify(user)){
        // within the 60s register window, resume/clean up the pending account (skip if register() is running)
        if(window.auth._resumePending && !window.auth._registering) window.auth._resumePending(user);
        user = null; // treated as a guest until the email is verified
    }
    if(user) {
        window.db.user_uid=user.uid; window.db.user_name=user.displayName||"Player";
        if(window.live) window.live.start(user.uid);   // start the realtime listeners FIRST, in parallel with the profile fetch below
        if(window.auth._ensureProfile && ((user.providerData||[]).some(p=>p.providerId==='google.com') || Date.parse((user.metadata&&user.metadata.creationTime)||0) >= (window.auth._verifyFrom||Infinity))) await window.auth._ensureProfile(user);
        await window.app.fetchUserData();
        document.getElementById('drawer-guest').classList.remove('guest-show'); document.getElementById('drawer-guest').classList.add('guest-hidden');
        document.getElementById('drawer-user').classList.remove('guest-hidden'); document.getElementById('menu-logout').classList.remove('guest-hidden');
        const d=window.db.user_data;
        const esc=(s)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        document.getElementById('profile-name').innerHTML='<span style="overflow:hidden;text-overflow:ellipsis;">'+esc(d.appName||user.displayName||'User')+'</span>'+(d.isVerified?' <i class="fa-solid fa-circle-check" style="color:#1d9bf0;font-size:0.9rem;flex:none;" title="Verified"></i>':'');
        const pid=document.getElementById('drawer-player-id'); if(pid) pid.innerText=d.playerId||user.uid.slice(0,7);
        document.getElementById('wallet-uid').innerText="UID: "+(window.db.user_data.playerId||user.uid.slice(0,7));
        document.getElementById('header-coins').innerText=Math.floor(window.db.balance||0);
        const ph=d.phone||""; window.db.user_phone=ph; const mp=ph.length>5?ph.substring(0,3)+"******"+ph.substring(ph.length-2):"Not Set";
        document.getElementById('profile-phone').innerText=ph.length>5?mp:(d.email||user.email||"Not Set");
        const bp=document.getElementById('badge-phone'); if(bp){ const ok=ph.length>=10; const was=bp.classList.contains('unverified'); bp.classList.toggle('unverified',!ok); bp.innerHTML=`<i class="fa-solid fa-${ok?'check':'xmark'}-circle"></i> Phone`; if(was===ok){ bp.classList.remove('pop'); void bp.offsetWidth; bp.classList.add('pop'); } }
        document.getElementById('profile-img').src=window.app.avatarUrl(d);
        window.app.renderMatches();
        // heavy / background work is moved off the critical path (the wallet list already arrives live from live.js)
        setTimeout(()=>{ try{ window.app.fetchTransactions(); window.app.scheduleMonthlyCleanup(); }catch(e){} }, 1500);
    } else {
        try{ localStorage.removeItem('ffcb_hint'); }catch(e){}
        if(window.live) window.live.stop();
        window.db.user_uid=null; window.db.user_data={}; window.db.balance=0; window.db.depositBalance=0; window.db.withdrawBalance=0; window.db.joined_ids=[];
        document.getElementById('ban-overlay').style.display='none';
        document.getElementById('drawer-guest').classList.add('guest-show'); document.getElementById('drawer-guest').classList.remove('guest-hidden');
        document.getElementById('drawer-user').classList.add('guest-hidden'); document.getElementById('menu-logout').classList.add('guest-hidden');
        document.getElementById('header-coins').innerText="Login";
        // guest: nothing else will deliver the matches, so load them now (skipped if they are already there)
        if(!window.app._matchesLoaded && !(window.db.matches||[]).length){ window.app.fetchMatches().then(()=>window.app.renderMatches()); } else window.app.renderMatches();
    }
});
