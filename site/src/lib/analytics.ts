// Umami (self-hosted, cookieless). Same instance and website ID as the web app;
// Umami separates the site from the app by hostname/path.
export const UMAMI_SRC = 'https://stats.sommertheater-altrossthal.de/st.js';
export const UMAMI_WEBSITE_ID = 'e8641ce8-5663-43ec-b0b5-39c8e721d79e';

/**
 * Inline script for every page (landing + docs): loads Umami and reports link clicks
 * as custom events via one delegated listener, so links rewritten at runtime
 * (live release assets on /download/) are reported with their final URL.
 *
 * Events:
 * - download   {file, version, os, slot, detected}  release asset clicked
 * - open-app   {from}                              link into the web app
 * - outbound   {host, url}                         any other external link (GitHub, sponsors, …)
 */
export const analyticsScript = `(() => {
  const s = document.createElement('script');
  s.defer = true;
  s.src = ${JSON.stringify(UMAMI_SRC)};
  s.dataset.websiteId = ${JSON.stringify(UMAMI_WEBSITE_ID)};
  s.dataset.doNotTrack = 'true';
  // Before the tracker has loaded, send the event directly (same payload as Umami's
  // tracker). keepalive lets the request finish even if the click navigates away.
  const dnt = ['1', 'yes'].includes(String(navigator.doNotTrack || window.doNotTrack));
  const direct = (name, data) => {
    if (dnt) return;
    try {
      fetch(new URL('/api/send', s.src).href, {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'event', payload: {
          website: s.dataset.websiteId, hostname: location.hostname, url: location.pathname + location.search,
          title: document.title, referrer: document.referrer, language: navigator.language,
          screen: screen.width + 'x' + screen.height, name, data,
        } }),
      }).catch(() => {});
    } catch (e) {}
  };
  document.head.appendChild(s);

  const track = (name, data) => {
    if (window.umami) { try { window.umami.track(name, data); } catch (e) {} }
    else direct(name, data);
  };
  const from = location.pathname.replace(/^\\/SignaVis/, '') || '/';
  document.addEventListener('click', (ev) => {
    const a = ev.target instanceof Element && ev.target.closest('a[href]');
    if (!a) return;
    let url;
    try { url = new URL(a.href, location.href); } catch (e) { return; }
    const m = url.pathname.match(/\\/releases\\/download\\/([^/]+)\\/([^/]+)$/);
    if (m) {
      const card = a.closest('[data-os]');
      track('download', {
        file: decodeURIComponent(m[2]),
        version: m[1].replace(/^v/, ''),
        os: card ? card.dataset.os : '',
        slot: a.dataset.slot || '',
        detected: !!(card && card.classList.contains('detected')),
      });
    } else if (url.origin === location.origin && /^\\/SignaVis\\/(demo\\/|app\\/|labeling-app)/.test(url.pathname)) {
      track('open-app', { from });
    } else if (url.origin !== location.origin && /^https?:$/.test(url.protocol)) {
      track('outbound', { host: url.host, url: url.origin + url.pathname, from });
    }
  }, { capture: true });
})();`;
