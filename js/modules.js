/**
 * Module manifest — ORDER MATTERS.
 * Objects like window.app / window.chat are created by the first file of a group
 * and extended by the rest, so keep each group in this order.
 */

// Core state
import './core/firebase.js?v=138b436893';
import './core/state.js?v=138b436893';
import './core/fx.js?v=138b436893';
import './core/sfx.js?v=138b436893';
import './core/walletfx.js?v=138b436893';
import './core/messages.js?v=138b436893';
import './core/timers.js?v=138b436893';

// Auth (creates window.auth, then extends it)
import '../pages/login/login.js?v=138b436893';
import '../pages/register/register.js?v=138b436893';
import '../pages/login/forgot.js?v=138b436893';
import '../components/session/session.js?v=138b436893';

// App core (creates window.app) + feature extensions
import './core/app.js?v=138b436893';
import './core/auth-state.js?v=138b436893';
import '../pages/setting/setting.js?v=138b436893';
import '../pages/setting/rules.js?v=138b436893';
import '../components/gift/gift.js?v=138b436893';
import '../components/roster/roster.js?v=138b436893';
import '../pages/game/ball.js?v=138b436893';
import '../components/notifications/notifications.js?v=138b436893';
import '../components/ban-overlay/ban-overlay.js?v=138b436893';
import '../pages/home/home.js?v=138b436893';
import '../components/join/join.js?v=138b436893';
import '../pages/match/match.js?v=138b436893';
import '../pages/rank/rank.js?v=138b436893';
import '../pages/wallet/wallet.js?v=138b436893';
import '../components/transfer/transfer.js?v=138b436893';
import '../components/deposit/deposit.js?v=138b436893';
import '../pages/loading/loading.js?v=138b436893';
import '../pages/withdrawal/withdrawal.js?v=138b436893';
import '../pages/history/history.js?v=138b436893';

// UI + navigation
import './core/ui.js?v=138b436893';
import './core/nav.js?v=138b436893';
import '../components/toast/notify.js?v=138b436893';
import './core/polish.js?v=138b436893';
import './core/live.js?v=138b436893';

// Chat (new system: data in js/core/chat-firebase.js database)
import '../pages/chat/chat-ui.js?v=138b436893';
import '../pages/chat/chat-keep.js?v=138b436893';
import '../pages/chat/chat-pro.js?v=138b436893';
import './core/shortcuts.js?v=138b436893';

// Shell behaviour
import './core/history-manager.js?v=138b436893';
import '../components/header/header.js?v=138b436893';
import '../components/drawer/drawer.js?v=138b436893';
import '../components/trx-detail/trx-detail.js?v=138b436893';

// Background services
import './core/auto-refresh.js?v=138b436893';

// Boot
import './core/animate.js?v=138b436893';

import './core/start.js?v=138b436893';
