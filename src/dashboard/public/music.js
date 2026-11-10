// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The Music page (3.1.2), used by the dashboard and the phone app: a music-app style player for the bot in voice,
// with a progress bar, volume slider, the queue, search and playlists kept on the server.
// Built from DOM nodes and text only (no HTML strings), so song names can't inject anything.
'use strict';
(function () {
  const SVG = 'http://www.w3.org/2000/svg';
  const PATHS = {
    play: 'M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z',
    pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
    next: 'M5 5.5v13a.8.8 0 0 0 1.2.7L16 13v5.5h2.5v-13H16V11L6.2 4.8A.8.8 0 0 0 5 5.5z',
    prev: 'M19 5.5v13a.8.8 0 0 1-1.2.7L8 13v5.5H5.5v-13H8V11l9.8-6.2a.8.8 0 0 1 1.2.7z',
    shuffle: 'M17 3l4 4-4 4V8h-2.2l-3.1 3.5-1.6-1.8L13.9 6H17zM3 6h4.1l9.7 11H17v-3l4 4-4 4v-3h-1.1L6.2 8H3zm0 10h3.2l2.3-2.6 1.6 1.8L7.1 18H3z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
    vol0: 'M4 9v6h4l5 5V4L8 9zm12.6 3 2.7-2.7-1.3-1.3-2.7 2.7-2.7-2.7-1.3 1.3 2.7 2.7-2.7 2.7 1.3 1.3 2.7-2.7 2.7 2.7 1.3-1.3z',
    vol1: 'M4 9v6h4l5 5V4L8 9zm11.5 3A4.5 4.5 0 0 0 13 8v8a4.5 4.5 0 0 0 2.5-4z',
    vol2: 'M4 9v6h4l5 5V4L8 9zm11.5 3A4.5 4.5 0 0 0 13 8v8a4.5 4.5 0 0 0 2.5-4zM13 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
    heart: 'M12 20.3l-1.4-1.3C5.4 14.3 2 11.2 2 7.5 2 4.4 4.4 2 7.5 2c1.7 0 3.4.8 4.5 2.1A6 6 0 0 1 16.5 2C19.6 2 22 4.4 22 7.5c0 3.7-3.4 6.8-8.6 11.5z',
    plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
    search: 'M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
    home: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z',
    queue: 'M3 5h14v2H3zm0 4h14v2H3zm0 4h9v2H3zm12 0 6 3.5-6 3.5z',
    trash: 'M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z',
    more: 'M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
    note: 'M9 18.5A2.5 2.5 0 1 1 6.5 16c.5 0 1 .2 1.5.4V5l11-2v12.5a2.5 2.5 0 1 1-2.5-2.5c.5 0 1 .2 1.5.4V7.4L10 8.9v9.6z',
    stop: 'M6 6h12v12H6z',
    up: 'M12 4l7 7h-4v9H9v-9H5z',
    grip: 'M9 5h2v2H9zm4 0h2v2h-2zM9 11h2v2H9zm4 0h2v2h-2zm-4 6h2v2H9zm4 0h2v2h-2z',
    speaker: 'M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    import: 'M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3zM4 18h16v2H4z',
    gear: 'M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4L10.7 6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L4.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.3 2.5h4l.3-2.5c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  };
  function icon(name, size = 20) {
    const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', PATHS[name] ?? PATHS.note); p.setAttribute('fill', 'currentColor'); s.append(p); return s;
  }
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv; }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const clock = (s) => { if (!Number.isFinite(s) || s < 0) return '0:00'; s = Math.floor(s); const hr = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return hr ? `${hr}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  const longTime = (s) => { s = Math.round(s || 0); const hr = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return hr ? `${hr} hr ${m} min` : `${m} min`; };
  const hue = (str) => { let n = 0; for (const c of String(str ?? '')) n = (n * 31 + c.charCodeAt(0)) % 360; return n; };
  const SOURCE = { media: (t) => t.site || 'Web', link: (t) => t.site || 'Link', radio: () => 'Radio', jamendo: () => 'Jamendo', upload: () => 'Upload' };
  const sourceLabel = (t) => (SOURCE[t?.source] ?? (() => t?.site ?? ''))(t ?? {});

  /** A square cover: the song's picture, or a colour made from its name. Playlists can pass up to 4 pictures. */
  function cover(t, size = 48, arts = null) {
    const list = (arts ?? (t?.art ? [t.art] : [])).filter(Boolean);
    const base = h('div', { class: 'gbm-cover', style: { width: `${size}px`, height: `${size}px`, '--h': hue(t?.title ?? t?.name ?? '') } });
    if (list.length >= 4) { base.classList.add('mosaic'); for (const a of list.slice(0, 4)) base.append(h('img', { src: a, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })); return base; }
    if (list.length) { const img = h('img', { src: list[0], alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }); img.addEventListener('error', () => { img.remove(); base.append(icon('note', size * 0.42)); }); base.append(img); return base; }
    base.append(icon(t?.source === 'radio' ? 'speaker' : 'note', Math.max(16, size * 0.42)));
    return base;
  }

  const M = { root: null, opts: null, data: null, recvAt: 0, view: 'home', playlist: null, search: { q: '', results: null, note: null, list: null, busy: false }, channelId: null, dragVol: false, dragSeek: false, volTimer: null, ticker: null, es: null, menu: null, lastVol: 70 };

  async function call(action, body, ok) {
    try {
      const r = await M.opts.api(`/api/guilds/${M.opts.gid}/modules/music/actions/${action}`, body ?? {});
      const res = r?.result ?? r;
      if (res?.state) take(res.state); else if (res && typeof res === 'object' && 'connected' in res) take(res);
      if (ok) M.opts.toast(typeof ok === 'function' ? ok(res) : ok);
      return res;
    } catch (e) { M.opts.toast(e.message, true); throw e; }
  }
  const view = (name, q = {}) => M.opts.api(`/api/guilds/${M.opts.gid}/modules/music/views/${name}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`);

  /** New player state (from an action or a live update). Lists that only the full view carries are kept. */
  function take(st) {
    if (!st || !M.data) return;
    const keep = { voiceChannels: M.data.voiceChannels, playlists: M.data.playlists, sources: M.data.sources, limits: M.data.limits };
    // The volume someone just set here wins over older numbers still on their way.
    if (Date.now() - (M.volSetAt ?? 0) < 2500) keep.volume = M.data.volume;
    M.data = { ...M.data, ...st, ...keep };
    if (st.playlists) M.data.playlists = st.playlists;
    M.recvAt = Date.now();
    paintBar(); if (M.view === 'home') paintMain();
  }
  async function reload() {
    try {
      const d = await view('player'); M.data = d; M.recvAt = Date.now();
      if (!M.channelId) M.channelId = d.channelId ?? [...(d.voiceChannels ?? [])].sort((a, b) => b.listeners - a.listeners)[0]?.id ?? null;
      // Someone is typing in a box on the page: keep it, and only freshen the player bar and the playlist list.
      const a = document.activeElement;
      if (M.root?.querySelector('.gbm') && M.root.contains(a) && a.tagName === 'INPUT' && !a.classList.contains('gbm-range')) { paintBar(); return; }
      paint();
    }
    catch (e) { if (M.root) M.root.replaceChildren(h('div', { class: 'gbm-empty' }, h('p', {}, e.message))); }
  }
  async function openPlaylist(id) {
    M.view = `playlist:${id}`; M.playlist = null; paint();
    try { M.playlist = await view('playlist', { id }); } catch (e) { M.opts.toast(e.message, true); M.view = 'home'; }
    paint();
  }
  const elapsedNow = () => {
    const d = M.data; if (!d?.current) return 0;
    const e = (d.elapsed ?? 0) + (d.paused || d.preparing ? 0 : (Date.now() - M.recvAt) / 1000);
    return d.current.seconds ? Math.min(d.current.seconds, e) : e;
  };
  const voiceBody = () => (M.data?.connected ? {} : { channelId: M.channelId });

  // ------------------------------------------------------------------ small pieces
  function btn(name, label, onclick, { cls = '', size = 20, disabled = false, pressed = null } = {}) {
    return h('button', { type: 'button', class: `plain gbm-ib ${cls}`, title: label, 'aria-label': label, disabled, 'aria-pressed': pressed == null ? null : String(pressed), onclick }, icon(name, size));
  }
  function closeMenu() { M.menu?.remove(); M.menu = null; }
  function menu(anchor, items) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    const box = h('div', { class: 'gbm-menu', role: 'menu' }, items.filter(Boolean).map((it) => it === '-' ? h('hr') : h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'plain gbm-danger' : 'plain', onclick: () => { closeMenu(); it.run(); } }, it.icon ? icon(it.icon, 16) : null, h('span', {}, it.label))));
    document.body.append(box);
    const w = box.offsetWidth, ht = box.offsetHeight;
    box.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    box.style.top = `${r.bottom + ht + 8 > window.innerHeight ? Math.max(8, r.top - ht - 6) : r.bottom + 6}px`;
    M.menu = box;
    setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!box.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', off); } }), 0);
  }
  /** A small dialog asking for a name. Resolves to the text, or null. */
  function askName(title, value = '', okLabel = 'Save', { placeholder = 'Playlist name', max = 60, hint = null } = {}) {
    return new Promise((done) => {
      const input = h('input', { type: 'text', maxlength: max, value, placeholder, 'aria-label': placeholder });
      const finish = (v) => { back.remove(); done(v); };
      const back = h('div', { class: 'gbm-dialog-back', onclick: (e) => { if (e.target === back) finish(null); } },
        h('form', { class: 'gbm-dialog', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) finish(input.value.trim()); } },
          h('h3', {}, title), hint ? h('p', { class: 'gbm-muted' }, hint) : null, input,
          h('div', { class: 'gbm-row-end' }, h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost', onclick: () => finish(null) }, 'Cancel'), h('button', { type: 'submit', class: 'plain gbm-btn' }, okLabel))));
      document.body.append(back); input.focus(); input.select();
      back.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
    });
  }
  /** Import a playlist or album from another site as a playlist here. */
  async function importList() {
    const link = await askName('Import a playlist', '', 'Import', { placeholder: 'https://open.spotify.com/playlist/…', max: 500,
      hint: 'Paste a link to a playlist or album from Spotify, YouTube, YouTube Music, SoundCloud, Bandcamp or Deezer. It becomes a playlist here that you can change.' });
    if (!link) return;
    M.opts.toast('Importing… big playlists take a few seconds');
    const r = await call('playlist', { op: 'import', link });
    await reload(); openPlaylist(r.playlist.id);
    M.opts.toast(`Imported ${r.added} song${r.added === 1 ? '' : 's'} from ${r.site}${r.skipped ? ` (${r.skipped} didn't fit)` : ''}${r.note ? `. ${r.note}` : ''}`);
  }
  function sure(title, text, okLabel) {
    return new Promise((done) => {
      const finish = (v) => { back.remove(); done(v); };
      const back = h('div', { class: 'gbm-dialog-back', onclick: (e) => { if (e.target === back) finish(false); } },
        h('div', { class: 'gbm-dialog', role: 'dialog', 'aria-modal': 'true' }, h('h3', {}, title), h('p', { class: 'gbm-muted' }, text),
          h('div', { class: 'gbm-row-end' }, h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost', onclick: () => finish(false) }, 'Cancel'), h('button', { type: 'button', class: 'plain gbm-btn gbm-danger', onclick: () => finish(true) }, okLabel))));
      document.body.append(back); back.querySelector('.gbm-danger').focus();
    });
  }
  /** "Add to playlist" menu: every playlist, plus a new one. body says which songs (tokens, uid or link). */
  function saveMenu(anchor, body, label = 'song') {
    const lists = M.data?.playlists ?? [];
    menu(anchor, [
      { label: 'New playlist…', icon: 'plus', run: async () => { const name = await askName('New playlist', '', 'Create'); if (!name) return; const r = await call('playlist', { op: 'create', name, ...body }); await reload(); M.opts.toast(`Saved to “${r.playlist.name}”`); } },
      lists.length ? '-' : null,
      ...lists.slice(0, 30).map((p) => ({ label: p.name, icon: 'note', run: async () => { const r = await call('playlist', { op: 'add', id: p.id, ...body }); if (M.playlist?.id === p.id) M.playlist = r.playlist; await reload(); M.opts.toast(r.added ? `Added ${r.added === 1 ? `the ${label}` : `${r.added} songs`} to “${p.name}”${r.skipped ? ` (${r.skipped} uploaded song${r.skipped === 1 ? '' : 's'} can't be kept)` : ''}` : "Uploaded songs can't be kept in a playlist."); } })),
    ]);
  }

  // ------------------------------------------------------------------ the page
  function paint() {
    if (!M.root || !M.data) return;
    closeMenu();
    const d = M.data;
    const lib = h('nav', { class: 'gbm-lib', 'aria-label': 'Music' },
      h('div', { class: 'gbm-lib-top' },
        navItem('home', 'Now playing', M.view === 'home', () => { M.view = 'home'; paint(); }),
        navItem('search', 'Search', M.view === 'search', () => { M.view = 'search'; paint(); setTimeout(() => M.root.querySelector('.gbm-search input')?.focus(), 30); })),
      h('div', { class: 'gbm-lib-head' }, h('span', {}, 'Your playlists'), h('span', { class: 'gbm-grow' }),
        btn('import', 'Import a playlist from Spotify, YouTube and more', () => importList().catch(() => {}), { size: 18 }),
        btn('plus', 'New playlist', async () => { const name = await askName('New playlist', '', 'Create'); if (!name) return; const r = await call('playlist', { op: 'create', name }); await reload(); openPlaylist(r.playlist.id); }, { size: 18 })),
      h('div', { class: 'gbm-lib-list' }, (d.playlists ?? []).length ? d.playlists.map((p) => h('button', { type: 'button', class: `plain gbm-pl${M.view === `playlist:${p.id}` ? ' on' : ''}`, onclick: () => openPlaylist(p.id) },
        cover(p, 44, p.art.length ? p.art : null), h('span', { class: 'gbm-two' }, h('b', {}, p.name), h('small', {}, `Playlist · ${p.count} song${p.count === 1 ? '' : 's'}`))))
        : h('div', { class: 'gbm-pad' }, h('p', { class: 'gbm-muted' }, 'No playlists yet. Make one with +, save the queue as a playlist, or bring one over from Spotify, YouTube and more.'),
          h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost small', onclick: () => importList().catch(() => {}) }, icon('import', 16), ' Import a playlist'))),
      M.opts.admin && M.opts.openSettings ? h('button', { type: 'button', class: 'plain gbm-pl gbm-settings', onclick: () => M.opts.openSettings() }, h('span', { class: 'gbm-cover small' }, icon('gear', 18)), h('span', { class: 'gbm-two' }, h('b', {}, 'Music settings'), h('small', {}, 'Stations, uploads, DJ role, limits'))) : null);
    const main = h('section', { class: 'gbm-main' });
    const bar = h('footer', { class: 'gbm-bar', 'aria-label': 'Player' });
    M.root.replaceChildren(h('div', { class: 'gbm' }, lib, main, bar));
    paintMain(); paintBar();
  }
  const navItem = (ic, label, on, run) => h('button', { type: 'button', class: `plain gbm-nav${on ? ' on' : ''}`, 'aria-current': on ? 'page' : null, onclick: run }, icon(ic, 22), h('span', {}, label));

  function paintMain() {
    const main = M.root?.querySelector('.gbm-main');
    if (!main) return;
    const keepScroll = main.scrollTop;
    if (M.view === 'search') main.replaceChildren(...searchPage());
    else if (M.view.startsWith('playlist:')) main.replaceChildren(...playlistPage());
    else main.replaceChildren(...homePage());
    main.scrollTop = keepScroll;
  }

  function channelPicker() {
    const d = M.data;
    const list = d.voiceChannels ?? [];
    if (!list.length) return h('p', { class: 'gbm-muted' }, 'This server has no voice channels.');
    const sel = h('select', { class: 'gbm-select', 'aria-label': 'Voice channel to play in', onchange: (e) => { M.channelId = e.target.value; } },
      list.map((c) => h('option', { value: c.id, selected: c.id === M.channelId, disabled: !c.canJoin }, `🔊 ${c.name}${c.listeners ? ` · ${c.listeners} listening` : ''}${c.canJoin ? '' : " · I can't join"}`)));
    return sel;
  }

  function homePage() {
    const d = M.data, t = d.current;
    const out = [];
    if (!d.connected || !t) {
      out.push(h('div', { class: 'gbm-hero idle' },
        h('div', { class: 'gbm-hero-art' }, cover({ title: 'Good Boy' }, 200)),
        h('div', { class: 'gbm-hero-text' },
          h('small', { class: 'gbm-kicker' }, d.connected ? `In 🔊 ${d.channelName ?? 'voice'}` : 'Not in voice'),
          h('h2', {}, d.connected ? 'Nothing playing' : 'Pick a channel and press play'),
          h('p', { class: 'gbm-muted' }, d.connected ? 'Search for something, or play one of your playlists.' : 'Good Boy joins the voice channel you pick when you play something.'),
          !d.connected ? h('div', { class: 'gbm-row' }, channelPicker(), h('button', { type: 'button', class: 'plain gbm-btn', onclick: () => call('join', { channelId: M.channelId }, 'Joined voice') }, 'Join')) : null,
          h('div', { class: 'gbm-row' }, h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost', onclick: () => { M.view = 'search'; paint(); setTimeout(() => M.root.querySelector('.gbm-search input')?.focus(), 30); } }, icon('search', 18), ' Search for songs')))));
      if ((d.playlists ?? []).length) {
        out.push(h('h3', { class: 'gbm-h' }, 'Your playlists'),
          h('div', { class: 'gbm-cards' }, d.playlists.slice(0, 12).map((p) => h('div', { class: 'gbm-card' },
            h('button', { type: 'button', class: 'plain gbm-card-hit', 'aria-label': `Open ${p.name}`, onclick: () => openPlaylist(p.id) }),
            h('div', { class: 'gbm-card-art' }, cover(p, 160, p.art.length ? p.art : null),
              h('button', { type: 'button', class: 'plain gbm-play-fab', title: `Play ${p.name}`, 'aria-label': `Play ${p.name}`, disabled: !p.count, onclick: () => call('playlist', { op: 'play', id: p.id, ...voiceBody() }, `Playing “${p.name}”`) }, icon('play', 22))),
            h('b', {}, p.name), h('small', { class: 'gbm-muted' }, `${p.count} song${p.count === 1 ? '' : 's'}${p.seconds ? ` · ${longTime(p.seconds)}` : ''}`)))));
      }
      return out;
    }
    out.push(h('div', { class: 'gbm-hero', style: { '--h': hue(t.title) } },
      h('div', { class: 'gbm-hero-art' }, cover(t, 220)),
      h('div', { class: 'gbm-hero-text' },
        h('small', { class: 'gbm-kicker' }, d.preparing ? 'Getting it ready' : d.paused ? 'Paused' : 'Now playing', ` · 🔊 ${d.channelName ?? 'voice'}${d.listeners ? ` · ${d.listeners} listening` : ''}`),
        h('h2', {}, t.title),
        h('p', { class: 'gbm-artist' }, [t.artist, sourceLabel(t)].filter(Boolean).join(' · ')),
        t.byName ? h('p', { class: 'gbm-muted' }, `Added by ${t.byName}`) : null,
        t.credit ? h('p', { class: 'gbm-credit' }, t.credit) : null,
        h('div', { class: 'gbm-row' },
          t.canSave ? h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost', onclick: (e) => saveMenu(e.currentTarget, { uid: t.uid }) }, icon('heart', 16), ' Save to playlist') : null,
          t.page ? h('a', { class: 'gbm-btn gbm-ghost', href: t.page, target: '_blank', rel: 'noopener noreferrer' }, `Open on ${t.site ?? 'the site'}`) : null))));
    out.push(queueSection());
    return out;
  }

  function queueSection() {
    const d = M.data;
    const rows = d.queue ?? [];
    const box = h('div', { class: 'gbm-section' },
      h('div', { class: 'gbm-section-head' }, h('h3', { class: 'gbm-h' }, `Up next${d.queueLength ? ` · ${d.queueLength}` : ''}`),
        h('span', { class: 'gbm-muted' }, d.totalSeconds ? longTime(d.totalSeconds) : ''), h('span', { class: 'gbm-grow' }),
        rows.length > 1 ? h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost small', onclick: () => call('control', { do: 'shuffle' }, 'Shuffled') }, icon('shuffle', 16), ' Shuffle') : null,
        rows.length ? h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost small', onclick: async () => { const name = await askName('Save the queue as a playlist', `Queue ${new Date().toLocaleDateString()}`, 'Save'); if (!name) return; const r = await call('playlist', { op: 'create', name, fromQueue: true }); await reload(); M.opts.toast(`Saved ${r.added} songs to “${r.playlist.name}”`); } }, icon('plus', 16), ' Save as playlist') : null,
        rows.length ? h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost small', onclick: async () => { if (await sure('Clear the queue?', `The ${rows.length} song${rows.length === 1 ? '' : 's'} waiting are removed. The song playing keeps playing.`, 'Clear')) call('queue', { op: 'clear' }, 'Queue cleared'); } }, 'Clear') : null));
    if (!rows.length) { box.append(h('p', { class: 'gbm-muted gbm-pad' }, 'Nothing waiting. Search for a song or play a playlist.')); return box; }
    box.append(trackList(rows.map((t, k) => ({ t, k })), {
      key: (r) => r.t.uid,
      drag: (from, to) => call('queue', { op: 'move', uid: rows[from].uid, to }),
      actions: (r) => [
        btn('play', 'Play now', () => call('queue', { op: 'play', uid: r.t.uid }), { size: 16 }),
        btn('up', 'Play next', () => call('queue', { op: 'top', uid: r.t.uid }, 'It plays next'), { size: 16 }),
        r.t.canSave ? btn('heart', 'Save to a playlist', (e) => saveMenu(e.currentTarget, { uid: r.t.uid }), { size: 16 }) : null,
        btn('trash', 'Remove', () => call('queue', { op: 'remove', uid: r.t.uid }), { size: 16 }),
      ],
      dbl: (r) => call('queue', { op: 'play', uid: r.t.uid }),
      extra: (r) => r.t.byName ?? '',
    }));
    return box;
  }

  /** The song table used by the queue, playlists and search. Rows can be dragged to reorder when drag is given. */
  function trackList(rows, { key, drag = null, actions, dbl = null, extra = null, start = 1 }) {
    const list = h('ol', { class: 'gbm-tracks' });
    let from = null;
    rows.forEach((r, k) => {
      const t = r.t;
      const li = h('li', { class: 'gbm-track', draggable: drag ? 'true' : null, 'data-k': k, ondblclick: dbl ? () => dbl(r) : null },
        h('span', { class: 'gbm-num' }, drag ? h('span', { class: 'gbm-grip' }, icon('grip', 14)) : null, h('span', { class: 'gbm-n' }, String(k + start))),
        cover(t, 40),
        h('span', { class: 'gbm-two' }, h('b', {}, t.title), h('small', {}, [t.artist, sourceLabel(t)].filter(Boolean).join(' · '))),
        h('span', { class: 'gbm-extra gbm-muted' }, extra ? extra(r) : ''),
        h('span', { class: 'gbm-dur gbm-muted' }, t.seconds ? clock(t.seconds) : t.source === 'radio' ? 'LIVE' : '–'),
        h('span', { class: 'gbm-acts' }, actions(r)));
      if (drag) {
        li.addEventListener('dragstart', (e) => { from = k; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(k)); } catch { /* old browsers */ } });
        li.addEventListener('dragend', () => { li.classList.remove('dragging'); for (const x of list.children) x.classList.remove('over'); });
        li.addEventListener('dragover', (e) => { e.preventDefault(); for (const x of list.children) x.classList.toggle('over', x === li); });
        li.addEventListener('drop', (e) => { e.preventDefault(); const to = k; if (from != null && from !== to) drag(from, to); from = null; });
      }
      list.append(li);
    });
    void key;
    return list;
  }

  function searchPage() {
    const d = M.data, S = M.search;
    const input = h('input', { type: 'search', value: S.q, placeholder: d.sources?.media ? 'Songs, artists, or paste a YouTube, Spotify or SoundCloud link' : 'Search, or paste a link to an audio file', 'aria-label': 'Search for music', maxlength: 300 });
    const run = async () => {
      const q = input.value.trim(); if (q.length < 2) return;
      S.q = q; S.busy = true; S.results = null; S.note = null; S.list = null; paintMain();
      try { const r = await call('search', { q }); S.results = r.results; S.note = r.note ?? null; S.list = r.list ?? null; }
      catch (e) { S.results = []; S.note = e.message; }
      S.busy = false; if (M.view === 'search') { paintMain(); M.root.querySelector('.gbm-search input')?.focus(); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    const form = h('div', { class: 'gbm-search' }, icon('search', 22), input, h('button', { type: 'button', class: 'plain gbm-btn', onclick: run }, 'Search'));
    const out = [h('h2', { class: 'gbm-title' }, 'Search'), form];
    if (S.busy) out.push(h('p', { class: 'gbm-muted gbm-pad' }, 'Searching…'));
    else if (S.results) {
      if (S.note) out.push(h('p', { class: 'gbm-note' }, S.note));
      const tokens = S.results.map((r) => r.token);
      if (S.list) out.push(h('div', { class: 'gbm-section-head' }, h('h3', { class: 'gbm-h' }, `${S.list.site ?? ''} ${S.list.kind === 'album' ? 'album' : 'playlist'}: ${S.list.name} · ${S.list.count} songs`.trim()), h('span', { class: 'gbm-grow' }),
        h('button', { type: 'button', class: 'plain gbm-btn small', onclick: () => call('add', { tokens, ...voiceBody() }, (r) => `Added ${r.added} songs to the queue`) }, 'Add all to the queue'),
        h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost small', onclick: async () => { const name = await askName('Save as a playlist', S.list.name, 'Save'); if (!name) return; const r = await call('playlist', { op: 'create', name, tokens }); await reload(); M.view = 'search'; paint(); M.opts.toast(`Saved ${r.added} songs to “${r.playlist.name}”`); } }, 'Save as a playlist')));
      if (!S.results.length && !S.note) out.push(h('p', { class: 'gbm-muted gbm-pad' }, `Nothing found for “${S.q}”.`));
      if (S.results.length) out.push(trackList(S.results.map((t) => ({ t })), {
        key: (r) => r.t.token,
        actions: (r) => [
          btn('play', 'Play now', () => call('add', { token: r.t.token, where: 'now', ...voiceBody() }, `Playing “${r.t.title}”`), { size: 16 }),
          btn('queue', 'Add to the queue', () => call('add', { token: r.t.token, ...voiceBody() }, 'Added to the queue'), { size: 16 }),
          r.t.canSave ? btn('plus', 'Add to a playlist', (e) => saveMenu(e.currentTarget, { token: r.t.token }), { size: 16 }) : null,
        ],
        dbl: (r) => call('add', { token: r.t.token, where: 'now', ...voiceBody() }, `Playing “${r.t.title}”`),
      }));
    } else {
      const tips = [d.sources?.media ? 'YouTube search is on (media links).' : null, d.sources?.jamendo ? 'Free Creative Commons music from Jamendo.' : null, d.sources?.stations?.length ? `${d.sources.stations.length} radio station${d.sources.stations.length === 1 ? '' : 's'}.` : null].filter(Boolean);
      out.push(h('p', { class: 'gbm-muted gbm-pad' }, tips.length ? `What you can search here: ${tips.join(' ')} You can also paste a link.` : 'Paste a link to an audio file. The bot owner can turn on YouTube and Spotify links with /music in Discord, and admins can add radio stations in the music settings.'));
      if (d.sources?.stations?.length) out.push(h('h3', { class: 'gbm-h' }, 'Radio stations'), h('div', { class: 'gbm-chips' }, d.sources.stations.map((s) => h('button', { type: 'button', class: 'plain gbm-chip', onclick: () => call('add', { station: s.id, ...voiceBody() }, `Added ${s.name}`) }, icon('speaker', 16), ` ${s.name}`))));
    }
    if (!d.connected) out.push(h('div', { class: 'gbm-row gbm-pad' }, h('span', { class: 'gbm-muted' }, 'Plays in'), channelPicker()));
    return out;
  }

  function playlistPage() {
    const p = M.playlist;
    if (!p) return [h('p', { class: 'gbm-muted gbm-pad' }, 'Loading playlist…')];
    const out = [h('div', { class: 'gbm-hero', style: { '--h': hue(p.name) } },
      h('div', { class: 'gbm-hero-art' }, cover(p, 200, p.art.length ? p.art : null)),
      h('div', { class: 'gbm-hero-text' }, h('small', { class: 'gbm-kicker' }, 'Playlist'), h('h2', {}, p.name),
        h('p', { class: 'gbm-muted' }, [p.byName ? `Made by ${p.byName}` : null, `${p.count} song${p.count === 1 ? '' : 's'}`, p.seconds ? longTime(p.seconds) : null].filter(Boolean).join(' · ')),
        h('div', { class: 'gbm-row' },
          h('button', { type: 'button', class: 'plain gbm-play-big', title: 'Play', 'aria-label': `Play ${p.name}`, disabled: !p.count, onclick: () => call('playlist', { op: 'play', id: p.id, ...voiceBody() }, `Playing “${p.name}”`) }, icon('play', 28)),
          btn('shuffle', 'Shuffle play', () => call('playlist', { op: 'play', id: p.id, shuffle: true, ...voiceBody() }, `Shuffling “${p.name}”`), { size: 24, disabled: !p.count }),
          h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost small', disabled: !p.count, onclick: () => call('playlist', { op: 'play', id: p.id, replace: false, ...voiceBody() }, (r) => `Added ${r.added} songs to the queue`) }, 'Add to the queue'),
          btn('more', 'More', (e) => menu(e.currentTarget, [
            { label: 'Rename', run: async () => { const name = await askName('Rename playlist', p.name); if (!name) return; const r = await call('playlist', { op: 'rename', id: p.id, name }); M.playlist = r.playlist; await reload(); } },
            { label: 'Delete playlist', icon: 'trash', danger: true, run: async () => { if (!(await sure(`Delete “${p.name}”?`, 'The playlist is deleted for everyone on this server. Songs already in the queue keep playing.', 'Delete'))) return; await call('playlist', { op: 'delete', id: p.id }, 'Playlist deleted'); M.view = 'home'; M.playlist = null; reload(); } },
          ]), { size: 22 })),
        !M.data.connected ? h('div', { class: 'gbm-row' }, h('span', { class: 'gbm-muted' }, 'Plays in'), channelPicker()) : null))];
    if (p.tracks.length) out.push(trackList(p.tracks.map((t) => ({ t })), {
      key: (r) => r.t.id,
      drag: async (from, to) => { const r = await call('playlist', { op: 'move', id: p.id, trackId: p.tracks[from].id, to }); M.playlist = r.playlist; paintMain(); },
      actions: (r) => [
        btn('play', 'Play from here', () => call('playlist', { op: 'play', id: p.id, trackId: r.t.id, ...voiceBody() }, `Playing “${r.t.title}”`), { size: 16 }),
        btn('trash', 'Remove from the playlist', async () => { const x = await call('playlist', { op: 'remove', id: p.id, trackId: r.t.id }); M.playlist = x.playlist; paintMain(); reload(); }, { size: 16 }),
      ],
      dbl: (r) => call('playlist', { op: 'play', id: p.id, trackId: r.t.id, ...voiceBody() }, `Playing “${r.t.title}”`),
    }));
    else out.push(h('p', { class: 'gbm-muted gbm-pad' }, 'This playlist is empty. Find songs below, or use the ♥ on the song playing.'));
    // find songs to add, right here
    const input = h('input', { type: 'search', placeholder: 'Find songs to add, or paste a link', 'aria-label': 'Find songs to add', maxlength: 300 });
    const res = h('div', {});
    const find = async () => {
      const q = input.value.trim(); if (q.length < 2) return;
      res.replaceChildren(h('p', { class: 'gbm-muted gbm-pad' }, 'Searching…'));
      try {
        const r = await call('search', { q });
        res.replaceChildren(r.note ? h('p', { class: 'gbm-note' }, r.note) : null, r.results.length ? trackList(r.results.map((t) => ({ t })), {
          key: (x) => x.t.token,
          actions: (x) => [x.t.canSave ? h('button', { type: 'button', class: 'plain gbm-btn gbm-ghost small', onclick: async () => { const y = await call('playlist', { op: 'add', id: p.id, token: x.t.token }); M.playlist = y.playlist; paintMain(); reload(); M.opts.toast(`Added “${x.t.title}”`); } }, 'Add') : null],
        }) : (!r.note ? h('p', { class: 'gbm-muted gbm-pad' }, 'Nothing found.') : null));
        if (r.list) res.prepend(h('div', { class: 'gbm-row' }, h('button', { type: 'button', class: 'plain gbm-btn small', onclick: async () => { const y = await call('playlist', { op: 'add', id: p.id, tokens: r.results.map((x) => x.token) }); M.playlist = y.playlist; paintMain(); reload(); M.opts.toast(`Added ${y.added} songs`); } }, `Add all ${r.results.length} songs`)));
      } catch (e) { res.replaceChildren(h('p', { class: 'gbm-note' }, e.message)); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
    out.push(h('div', { class: 'gbm-section' }, h('h3', { class: 'gbm-h' }, "Let's find something for your playlist"), h('div', { class: 'gbm-search' }, icon('search', 20), input, h('button', { type: 'button', class: 'plain gbm-btn', onclick: find }, 'Search')), res));
    return out;
  }

  // ------------------------------------------------------------------ the player bar
  const volIcon = (v) => (v <= 0 ? 'vol0' : v < 50 ? 'vol1' : 'vol2');
  function paintBar() {
    const bar = M.root?.querySelector('.gbm-bar');
    if (!bar || !M.data) return;
    const d = M.data, t = d.current;
    if (M.dragVol || M.dragSeek) { updateTime(); return; } // don't yank a slider someone is holding
    const left = h('div', { class: 'gbm-bar-left' }, t ? [cover(t, 56), h('div', { class: 'gbm-two' }, h('b', { title: t.title }, t.title), h('small', {}, d.preparing ? 'Getting the song ready…' : t.artist || sourceLabel(t) || '')), t.canSave ? btn('heart', 'Save to a playlist', (e) => saveMenu(e.currentTarget, { uid: t.uid }), { size: 18, cls: 'gbm-heart' }) : null]
      : [cover({ title: '' }, 56), h('div', { class: 'gbm-two' }, h('b', {}, d.connected ? 'Nothing playing' : 'Not in voice'), h('small', {}, d.connected ? `🔊 ${d.channelName ?? ''}` : 'Play something to start'))]);
    const rep = d.repeat ?? 'off';
    const repBtn = btn('repeat', rep === 'one' ? 'Repeat: this song' : rep === 'all' ? 'Repeat: the queue' : 'Repeat: off', () => call('control', { do: 'repeat' }), { cls: `gbm-toggle${rep !== 'off' ? ' on' : ''}${rep === 'one' ? ' one' : ''}`, disabled: !d.connected, pressed: rep !== 'off' });
    const center = h('div', { class: 'gbm-bar-center' },
      h('div', { class: 'gbm-controls' },
        btn('shuffle', 'Shuffle the queue', () => call('control', { do: 'shuffle' }, 'Shuffled'), { disabled: !d.connected || (d.queueLength ?? 0) < 2, cls: 'gbm-toggle' }),
        btn('prev', 'Back', () => call('control', { do: 'back' }), { disabled: !d.hasBack }),
        h('button', { type: 'button', class: 'plain gbm-playpause', title: d.paused || !t ? 'Play' : 'Pause', 'aria-label': d.paused || !t ? 'Play' : 'Pause', disabled: !t, onclick: () => call('control', { do: 'toggle' }) }, icon(d.paused || !t ? 'play' : 'pause', 22)),
        btn('next', 'Skip', () => call('control', { do: 'skip' }), { disabled: !t }),
        repBtn),
      seekRow());
    const vol = h('input', { type: 'range', min: 0, max: 100, step: 1, value: d.volume ?? 70, class: 'gbm-range gbm-vol', 'aria-label': 'Volume', style: { '--p': `${d.volume ?? 70}%` } });
    const volBtn = btn(volIcon(d.volume ?? 70), (d.volume ?? 70) > 0 ? 'Mute' : 'Unmute', () => { const now = d.volume ?? 70; if (now > 0) M.lastVol = now; setVol(now > 0 ? 0 : (M.lastVol || 70), true); }, { size: 20 });
    const volNum = h('span', { class: 'gbm-volnum gbm-muted' }, `${d.volume ?? 70}%`);
    vol.addEventListener('pointerdown', () => { M.dragVol = true; });
    vol.addEventListener('input', () => { vol.style.setProperty('--p', `${vol.value}%`); volNum.textContent = `${vol.value}%`; volBtn.replaceChildren(icon(volIcon(Number(vol.value)), 20)); setVol(Number(vol.value), false); });
    vol.addEventListener('change', () => { M.dragVol = false; setVol(Number(vol.value), true); });
    const right = h('div', { class: 'gbm-bar-right' },
      d.connected ? h('span', { class: 'gbm-where', title: `Playing in ${d.channelName ?? 'voice'}` }, icon('speaker', 16), h('span', {}, d.channelName ?? 'voice')) : null,
      d.connected ? btn('stop', 'Stop and leave voice', async () => { if (await sure('Stop the music?', 'Good Boy stops playing, clears the queue and leaves the voice channel.', 'Stop')) call('control', { do: 'stop' }, 'Stopped'); }, { size: 18 }) : null,
      volBtn, vol, volNum);
    bar.replaceChildren(left, center, right);
    updateTime();
  }
  /** The slider moves freely; the volume is sent when it's let go (or a moment after the arrow keys stop). */
  function setVol(v, now) {
    clearTimeout(M.volTimer);
    M.data.volume = v; M.volSetAt = Date.now();
    const send = () => { M.volSetAt = Date.now(); call('volume', { value: v }).catch(() => {}); };
    if (now) send(); else M.volTimer = setTimeout(send, 600);
  }
  function seekRow() {
    const d = M.data, t = d.current;
    const total = t?.seconds ?? 0;
    const range = h('input', { type: 'range', min: 0, max: Math.max(1, total), step: 1, value: Math.floor(elapsedNow()), class: 'gbm-range gbm-seek', 'aria-label': 'Song position', disabled: !d.canSeek });
    range.addEventListener('pointerdown', () => { if (d.canSeek) M.dragSeek = true; });
    range.addEventListener('input', () => { range.style.setProperty('--p', `${(range.value / Math.max(1, total)) * 100}%`); M.root.querySelector('.gbm-t0').textContent = clock(Number(range.value)); });
    range.addEventListener('change', async () => { M.dragSeek = false; const s = Number(range.value); await call('seek', { seconds: s }).catch(() => {}); });
    return h('div', { class: 'gbm-seekrow' }, h('span', { class: 'gbm-t0 gbm-muted' }, '0:00'), range, h('span', { class: 'gbm-t1 gbm-muted' }, t ? (total ? clock(total) : t.source === 'radio' ? 'LIVE' : '–:––') : '0:00'));
  }
  function updateTime() {
    if (!M.root?.isConnected) return stopAll();
    const d = M.data; if (!d || M.dragSeek) return;
    const range = M.root.querySelector('.gbm-seek'), t0 = M.root.querySelector('.gbm-t0');
    if (!range || !t0) return;
    const e = elapsedNow(), total = d.current?.seconds ?? 0;
    t0.textContent = clock(e);
    range.value = String(Math.floor(e));
    range.style.setProperty('--p', `${total ? Math.min(100, (e / total) * 100) : 0}%`);
  }
  function stopAll() { clearInterval(M.ticker); M.ticker = null; M.es?.close(); M.es = null; closeMenu(); }

  // ------------------------------------------------------------------ mount
  window.GBMusic = {
    /**
     * Shows the music page in root. opts: { gid, api(path, body), toast(text, bad), admin, openSettings(), ownLive }
     * ownLive: open a live connection here (the phone app); the dashboard passes live updates in with update().
     */
    mount(root, opts) {
      stopAll();
      M.root = root; M.opts = opts; M.data = null;
      if (M.opts.gid !== M.gid) { M.gid = M.opts.gid; M.view = 'home'; M.playlist = null; M.search = { q: '', results: null, note: null, list: null, busy: false }; M.channelId = null; }
      root.classList.add('gbm-root');
      root.replaceChildren(h('div', { class: 'gbm-empty' }, h('p', { class: 'gbm-muted' }, 'Loading the player…')));
      reload().then(() => { if (M.view.startsWith('playlist:')) openPlaylist(M.view.slice(9)); });
      M.ticker = setInterval(updateTime, 500);
      if (opts.ownLive && typeof EventSource !== 'undefined') {
        M.es = new EventSource(`/api/guilds/${opts.gid}/live`);
        M.es.addEventListener('music', (e) => { try { take(JSON.parse(e.data).state); } catch { /* bad event */ } });
        M.es.addEventListener('data', (e) => { try { if (JSON.parse(e.data).module === 'music') GBMusic.refresh(); } catch { /* bad event */ } });
      }
    },
    /** A live player state from the dashboard's own connection. */
    update(st) { if (M.root?.isConnected) take(st); },
    /** Playlists or channels may have changed: fetch the full view again (debounced). */
    refresh() { if (!M.root?.isConnected) return; clearTimeout(M.refreshT); M.refreshT = setTimeout(async () => { const keepView = M.view; await reload(); if (keepView.startsWith('playlist:') && M.playlist) { try { M.playlist = await view('playlist', { id: M.playlist.id }); paintMain(); } catch { /* deleted */ } } }, 500); },
    unmount() { stopAll(); M.root = null; },
  };
})();
