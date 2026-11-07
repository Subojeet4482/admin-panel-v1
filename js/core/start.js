/**
 * Final boot step — runs after every module has registered itself.
 */
window.historyManager.init();
window.app.init();

// Service worker: caches the versioned JS/CSS + images so every visit after the first is instant.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    const reg = () => navigator.serviceWorker.register('sw.js').catch(() => {});
    if (document.readyState === 'complete') reg(); else window.addEventListener('load', () => setTimeout(reg, 300));
}
