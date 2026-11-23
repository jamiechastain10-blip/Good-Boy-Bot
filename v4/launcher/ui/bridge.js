// Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The one way the screens talk to the program. Inside the app this goes to the Rust side; opened in a plain
// browser (for design work) it loads a pretend bot instead, so every screen can be looked at without Discord.
'use strict';
(function () {
  const real = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  let pretend = null;
  function loadPretend() {
    pretend = pretend || new Promise((done, fail) => {
      const s = document.createElement('script');
      s.src = 'pretend.js'; s.onload = () => done(window.GBPretend); s.onerror = () => fail(new Error('The preview data could not be loaded.'));
      document.head.append(s);
    });
    return pretend;
  }
  // served by Good Boy's own web server (a phone or another computer): ask it over the network
  const web = !!document.querySelector('meta[name="gb-web"]');
  async function viaWeb(name, args) {
    let r;
    try { r = await fetch('/api/' + name, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-gb': '1' }, body: JSON.stringify(args || {}) }); }
    catch { throw new Error('Good Boy cannot be reached. Check your connection.'); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { const e = new Error('Sign in with Discord first.'); e.signin = true; throw e; }
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    return j.result;
  }
  if (web && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.GB = {
    inApp: !!real,
    web,
    /** Asks the program for something. Fails with a plain sentence. */
    async call(name, args) {
      try {
        if (real) return await real(name, args || {});
        if (web) return await viaWeb(name, args);
        return await (await loadPretend())(name, args || {});
      } catch (e) {
        const err = new Error(typeof e === 'string' ? e : (e && e.message) || 'Something went wrong.');
        if (e && e.signin) err.signin = true;
        throw err;
      }
    },
  };
})();
