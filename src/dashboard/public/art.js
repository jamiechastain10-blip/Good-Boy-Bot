// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// "Your art" (3.2): the bot owner swaps Good Boy's roleplay GIFs and critter pictures for their own, from the dashboard.
// Drop a picture on a card, or press Add. Built from DOM nodes and text only (no HTML strings).
'use strict';
(function () {
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const A = { root: null, opts: null, data: null, kind: 'rp', filter: '', only: false, stamp: Date.now() };
  const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const url = (kind, name, ...rest) => `/api/art/${encodeURIComponent(kind)}/${encodeURIComponent(name)}${rest.length ? '/' + rest.map(encodeURIComponent).join('/') : ''}`;
  const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;

  async function load() {
    try { A.data = await A.opts.api('/api/art'); paint(); }
    catch (e) { A.root.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' }, e.message))); }
  }
  /** Sends pictures one after another, then shows the card again. */
  async function upload(kind, entry, files, { replace = false } = {}) {
    const list = [...files];
    if (!list.length) return;
    let added = 0;
    for (const f of list) {
      if (!TYPES.includes(f.type)) { A.opts.toast(`“${f.name}” isn't a picture. Use PNG, JPG, GIF or WEBP.`, true); continue; }
      if (f.size > A.data.maxBytes) { A.opts.toast(`“${f.name}” is over ${mb(A.data.maxBytes)}.`, true); continue; }
      try {
        const res = await fetch(`${url(kind, entry.name)}${replace ? '?replace=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-GoodBoy': '1' }, body: f });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'The upload did not work.');
        added++;
      } catch (e) { A.opts.toast(e.message, true); break; }
    }
    if (added) A.opts.toast(added === 1 ? `Saved. ${entry.title} now uses your picture.` : `Saved ${added} pictures for ${entry.title}.`);
    A.stamp = Date.now();
    await load();
  }
  async function remove(kind, entry, file) {
    try { await A.opts.api(url(kind, entry.name, 'remove'), file ? { file } : { all: true }); A.opts.toast(file ? 'Removed.' : `${entry.title} is back to Good Boy's own picture.`); }
    catch (e) { A.opts.toast(e.message, true); }
    A.stamp = Date.now();
    await load();
  }

  function card(kind, entry) {
    const mine = entry.files.length > 0;
    const many = kind.kind === 'rp';
    const input = h('input', { type: 'file', accept: TYPES.join(','), multiple: many, hidden: true, onchange: (e) => { upload(kind.kind, entry, e.target.files, { replace: !many }); e.target.value = ''; } });
    const main = mine ? url(kind.kind, entry.name, 'file', entry.files[0].file) : url(kind.kind, entry.name, 'builtin');
    const full = entry.files.length >= A.data.maxPerName || (!many && mine);
    const el = h('div', { class: `gba-card${mine ? ' mine' : ''}` },
      h('div', { class: 'gba-pic' }, h('img', { src: `${main}?t=${A.stamp}`, alt: mine ? `Your picture for ${entry.title}` : `Good Boy's picture for ${entry.title}`, loading: 'lazy' }),
        h('span', { class: `gba-tag${mine ? ' on' : ''}` }, mine ? (entry.files.length > 1 ? `Yours · ${entry.files.length}` : 'Yours') : 'Built-in'),
        h('div', { class: 'gba-drop' }, 'Drop to use this picture')),
      h('div', { class: 'gba-name' }, h('b', {}, entry.emoji ? `${entry.emoji} ${entry.title}` : entry.title),
        h('small', { class: 'muted' }, mine ? (many && entry.files.length > 1 ? 'One is picked at random each time' : 'Using your picture') : "Using Good Boy's own")),
      mine && entry.files.length > 1 ? h('div', { class: 'gba-strip' }, entry.files.map((f) => h('span', { class: 'gba-thumb' },
        h('img', { src: `${url(kind.kind, entry.name, 'file', f.file)}?t=${A.stamp}`, alt: '', loading: 'lazy' }),
        h('button', { type: 'button', class: 'plain gba-x', title: 'Remove this picture', 'aria-label': 'Remove this picture', onclick: () => remove(kind.kind, entry, f.file) }, '✕')))) : null,
      h('div', { class: 'gba-acts' },
        h('button', { type: 'button', class: 'plain gba-btn', disabled: full && many, title: full && many ? `That's the most (${A.data.maxPerName}). Remove one first.` : null, onclick: () => input.click() }, mine ? (many ? '+ Add another' : 'Replace') : '+ Add your picture'),
        mine ? h('button', { type: 'button', class: 'plain gba-btn gba-ghost', onclick: () => remove(kind.kind, entry, entry.files.length === 1 ? entry.files[0].file : null) }, entry.files.length > 1 ? 'Remove all' : 'Remove') : null),
      input);
    // drag a picture from the computer onto the card
    let depth = 0;
    el.addEventListener('dragenter', (e) => { if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return; e.preventDefault(); depth++; el.classList.add('over'); });
    el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); });
    el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('over'); });
    el.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; el.classList.remove('over');
      const files = [...(e.dataTransfer?.files ?? [])];
      upload(kind.kind, entry, many ? files : files.slice(0, 1), { replace: !many });
    });
    return el;
  }

  // ---- the guided tour: shown by itself the first time, and again from "Show me how"
  const seen = { get() { try { return localStorage.getItem('gb-tour-art') === '1'; } catch { return true; } }, set() { try { localStorage.setItem('gb-tour-art', '1'); } catch { /* blocked */ } } };
  function tour() {
    if (!window.GBTour || !A.root?.isConnected) return;
    const first = () => A.root.querySelector('.gba-card');
    GBTour.start([
      { target: '.gba .segbar', title: 'Pick what to change', text: 'Roleplay covers hug, boop, pat and the rest. Critters are the creatures members catch.' },
      { target: '.gba-search', title: 'Find one by name', text: 'Type a few letters, like “boop”, to jump straight to it.' },
      { target: () => first()?.querySelector('.gba-pic'), title: 'The picture it uses now', text: '“Built-in” means Good Boy’s own picture. Once you add one it says “Yours”.' },
      { target: () => first()?.querySelector('.gba-acts'), title: 'Add your picture', text: 'Press this and pick a picture or GIF from your computer. You can also drag a file straight onto the card. It’s used in every server right away.' },
      { target: () => A.root.querySelector('.gba-card.mine .gba-acts'), title: 'Change your mind?', text: 'Remove takes your picture away and Good Boy’s own comes back. Roleplay actions can have several: one is picked at random each time.' },
      { target: '.gba-only', title: 'See what you changed', text: 'Turn on “Only mine” to show just the ones using your pictures.' },
    ], { onEnd: () => seen.set() });
  }

  function paint() {
    const kinds = A.data.kinds;
    const kind = kinds.find((k) => k.kind === A.kind) ?? kinds[0];
    const q = A.filter.trim().toLowerCase();
    const list = kind.names.filter((n) => (!q || n.title.toLowerCase().includes(q) || n.name.includes(q)) && (!A.only || n.files.length));
    const done = kind.names.filter((n) => n.files.length).length;
    const search = h('input', { type: 'search', class: 'gba-search', placeholder: kind.kind === 'rp' ? 'Find an action, e.g. boop' : 'Find a critter', value: A.filter, 'aria-label': 'Find' });
    search.addEventListener('input', () => { A.filter = search.value; grid.replaceChildren(...cards()); count.textContent = label(); });
    const cards = () => { const qq = A.filter.trim().toLowerCase(); const l = kind.names.filter((n) => (!qq || n.title.toLowerCase().includes(qq) || n.name.includes(qq)) && (!A.only || n.files.length)); return l.length ? l.map((n) => card(kind, n)) : [h('p', { class: 'muted' }, A.only ? "You haven't added any pictures here yet." : 'Nothing with that name.')]; };
    const label = () => `${done} of ${kind.names.length} use your own picture`;
    const count = h('span', { class: 'muted' }, label());
    const grid = h('div', { class: 'gba-grid' }, list.length ? list.map((n) => card(kind, n)) : cards());
    A.root.replaceChildren(
      h('div', { class: 'card' }, h('div', { class: 'gba-head' }, h('h3', {}, 'Your art'), h('button', { type: 'button', class: 'plain gba-btn gba-ghost gba-tour', onclick: tour }, '✨ Show me how')),
        h('p', { class: 'muted' }, "Swap Good Boy's pictures for your own. Drag a picture onto a card, or press Add. They're used in every server this bot is in, straight away."),
        h('p', { class: 'muted' }, `PNG, JPG, GIF or WEBP, up to ${mb(A.data.maxBytes)} each. Roleplay actions can have several (one is picked at random); a critter has one, plus one for its Sparkly version.`)),
      h('div', { class: 'gba-bar' },
        h('div', { class: 'segbar', role: 'group', 'aria-label': 'What to change' }, kinds.map((k) => h('button', { type: 'button', class: k.kind === kind.kind ? 'plain on' : 'plain', 'aria-pressed': String(k.kind === kind.kind), onclick: () => { A.kind = k.kind; A.filter = ''; paint(); } }, k.kind === 'rp' ? 'Roleplay (hug, boop…)' : 'Critters'))),
        search,
        h('label', { class: 'gba-only' }, h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: A.only, onchange: (e) => { A.only = e.target.checked; paint(); } }), h('span', {}, 'Only mine')),
        h('span', { class: 'gba-grow' }), count),
      grid);
    if (!seen.get() && !A.toured) { A.toured = true; setTimeout(tour, 500); }
  }

  window.GBArt = {
    /** opts: { api(path, body), toast(text, bad) } */
    mount(root, opts) { A.root = root; A.opts = opts; root.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading your art…'))); load(); },
  };
})();
