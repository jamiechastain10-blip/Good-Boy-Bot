// Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Good Boy's own items in the right-click menu (the menu itself is ctxmenu.js): open a page from the sidebar, go to the
// main pages, start or stop the bot, and change the look and colours. It only uses what app.js hands over in window.GBApp.
'use strict';
(function () {
  const A = () => window.GBApp;
  window.BGLMenu.setup({
    toast: (t) => A() && A().toast(t),
    openLink: (u) => A() ? A().openLink(u) : window.open(u, '_blank', 'noopener'),
    extra(ctx) {
      const app = A();
      if (!app || !app.ready() || ctx.editable) return [];
      const out = [];
      // a case or a member in the moderation log: act on them from here
      const row = ctx.target && ctx.target.closest('[data-case],[data-member]');
      const forCase = row && app.caseItems ? app.caseItems(row) : [];
      if (forCase.length) return [...forCase, '-', { label: 'Refresh', icon: 'refresh', kbd: 'F5', run: () => app.reload() }];
      // a page button in the sidebar
      const nav = ctx.target && ctx.target.closest('[data-page]');
      if (nav) out.push({ label: `Open ${app.title(nav.dataset.page)}`, icon: 'open', run: () => app.go(nav.dataset.page) }, '-');
      // the main pages, leaving out the one that is open
      const here = app.page();
      const pages = [['home', 'home'], ['servers', 'list'], ['bot', 'gear'], ['help', 'help']].filter(([id]) => id !== here && app.can(id) && !(nav && nav.dataset.page === id));
      for (const [id, icon] of pages) out.push({ label: app.title(id), icon, run: () => app.go(id) });
      out.push({ label: 'Refresh', icon: 'refresh', kbd: 'F5', run: () => app.reload() });
      // the bot
      if (app.owner() && app.tokenSaved()) {
        const phase = app.phase(), running = phase === 'online' || phase === 'starting' || phase === 'problem';
        out.push('-', running
          ? { label: 'Restart the bot', icon: 'refresh', run: () => app.bot('restart') }
          : { label: 'Start the bot', icon: 'play', run: () => app.bot('start') });
        if (running) out.push({ label: 'Stop the bot', icon: 'stop', danger: true, run: () => app.bot('stop') });
      }
      // the look: these change the menu too, so it always matches
      out.push('-', { heading: 'Look' });
      const pixel = app.look() === 'pixel';
      out.push({ label: pixel ? 'Classic look' : 'Pixel look', icon: 'image', run: () => app.setLook(pixel ? 'classic' : 'pixel') });
      if (app.local() && !pixel) out.push({ label: app.dark() ? 'Light colours' : 'Dark colours', icon: app.dark() ? 'sun' : 'moon', run: () => app.setTheme(app.dark() ? 'light' : 'dark') });
      if (app.paid()) {
        if (app.local()) out.push({ label: 'My own colours', icon: 'palette', checked: app.coloursOn(), run: () => app.setColours(!app.coloursOn()) });
        if (app.local()) out.push({ label: 'Change my colours…', icon: 'palette', run: () => app.colours() });
      } else if (app.local()) {
        out.push({ label: 'Own colours (Supporter)', icon: 'heart', run: () => app.colours() });
      }
      return out;
    },
  });
  // F5 refreshes what is on screen instead of reloading the whole app
  document.addEventListener('keydown', (e) => { if (e.key === 'F5' && !e.ctrlKey && A() && A().ready()) { e.preventDefault(); A().reload(); } });
})();
