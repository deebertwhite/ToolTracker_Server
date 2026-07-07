// Shared service worker registration, included by every page. See sw.js for what it
// actually does (app-shell caching only, never intercepts /api/* calls).
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((err) => {
            console.error('Service worker registration failed:', err);
        });
    });
}
