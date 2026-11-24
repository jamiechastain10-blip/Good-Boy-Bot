// Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The launcher's screens. Everything is built from DOM nodes and text (no HTML strings), from the parts in ui.css.
'use strict';
(function () {
  // The browser prints an empty value (null, undefined, false) given to append/prepend/replaceChildren as the word
  // "null". Pages often pass `cond ? thing : null`, so every such call drops the empty values, the way h() does.
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    for (const name of ['append', 'prepend', 'replaceChildren']) {
      const native = proto[name];
      proto[name] = function (...kids) { return native.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
    }
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'string') el.style.cssText = v; // set through the page, so the app's strict content rules allow it
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    server: 'M4 19V9m5 10V5m5 14v-7m5 7V8',
    tickets: 'M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM10 8v8',
    cases: 'M12 3 4 6v5c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6zM9 12l2 2 4-4',
    shop: 'M4 7h16l-1.5 11a2 2 0 0 1-2 1.700H7.500a2 2 0 0 1-2-1.700zM8 7a4 4 0 0 1 8 0',
    economy: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9.5C9 8.4 10.3 8 12 8s3 .5 3 1.5S13.700 11 12 11s-3 .6-3 1.700S10.300 14.500 12 14.500s3-.4 3-1.500M12 6.500V8M12 14.500V16',
    automod: 'M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6zM8 12l3 3 5-6',
    arcade: 'M6 8h12a3 3 0 0 1 3 3v3a3 3 0 0 1-5.500 1.700L15 15H9l-.5.700A3 3 0 0 1 3 14v-3a3 3 0 0 1 3-3zM8 10.500v3M6.500 12h3M16 11.500h.01M18 13h.01',
    fishing: 'M12 3v11a3.500 3.500 0 1 1-3.500-3.500M6 10.500h3',
    updates: 'M12 4v11M7.500 10.500L12 15l4.500-4.500M5 19h14',
    whatsnew: 'M12 3l2.600 5.500 6 .8-4.400 4.200 1.100 6L12 16.600 6.700 19.500l1.100-6L3.400 9.300l6-.8z',
    leavers: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
    inactive: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
    music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    lists: 'M8 6h13M8 12h13M8 18h13M3.500 6h.01M3.500 12h.01M3.500 18h.01',
    permissions: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2',
    commands: 'M4 6l6 6-6 6M12 18h8',
    setup: 'M14.700 6.300a1 1 0 0 0 0 1.400l1.600 1.600a1 1 0 0 0 1.400 0l3.770-3.770a6 6 0 0 1-7.940 7.940l-6.910 6.910a2.120 2.120 0 0 1-3-3l6.910-6.910a6 6 0 0 1 7.940-7.940z',
    images: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.500 9.500h.01',
    rolemenus: 'M20.600 13.400 13.400 20.600a2 2 0 0 1-2.800 0L3 13V3h10l7.600 7.600a2 2 0 0 1 0 2.800zM7.500 7.500h.01',
    checkup: 'M3 12h4l2-5 4 10 2-5h6',
    switch: 'M7 7h11l-3-3M17 17H6l3 3',
    servers: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
    bot: 'M12 3v3M6 6h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 12h.01M15 12h.01M9 16h6',
    help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01',
  };
  /** The pixel look's icons: 8 by 8 squares, drawn as blocks. */
  const PIXEL = {
    home: ['...##...', '..####..', '.######.', '########', '.######.', '.##..##.', '.##..##.', '.######.'],
    servers: ['########', '#......#', '#.#..#.#', '########', '########', '#......#', '#.#..#.#', '########'],
    tickets: ['########', '#.#..#.#', '#.#..#.#', '#.#..#.#', '#.#..#.#', '#.#..#.#', '#.#..#.#', '########'],
    server: ['........', '......##', '..##..##', '..##..##', '#.##..##', '#.##.###', '########', '........'],
    inactive: ['..####..', '.#....#.', '#..##..#', '#..##..#', '#...#..#', '#......#', '.#....#.', '..####..'],
    leavers: ['.####...', '.#......', '.#..#...', '.#..##..', '.######.', '.#..##..', '.#..#...', '.####...'],
    cases: ['########', '#......#', '#.####.#', '#.#..#.#', '.#.##.#.', '.#....#.', '..#..#..', '...##...'],
    arcade: ['........', '.######.', '########', '#.####.#', '########', '.##..##.', '........', '........'],
    fishing: ['....#...', '....#...', '....#...', '....#...', '#...#...', '##..#..#', '.#####..', '..###...'],
    updates: ['...##...', '..####..', '.######.', '...##...', '...##...', '...##...', '########', '........'],
    whatsnew: ['...##...', '...##...', '########', '.######.', '..####..', '.##..##.', '##....##', '........'],
    automod: ['########', '#......#', '#.#..#.#', '#..##..#', '#..##..#', '.#.##.#.', '..#..#..', '...##...'],
    economy: ['..####..', '.######.', '##.##.##', '##.##...', '.######.', '...##.##', '.######.', '..####..'],
    shop: ['..####..', '.#....#.', '########', '#......#', '#......#', '#......#', '#......#', '########'],
    setup: ['..####..', '.##..##.', '.##.....', '..####..', '.....##.', '.##..##.', '..####..', '........'],
    images: ['########', '#......#', '#.#....#', '#......#', '#...##.#', '#..####.', '########', '........'],
    rolemenus: ['..#####.', '.######.', '########', '###..###', '###..###', '.######.', '..####..', '........'],
    lists: ['........', '##.#####', '........', '##.#####', '........', '##.#####', '........', '........'],
    commands: ['........', '##......', '.##.....', '..##....', '.##.....', '##..####', '........', '........'],
    permissions: ['..####..', '.#....#.', '.#....#.', '########', '########', '###..###', '###..###', '########'],
    music: ['...#####', '...#...#', '...#...#', '...#...#', '.###.###', '####.###', '.##..##.', '........'],
    checkup: ['........', '...#....', '...#..#.', '#..#.##.', '####.##.', '#.#####.', '..#..#..', '........'],
    switch: ['..####..', '...###..', '....##..', '........', '..##....', '..###...', '..####..', '........'],
    activity: ['........', '........', '.#...#..', '.##.##..', '#.###.#.', '#..#..##', '...#....', '........'],
    bot: ['...##...', '########', '#......#', '#.#..#.#', '#......#', '#.####.#', '#......#', '########'],
    help: ['..####..', '.#....#.', '......#.', '....##..', '...#....', '...#....', '........', '...#....'],
  };
  function icon(name) {
    if (document.documentElement.dataset.look === 'pixel' && PIXEL[name]) {
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 8 8'); svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('aria-hidden', 'true');
      PIXEL[name].forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') { const r = document.createElementNS(SVG, 'rect'); r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1); svg.append(r); } }));
      return svg;
    }
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    // a page with no icon of its own gets none (an empty path printed an error for each one)
    if (ICONS[name]) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', ICONS[name]); svg.append(p); }
    return svg;
  }
  const app = document.getElementById('app');
  const call = (name, args) => window.GB.call(name, args);
  const S = { names: {}, o: null, page: 'home', guild: null, open: null, topic: 'start', find: '', step: 0, timer: null };

  // ---- small helpers
  function toast(text, bad) {
    const t = h('div', { class: bad ? 'toast bad' : 'toast' }, text);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), bad ? 7000 : 3500);
    pupSays(bad ? 'Uh oh.' : String(text).length < 40 ? text : 'Woof! Done.');
  }
  /** The pixel look's mascot says something in a speech bubble. */
  let pupTimer;
  function pupSays(text) {
    const bubble = document.querySelector('.pup-bubble'), dog = document.querySelector('.pup-corner .dog');
    if (!bubble || !dog) return;
    bubble.textContent = text; bubble.classList.add('show');
    dog.classList.remove('bark'); void dog.offsetWidth; dog.classList.add('bark');
    clearTimeout(pupTimer); pupTimer = setTimeout(() => bubble.classList.remove('show'), 2200);
  }
  /** Runs something slow from a button: the button waits, and a failure is shown as a sentence. */
  async function busy(btn, work) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    try { return await work(); } catch (e) { toast(e.message, true); return undefined; } finally { btn.disabled = false; btn.textContent = label; }
  }
  function theme() {
    const t = S.o ? S.o.prefs.theme : 'system';
    const dark = t === 'dark' || (t === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  function ago(ms) {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return 'less than a minute';
    if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`;
    const hr = Math.floor(m / 60);
    if (hr < 48) return hr === 1 ? '1 hour' : `${hr} hours`;
    return `${Math.floor(hr / 24)} days`;
  }
  const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  function stateLine(live) {
    if (live.phase === 'online') return ['on', `Online as ${live.name}`];
    if (live.phase === 'starting') return ['busy', 'Starting…'];
    if (live.phase === 'problem') return ['bad', 'Stopped: needs attention'];
    return ['', 'Stopped'];
  }
  async function refresh() { S.o = await call('overview'); try { S.upd = await call('update_status'); } catch { /* an older host */ } theme(); return S.o; }
  /** A confirmation that sits where the button was, so nothing pops over the page. */
  function confirmInline(btn, question, yes, work) {
    const row = h('div', { class: 'btns' }, h('span', { class: 'small muted confirm-q' }, question),
      h('button', { class: 'btn danger', type: 'button', onclick: async (e) => { await busy(e.target, work); } }, yes),
      h('button', { class: 'btn quiet', type: 'button', onclick: () => row.replaceWith(btn) }, 'Cancel'));
    btn.replaceWith(row);
    row.querySelector('.btn.quiet').focus();
  }

  // ---- first run
  function wizard() {
    const o = S.o;
    const steps = ['What would you like?', 'Your data', 'Your bot', 'Ready'];
    const bar = h('div', { class: 'steps', role: 'img', 'aria-label': `Step ${S.step + 1} of ${steps.length}` }, steps.map((_, i) => h('i', { class: i <= S.step ? 'done' : '' })));
    const next = (n) => { S.step = n; draw(); };
    let body;
    if (S.step === 0) {
      const pick = (key, value) => async () => { try { await call('prefs_set', { patch: { [key]: value } }); await refresh(); draw(); } catch (e) { toast(e.message, true); } };
      const choice = (key, value, title, sub, off) => h('button', { class: 'choice', type: 'button', disabled: !!off, 'aria-pressed': String(o.prefs[key] === value), onclick: pick(key, value) }, h('b', {}, title), h('span', {}, off || sub));
      body = [
        h('img', { class: 'hello pup-logo', src: 'mascot.png', alt: '', width: 72, height: 72 }),
        h('div', { class: 'head' }, h('h1', {}, 'Welcome to Good Boy'), h('p', { class: 'muted' }, 'Pick what you want on this computer. You can add the rest later.')),
        h('div', { class: 'choices' },
          choice('parts', 'bot', 'Discord bot', 'Levels, money and more for your servers'),
          choice('parts', 'clipper', 'Clipping software', '', 'Not in this build yet'),
          choice('parts', 'both', 'Both', '', 'Not in this build yet')),
        h('div', { class: 'stack' }, h('h3', {}, 'Where will the bot run?'),
          h('div', { class: 'choices two' },
            choice('place', 'pc', 'This PC', 'Online while this app is open'),
            choice('place', 'host', 'A web host', 'Online all the time'))),
        o.prefs.place === 'host' ? h('p', { class: 'note' }, 'Setting up on a host is done with the small no-window version of Good Boy; the guide has the steps under "Running on a web host". You can finish setting up on this PC now and move later: your data is one folder.') : null,
        h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => next(1) }, 'Continue')),
      ];
    } else if (S.step === 1) {
      const done = (r) => { S.setup = r; next(2); };
      const go = (copy) => (e) => busy(e.target, async () => { const r = await call('setup_data', { copy }); await refresh(); done(r); });
      if (o.data) {
        body = [h('div', { class: 'head' }, h('h1', {}, 'Your data is here'), h('p', { class: 'muted' }, `Good Boy 4 already has data on this computer: ${plural(o.data.servers, 'server', 'servers')} and ${plural(o.data.records, 'saved record', 'saved records')}. It is kept as it is.`)),
          h('div', { class: 'row end' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => next(0) }, 'Back'), h('button', { class: 'btn', type: 'button', onclick: () => next(2) }, 'Continue'))];
      } else if (o.old_data) {
        body = [h('div', { class: 'head' }, h('h1', {}, 'Good Boy 3 was found'), h('p', { class: 'muted' }, `It has ${plural(o.old_data.servers || 0, 'server', 'servers')} and ${plural(o.old_data.records || 0, 'saved record', 'saved records')} (levels, coins, settings and more).`)),
          h('p', { class: 'note' }, 'Copying only reads Good Boy 3\'s data. Nothing there is changed, and Good Boy 3 keeps working as before.'),
          h('div', { class: 'row end' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => next(0) }, 'Back'), h('button', { class: 'btn quiet', type: 'button', onclick: go(false) }, 'Start fresh instead'), h('button', { class: 'btn', type: 'button', onclick: go(true) }, 'Copy my data across'))];
      } else {
        body = [h('div', { class: 'head' }, h('h1', {}, 'A fresh start'), h('p', { class: 'muted' }, 'No Good Boy 3 data was found on this computer, so Good Boy 4 starts with a clean slate.')),
          h('p', { class: 'small muted' }, `Your data will be kept in ${o.data_folder}`),
          h('div', { class: 'row end' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => next(0) }, 'Back'), h('button', { class: 'btn', type: 'button', onclick: go(false) }, 'Continue'))];
      }
    } else if (S.step === 2) {
      const copied = S.setup && S.setup.how === 'copied' ? h('p', { class: 'msg good' }, `Copied across: ${plural(S.setup.servers, 'server', 'servers')}, ${plural(S.setup.settings, 'setting', 'settings')} and ${plural(S.setup.records, 'saved record', 'saved records')}.`) : null;
      const input = h('input', { type: 'password', id: 'wtoken', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the token here' });
      const save = (e) => busy(e.target, async () => { const who = await call('token_save', { token: input.value }); input.value = ''; S.who = who; await refresh(); next(3); });
      body = [copied, h('div', { class: 'head' }, h('h1', {}, 'Connect your bot'), h('p', { class: 'muted' }, 'Paste your bot\'s token. Good Boy checks it with Discord, then your computer keeps it safe.')),
        h('p', { class: 'note warn' }, 'Two programs cannot run the same bot at once. If Good Boy 3 is running this bot, close it first, or this one cannot connect.'),
        o.token_saved ? h('p', { class: 'msg good' }, 'A bot token is already saved on this computer.') : null,
        h('div', { class: 'field' }, h('label', { for: 'wtoken' }, 'Bot token'), input, h('span', { class: 'hint' }, `Kept in ${o.secret_store}. It is never shown again.`)),
        h('div', { class: 'row' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => call('open', { what: 'developers' }).catch((e) => toast(e.message, true)) }, 'Open Discord\'s developer page'),
          h('div', { class: 'btns' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => next(3) }, o.token_saved ? 'Keep the saved one' : 'Do this later'), h('button', { class: 'btn', type: 'button', onclick: save }, 'Check and save'))),
      ];
    } else {
      const finish = (start) => (e) => busy(e.target, async () => { await call('prefs_set', { patch: { setup_done: true } }); if (start) await call('bot_start'); await refresh(); S.page = 'home'; draw(); if (!S.o.prefs.toured) setTimeout(() => window.GBTour.offer(), 500); });
      body = [h('div', { class: 'head' }, h('h1', {}, 'You\'re set up'), h('p', { class: 'muted' }, S.who ? `Discord recognised the token: it belongs to ${S.who.name}.` : o.token_saved ? 'Your bot token is saved.' : 'You can add the bot token any time in Settings.')),
        h('p', { class: 'muted' }, 'The Help page has a guide for everything in this app.'),
        h('div', { class: 'row end' }, o.token_saved ? h('button', { class: 'btn quiet', type: 'button', onclick: finish(false) }, 'Finish without starting') : null, h('button', { class: 'btn', type: 'button', onclick: finish(o.token_saved) }, o.token_saved ? 'Start the bot' : 'Finish'))];
    }
    app.replaceChildren(h('div', { class: 'wizard' }, h('div', { class: 'card' }, bar, body)));
  }

  // ---- pages
  // ---- Home, like Good Boy 3's: the numbers with two weeks of history, what needs you, your tools and what just happened
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v)); return e; }
  /** A line with a soft fill and a dot at the newest point. `points`: numbers, null where nothing was counted. */
  function sparkline(points, label) {
    const W = 200, H = 40, P = 3;
    const vals = points.map((v, i) => [i, v]).filter(([, v]) => v != null);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', role: 'img', 'aria-label': label || '' });
    if (vals.length < 2) { svg.classList.add('empty'); return svg; }
    const ys = vals.map(([, v]) => v); let lo = Math.min(...ys), hi = Math.max(...ys);
    if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
    const n = Math.max(1, points.length - 1);
    const xy = vals.map(([i, v]) => [P + (i / n) * (W - 2 * P), H - P - ((v - lo) / (hi - lo)) * (H - 2 * P)]);
    const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    svg.append(svgEl('path', { d: `${line}L${xy[xy.length - 1][0].toFixed(1)},${H}L${xy[0][0].toFixed(1)},${H}Z`, class: 'spark-fill' }), svgEl('path', { d: line, class: 'spark-line' }));
    const [ex, ey] = xy[xy.length - 1];
    svg.append(svgEl('circle', { cx: ex.toFixed(1), cy: ey.toFixed(1), r: 2.6, class: 'spark-dot' }));
    return svg;
  }
  /** Hourly points become one per day: messages add up, voice takes the day's peak, members the day's last count. */
  function daily(points, from, hourMs, how) {
    const out = new Map();
    points.forEach((v, i) => {
      const day = new Date(from + i * hourMs).toDateString(); const was = out.get(day);
      if (v == null) { if (!out.has(day)) out.set(day, null); return; }
      out.set(day, how === 'sum' ? (was ?? 0) + v : how === 'max' ? Math.max(was ?? 0, v) : v);
    });
    return [...out.values()];
  }
  function homeServer() {
    const greet = () => { const hr = new Date().getHours(); return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };
    return withServer(greet(), 'Your server at a glance', async (guild) => {
      const [p, servers, tk, cs] = await Promise.all([call('pulse', { guild }), call('servers'), call('tickets', { guild, limit: 100 }).catch(() => null), call('cases', { guild, limit: 5 }).catch(() => null)]);
      const g = servers.find((x) => x.id === guild) || {};
      const on = (g.modules || []).filter((m) => m.on);
      const days = Math.max(1, Math.round(p.members.filter((v) => v != null).length / 24));
      const series = (key, how) => daily(p[key], p.from, p.hourMs, how);
      const today = (series('messages', 'sum').slice(-1)[0]);
      const members = p.now.members ?? [...p.members].reverse().find((v) => v != null);
      const card = (label, value, key, how, hint) => {
        const pts = key ? series(key, how) : [];
        const has = pts.filter((v) => v != null).length >= 2;
        return h('div', { class: 'stat spark-card' }, h('b', {}, value == null ? '—' : value.toLocaleString()), h('span', {}, label),
          key ? [sparkline(pts, `${label}, last ${days} day${days === 1 ? '' : 's'}`), h('small', { class: 'hint' }, has ? `last ${days >= 14 ? '14 days' : `${days} day${days === 1 ? '' : 's'}`}` : 'collecting, check back in a few hours')] : h('small', { class: 'hint' }, hint));
      };
      // what needs you
      const attn = [];
      if (S.o.live.phase !== 'online') attn.push({ level: 'crit', title: S.o.live.phase === 'problem' ? 'The bot stopped with a problem' : 'The bot is not running', text: S.o.live.problem || 'Nothing works in Discord until it is started.', action: 'Check-up', run: () => go(window.GB.web ? 'home' : 'checkup') });
      for (const m of g.modules || []) if (m.on && m.needs_setup) attn.push({ level: 'warn', title: `${m.name} needs setting up`, text: 'A setting it cannot work without is empty.', action: 'Set up', run: () => { S.open = m.id; S.scrollOpen = true; go('servers'); } });
      const open = (tk?.tickets || []).filter((t) => !t.closed_at);
      const waiting = open.filter((t) => !t.claimed_by);
      if (waiting.length) attn.push({ level: 'crit', title: `${plural(waiting.length, 'ticket', 'tickets')} nobody has claimed`, text: `${open.length} open in total`, action: 'Open tickets', run: () => go('tickets') });
      const list = h('ul', { class: 'attn' }, attn.length ? attn.map((x) => h('li', {}, h('i', { class: `bar ${x.level === 'crit' ? 'crit' : x.level === 'info' ? 'info' : ''}` }), h('div', {}, h('b', {}, x.title), h('span', {}, x.text)), h('button', { class: 'btn quiet', type: 'button', onclick: x.run }, x.action)))
        : h('li', {}, h('i', { class: 'bar ok' }), h('div', {}, h('b', {}, 'All good'), h('span', {}, 'Nothing needs you right now.')), h('span')));
      // the tools, with a live word under each
      const tool = (id, label, note) => h('button', { class: 'quick', type: 'button', onclick: () => go(id) }, h('span', { class: 'qicon' }, icon(id)), h('span', {}, h('strong', {}, label), h('small', {}, note)));
      const tools = h('div', { class: 'quick-grid' },
        tool('tickets', 'Tickets', open.length ? `${open.length} open` : 'none open'),
        tool('cases', 'Moderation', cs ? `${cs.total} case${cs.total === 1 ? '' : 's'}` : 'warn, time out, kick, ban'),
        tool('server', 'Members', 'boards and numbers'),
        tool('economy', 'Economy', 'treasury and taxes'),
        tool('shop', 'Shop', 'roles and items'),
        tool('music', 'Music', 'player and playlists'),
        tool('lists', 'Lists', 'giveaways, commands'),
        tool('permissions', 'Permissions', 'who may use what'));
      // what just happened, live
      const feed = h('div', { class: 'list feed', 'aria-live': 'polite' });
      let last = 0, shown = [];
      const row = (e) => h('div', { class: 'case' }, h('span', { class: `dot ${ACT_DOT[e.kind] || ''}` }), h('div', { class: 'text' }, h('span', {}, e.text)), h('span', { class: 'muted small' }, new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      const load = async () => {
        const r = await call('activity', { guild, sinceId: last });
        if (r.last_id < last) { shown = []; feed.replaceChildren(); }
        last = r.last_id;
        for (const e of r.entries) { shown.push(e); feed.prepend(row(e)); }
        while (shown.length > 12) { shown.shift(); feed.lastElementChild?.remove(); }
        empty.hidden = shown.length > 0;
      };
      const empty = h('p', { class: 'muted small' }, 'Nothing yet. Things show up here as they happen.');
      await load();
      whileShown(feed, 3000, load);
      const numbers = h('div', { class: 'stats' }, card('Members', members, 'members', 'last'), card('In voice now', p.now.voice, 'voice', 'max'), card('Messages today', today, 'messages', 'sum'), card('Modules on', null, null, null, `${on.length} of ${(g.modules || []).length}`));
      numbers.children[3].querySelector('b').textContent = `${on.length} / ${(g.modules || []).length}`;
      // the numbers follow the server: new ones every half minute
      whileShown(numbers, 30000, async () => { const q = await call('pulse', { guild }); const live = [q.now.members, q.now.voice]; const b = numbers.querySelectorAll('b'); if (live[0] != null) b[0].textContent = live[0].toLocaleString(); b[1].textContent = String(live[1]); });
      return [numbers,
        h('div', { class: 'home-grid' },
          h('div', { class: 'home-col' }, h('div', { class: 'card' }, h('h3', {}, 'Needs attention'), list), h('div', { class: 'card' }, h('h3', {}, 'Your tools'), tools)),
          h('div', { class: 'home-col' }, h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Recent activity'), h('span', { class: 'live muted small' }, h('span', { class: 'dot on' }), 'Updates by itself')), empty, feed)))];
    });
  }

  function pageHome() {
    const o = S.o, live = o.live;
    const [dot, line] = stateLine(live);
    const act = (name) => (e) => busy(e.target, async () => { await call(name); await refresh(); draw(); clearTimeout(S.timer); S.timer = setTimeout(tick, 700); });
    const running = live.phase === 'online' || live.phase === 'starting';
    const sub = live.phase === 'online' ? `In ${plural(live.servers, 'server', 'servers')} · online for ${ago(live.online_since_ms)}${live.start_took_ms != null ? ` · started in ${(live.start_took_ms / 1000).toFixed(1)} s` : ''}`
      : live.phase === 'starting' ? 'Connecting to Discord.'
      : !o.token_saved ? 'Add your bot\'s token to get going.' : 'The bot is offline until you start it.';
    const upd = S.upd && S.upd.available ? h('div', { class: 'card note-card', role: 'status' }, h('div', { class: 'row' }, h('div', {}, h('b', {}, `Good Boy ${S.upd.available.version} is ready`), h('p', { class: 'muted small' }, 'A new version is out. It installs in a minute and keeps everything.')), h('button', { class: 'btn', type: 'button', onclick: () => go('updates') }, 'See update'))) : null;
    return [
      upd,
      h('div', { class: 'hero', 'aria-label': 'Good Boy, a Discord bot by Basic Ghost Labs' },
        h('div', { class: 'hero-text' }, h('span', { class: 'hero-eyebrow' }, 'Discord bot'), h('h1', {}, h('span', {}, 'Good'), h('span', { class: 'hero-boy' }, 'Boy')),
          h('p', {}, 'Your server\'s best friend. Levels, tickets, moderation, music and games, in one bot you run yourself.'), h('small', {}, 'Basic Ghost Labs')),
        h('img', { src: 'mascot.png', alt: '', class: 'hero-art' })),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('div', { class: 'text' }, h('h2', { class: 'status' }, h('span', { class: `dot ${dot}` }), line), h('p', { class: 'muted' }, sub)),
          h('div', { class: 'btns' }, window.GB.web && !(o.web && o.web.owner) ? null : !o.token_saved ? (window.GB.web ? h('span', { class: 'muted small' }, 'Add the token in the Good Boy app on the computer.') : h('button', { class: 'btn', type: 'button', onclick: () => go('bot') }, 'Add token'))
            : running ? [h('button', { class: 'btn quiet', type: 'button', title: 'Posts a heads-up in each server\'s announcements channel (Bot news): the bot restarts in 5 minutes', onclick: (e) => busy(e.target, async () => { const n = await call('announce_restart', { minutes: 5 }); toast(n ? `Told ${n} server${n === 1 ? '' : 's'} the bot restarts in 5 minutes.` : 'No server has an announcements channel set (Bot news), so nobody was told.'); }) }, 'Warn servers'), h('button', { class: 'btn quiet', type: 'button', onclick: act('bot_restart') }, 'Restart'), h('button', { class: 'btn quiet', type: 'button', onclick: act('bot_stop') }, 'Stop')]
            : h('button', { class: 'btn', type: 'button', onclick: act('bot_start') }, 'Start'))),
        live.problem ? h('p', { class: live.phase === 'problem' ? 'msg bad' : 'msg' }, live.problem) : null,
        live.notice && live.phase === 'online' ? h('p', { class: 'note warn' }, live.notice) : null,
        live.phase === 'problem' ? h('div', { class: 'btns' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => go('bot') }, 'Open Settings'), h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.topic = 'trouble'; go('help'); } }, 'See what to try')) : null),
      o.data && S.o.web !== null ? homeServer() : null,
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'text' }, h('h3', {}, `Good Boy ${o.version}`), h('p', { class: 'muted small' }, `This build runs ${listed(o.modules.map((m) => m.name))}.`)),
        h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.topic = 'build'; go('help'); } }, 'What\'s in this build'))),
    ];
  }


  // ---- the server's own numbers and moderation cases
  const CASE_WORDS = { warn: 'Warning', timeout: 'Timeout', untimeout: 'Timeout ended', unwarn: 'Warning removed', kick: 'Kick', ban: 'Ban', unban: 'Unban', purge: 'Bulk delete', automod: 'AutoMod' };
  const CASE_DOT = { warn: 'warn', timeout: 'warn', kick: 'bad', ban: 'bad', automod: 'info' };
  // people are shown by name, never by number: names are asked for once and kept
  const who = (id, tag) => tag || S.names[id] || 'Unknown member';
  async function learn(guild, ids) {
    const need = [...new Set(ids.filter(Boolean).map(String))].filter((i) => !(i in S.names));
    if (!need.length) return;
    try { Object.assign(S.names, await call('members_lookup', { guild, ids: need.slice(0, 400) })); } catch { /* names are a nicety */ }
  }
  /** Picks a member by typing part of their name. Gives { el, id(), name(), clear() }; the number never shows. */
  function memberPicker(guild, label = 'Member') {
    let chosen = null, timer = 0;
    const input = h('input', { type: 'search', placeholder: 'Start typing a name', autocomplete: 'off', 'aria-label': label });
    const menu = h('div', { class: 'pickmenu', role: 'listbox', hidden: true });
    const chip = h('div', { class: 'pickchip', hidden: true });
    const face = (m) => (m.avatar ? h('img', { src: m.avatar, alt: '', width: 24, height: 24, referrerpolicy: 'no-referrer' }) : h('span', { class: 'pickdot' }, (m.name || '?').slice(0, 1).toUpperCase()));
    const choose = (m) => { chosen = m; S.names[m.id] = m.name; input.hidden = true; menu.hidden = true; chip.hidden = false; chip.replaceChildren(face(m), h('b', {}, m.name), h('button', { class: 'btn quiet', type: 'button', onclick: clear }, 'Change')); };
    const clear = () => { chosen = null; input.hidden = false; input.value = ''; chip.hidden = true; input.focus(); };
    const show = (list) => {
      menu.replaceChildren(...(list.length ? list.map((m) => h('button', { type: 'button', class: 'pickrow', role: 'option', onmousedown: (e) => { e.preventDefault(); choose(m); } }, face(m), h('span', {}, m.name)))
        : [h('p', { class: 'muted small pickempty' }, 'Nobody by that name yet. Names fill in as members chat, or after a scan on the Inactive page.')]));
      menu.hidden = false;
    };
    const search = async () => { try { show(await call('members_search', { guild, q: input.value })); } catch (e) { toast(e.message, true); } };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 180); });
    input.addEventListener('focus', search);
    input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; }, 150));
    return { el: h('div', { class: 'picker' }, input, menu, chip), id: () => (chosen ? chosen.id : null), name: () => (chosen ? chosen.name : null), clear };
  }
  const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  /** The server picker both data pages share. Calls `then(guildId)` once a server is chosen. */
  function withServer(title, sub, then) {
    const body = h('div', { class: 'stack big' }, h('div', { class: 'head' }, h('h1', {}, title), h('p', { class: 'muted' }, sub)), h('p', { class: 'muted' }, 'Loading…'));
    (async () => {
      let servers;
      try { servers = await call('servers'); } catch (e) { body.replaceChildren(h('p', { class: 'msg bad' }, e.message)); return; }
      if (!servers.length) { body.replaceChildren(h('div', { class: 'head' }, h('h1', {}, title)), h('div', { class: 'card empty' }, h('h2', {}, 'No servers yet'), h('p', { class: 'muted' }, 'Invite the bot to a server and start it. Your server shows up here a moment later.'))); return; }
      const g = servers.find((x) => x.id === S.guild) || servers[0];
      S.guild = g.id;
      const picker = servers.length > 1 ? h('div', { class: 'field slim' }, h('label', { for: 'dguild' }, 'Server'), h('select', { id: 'dguild', onchange: (e) => { S.guild = e.target.value; draw(); } }, servers.map((x) => h('option', { value: x.id, selected: x.id === g.id }, x.name)))) : null;
      const inner = h('div', { class: 'stack big' }, h('p', { class: 'muted' }, 'Loading…'));
      // with a single server there is no picker (an empty one printed the word "null" on every page)
      body.replaceChildren(...[h('div', { class: 'head' }, h('h1', {}, title), h('p', { class: 'muted' }, g.name + ' · ' + sub)), picker, inner].filter(Boolean));
      try { inner.replaceChildren(...(await then(g.id)).filter(Boolean)); } catch (e) { inner.replaceChildren(h('p', { class: 'msg bad' }, e.message)); }
    })();
    return [body];
  }
  function caseRow(c) {
    return h('div', { class: 'case' }, h('span', { class: `dot ${CASE_DOT[c.type] || 'info'}` }),
      h('div', { class: 'text' }, h('b', {}, `#${c.id} · ${CASE_WORDS[c.type] || c.type}`, ' · ', who(c.targetId, c.targetTag)), h('p', { class: 'muted small' }, c.reason || 'No reason given.')),
      h('span', { class: 'muted small' }, c.at ? when(c.at) : ''));
  }
  function board(title, rows, line) {
    return h('div', { class: 'card' }, h('h3', {}, title), rows.length ? h('div', { class: 'list' }, rows.map((r, i) => h('div', {}, h('span', {}, `${i + 1}. `, r.name || who(r.user)), h('b', {}, line(r))))) : h('p', { class: 'muted' }, 'Nobody yet.'));
  }
  function pageServer() {
    return withServer('Members', 'How the server is doing', async (guild) => {
      const d = await call('dashboard', { guild });
      await learn(guild, [...d.boards.xp.map((r) => r.user), ...d.boards.coins.map((r) => r.user), ...d.recent_cases.flatMap((c) => [c.targetId, c.modId])]);
      const n = (v) => (v == null ? '-' : Number(v).toLocaleString());
      return [
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', {}, n(d.members)), h('span', {}, 'Members')),
          h('div', { class: 'stat' }, h('b', {}, n(d.ranked)), h('span', {}, 'On the level board')),
          h('div', { class: 'stat' }, h('b', {}, n(d.wallets)), h('span', {}, 'With coins')),
          h('div', { class: 'stat' }, h('b', {}, n(d.tickets.open)), h('span', {}, `Open tickets (of ${n(d.tickets.total)})`)),
          h('div', { class: 'stat' }, h('b', {}, n(d.cases)), h('span', {}, 'Moderation cases'))),
        h('div', { class: 'two' }, board('Top levels', d.boards.xp, (r) => `Level ${r.level} · ${n(r.xp)} XP`), board('Richest', d.boards.coins, (r) => `${n(r.coins)} coins`)),
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Latest cases'), h('button', { class: 'btn quiet', type: 'button', onclick: () => go('cases') }, 'See all')),
          d.recent_cases.length ? h('div', { class: 'list' }, d.recent_cases.map(caseRow)) : h('p', { class: 'muted' }, 'No cases yet. Nothing to worry about.')),
      ];
    });
  }

  /** Warn, time out, kick or ban from the launcher. Asks again before a kick or ban. */
  function actionForm(guild, after) {
    const f = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('p', { class: 'muted small' }, hint) : null);
    const kind = h('select', { 'aria-label': 'What to do' }, [['warn', 'Warn'], ['timeout', 'Time out'], ['kick', 'Kick'], ['ban', 'Ban']].map(([v, l]) => h('option', { value: v }, l)));
    const pick = memberPicker(guild);
    const reason = h('textarea', { rows: 2, maxlength: 500, placeholder: 'The member and the mod log are told this' });
    const length = h('input', { type: 'text', placeholder: 'e.g. 10m, 2h, 7d' });
    const lengthRow = f('How long', length, 'Timeouts: up to 28 days. Bans: leave empty to ban for good.');
    const sync = () => { lengthRow.hidden = !['timeout', 'ban'].includes(kind.value); };
    kind.addEventListener('change', sync); sync();
    const go = h('button', { class: 'btn', type: 'button' }, 'Do it');
    go.addEventListener('click', () => {
      const bad = ['kick', 'ban'].includes(kind.value);
      if (bad && go.dataset.sure !== '1') { go.dataset.sure = '1'; go.textContent = `Press again to ${kind.value}`; setTimeout(() => { go.dataset.sure = ''; go.textContent = 'Do it'; }, 5000); return; }
      go.dataset.sure = '';
      if (!pick.id()) { toast('Pick a member first.', true); return; }
      busy(go, async () => {
        const said = await call('staff_action', { guild, kind: kind.value, user: pick.id(), name: pick.name(), reason: reason.value, duration: length.value.trim() || null });
        toast(said); reason.value = ''; pick.clear(); after();
      });
    });
    return h('div', { class: 'card' }, h('h3', {}, 'Take an action'), h('p', { class: 'muted small' }, 'The bot must be running. This is recorded as a case and logged like the command.'),
      h('div', { class: 'grid2' }, f('What to do', kind), f('Member', pick.el)), f('Reason', reason), lengthRow, h('div', { class: 'btns' }, go));
  }
  function pageCases() {
    S.caseType = S.caseType || 'all'; S.caseFind = S.caseFind || ''; S.caseMax = S.caseMax || 50;
    return withServer('Moderation', 'Cases, and warn, time out, kick or ban', async (guild) => {
      const r = await call('cases', { guild, limit: S.caseMax });
      await learn(guild, r.cases.flatMap((c) => [c.targetId, c.modId]));
      const list = h('div', { class: 'list' });
      const types = ['all', ...new Set(r.cases.map((c) => c.type))];
      const paint = () => {
        const q = S.caseFind.toLowerCase();
        const shown = r.cases.filter((c) => (S.caseType === 'all' || c.type === S.caseType) && (!q || `${c.targetTag || ''} ${c.targetId} ${c.reason || ''} ${c.id}`.toLowerCase().includes(q)));
        list.replaceChildren(...(shown.length ? shown.map(caseRow) : [h('p', { class: 'muted' }, r.cases.length ? 'No case matches that.' : 'No cases yet.')]));
      };
      const find = h('input', { type: 'search', placeholder: 'Search by member, reason or number', 'aria-label': 'Search cases', value: S.caseFind, oninput: (e) => { S.caseFind = e.target.value; paint(); } });
      const kind = h('select', { 'aria-label': 'Kind of case', onchange: (e) => { S.caseType = e.target.value; paint(); } }, types.map((t) => h('option', { value: t, selected: t === S.caseType }, t === 'all' ? 'All kinds' : CASE_WORDS[t] || t)));
      paint();
      return [actionForm(guild, () => draw()), h('div', { class: 'card' }, h('div', { class: 'tools' }, find, kind), list,
        r.total > r.cases.length ? h('div', { class: 'btns' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.caseMax += 100; draw(); } }, `Show more (${r.cases.length} of ${r.total})`)) : h('p', { class: 'muted small' }, `${r.total} in all.`))];
    });
  }


  const CLOSED = { staff: 'Closed by staff', opener: 'Closed by the member', idle: 'Closed for being quiet' };
  const span = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };
  /** Saves a ticket's transcript as a file: the styled page (the same one Good Boy 3 made), or plain text. */
  async function saveTranscript(guild, t, html) {
    const r = await call('ticket_transcript', { guild, number: t.number, html });
    const url = URL.createObjectURL(new Blob([r.content], { type: html ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' }));
    const a = h('a', { href: url, download: r.file });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function pageTickets() {
    S.tkShow = S.tkShow || 'all';
    return withServer('Tickets', 'Who opened each ticket, who it is about, how urgent it is, and which moderator has it', async (guild) => {
      let r = await call('tickets', { guild, limit: 200, find: S.tkFind || undefined });
      const slot = h('div', { class: 'stack' });
      const list = h('div', { class: 'list' });
      const SEV = { urgent: 'pill bad', high: 'pill warn', normal: 'pill', low: 'pill good' };
      const name = (p) => (p && p.name) || null;
      const sevPill = (t) => h('span', { class: SEV[t.severity.id] || 'pill', title: 'How urgent' }, t.severity.label.replace(/^\S+\s/, ''));
      const status = (t) => [t.open ? 'Open' : CLOSED[t.kind] || 'Closed', t.open ? (t.claimed_by ? `claimed by ${name(t.claimed_by)}` : 'not claimed') : t.closed_by ? `closed by ${name(t.closed_by)}` : null, t.first_response_ms != null ? `first reply after ${span(t.first_response_ms)}` : 'no reply yet'].filter(Boolean).join(' · ');
      const reload = async () => { r = await call('tickets', { guild, limit: 200, find: S.tkFind || undefined }); paint(); };
      const act = (t, what, text) => call('ticket_action', { guild, number: t.number, what, text: text || '' });
      // one ticket: everything about it, the conversation, and a box to answer from here
      const detail = async (n) => {
        const box = h('div', { class: 'stack' });
        const draw = async () => {
          let v; try { v = await call('ticket_view', { guild, number: n }); } catch (e) { box.replaceChildren(h('p', { class: 'msg bad' }, e.message || String(e))); return; }
          const t = v.ticket;
          const mine = h('textarea', { rows: 3, maxlength: 1500, placeholder: t.open ? 'Write to them. It is sent in the ticket under your name and they are pinged.' : 'This ticket is closed.', disabled: t.open ? null : true });
          const send = h('button', { class: 'btn', type: 'button', disabled: t.open ? null : true }, 'Send');
          send.addEventListener('click', () => busy(send, async () => { await act(t, 'reply', mine.value); mine.value = ''; toast('Sent.'); await draw(); }));
          const chat = h('div', { class: 'chat' }, v.messages.length ? v.messages.map((m) => h('div', { class: 'msgrow' + (m.bot ? ' bot' : '') + (m.deleted ? ' gone' : '') },
            h('div', { class: 'msghead' }, h('b', {}, m.author.name || 'Someone'), m.bot ? h('span', { class: 'pill' }, 'bot') : null, h('span', { class: 'muted small' }, when(m.at)), m.deleted ? h('span', { class: 'muted small' }, 'deleted') : null),
            h('div', { class: 'msgtext' }, m.text || (m.files.length ? '' : '…')), m.files.length ? h('div', { class: 'muted small' }, `Files: ${m.files.join(', ')}`) : null)) : [h('p', { class: 'muted' }, 'Nothing has been said in this ticket yet (or the bot was not running to keep it).')]);
          box.replaceChildren(
            h('button', { class: 'btn quiet', type: 'button', onclick: async () => { slot.replaceChildren(); await reload(); } }, '‹ All tickets'),
            h('div', { class: 'card' },
              h('div', { class: 'row' }, h('h2', {}, `#${t.number} · ${t.category_label || t.category}`), h('div', { class: 'btns' }, sevPill(t), h('span', { class: 'pill' }, t.open ? 'Open' : CLOSED[t.kind] || 'Closed'), h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.currentTarget, () => saveTranscript(guild, t, true)) }, 'Save transcript'), h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.currentTarget, () => saveTranscript(guild, t, false)) }, 'As text'))),
              h('div', { class: 'facts' },
                h('div', {}, h('span', { class: 'muted small' }, 'Opened by'), h('b', {}, name(t.opener) || '—')),
                h('div', {}, h('span', { class: 'muted small' }, 'About'), h('b', {}, name(t.about) || 'Nobody in particular')),
                h('div', {}, h('span', { class: 'muted small' }, 'How urgent'), h('b', {}, t.severity.label)),
                h('div', {}, h('span', { class: 'muted small' }, t.open ? 'Moderator' : 'Handled by'), h('b', {}, name(t.claimed_by) || (t.open ? 'Nobody yet' : name(t.closed_by) || '—'))),
                h('div', {}, h('span', { class: 'muted small' }, 'Opened'), h('b', {}, when(t.opened_at)))),
              t.open ? h('div', { class: 'btns' },
                h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { toast(await act(t, 'claim')); await draw(); }) }, t.claimed_by ? 'Release it' : 'Claim it'),
                h('button', { class: 'btn quiet', type: 'button', onclick: () => closeAsk(t, draw) }, 'Close')) : (t.resolution ? h('p', { class: 'note' }, `How it ended: ${t.resolution}`) : null)),
            h('div', { class: 'card' }, h('h3', {}, 'The conversation'), chat, h('div', { class: 'field' }, h('label', {}, 'Your reply'), mine), h('div', { class: 'btns' }, send)));
          const el = chat; el.scrollTop = el.scrollHeight;
        };
        slot.replaceChildren(box);
        await draw();
        whileShown(box, 5000, async () => { if (box.querySelector('textarea:focus')) return; await draw(); });
      };
      // closing asks how it ended (kept in the staff log)
      const closeAsk = (t, then) => {
        const input = h('textarea', { rows: 2, maxlength: 1500, placeholder: 'How it was resolved (kept in the staff log)' });
        const go = h('button', { class: 'btn', type: 'button' }, 'Close the ticket');
        go.addEventListener('click', () => busy(go, async () => { toast(await act(t, 'close', input.value)); (then || reload)(); }));
        const card = h('div', { class: 'card' }, h('h3', {}, `Close ticket #${t.number}`), input, h('div', { class: 'btns' }, go, h('button', { class: 'btn quiet', type: 'button', onclick: () => card.remove() }, 'Cancel')));
        (slot.firstChild || slot).append(card);
        if (!slot.firstChild) slot.replaceChildren(card);
        input.focus();
      };
      const paint = () => {
        const shown = r.tickets.filter((t) => S.tkShow === 'all' || (S.tkShow === 'open') === t.open);
        list.replaceChildren(...(shown.length ? shown.map((t) => h('div', { class: 'case tk' },
          h('span', { class: `dot ${t.open ? 'on' : ''}` }),
          h('div', { class: 'text' },
            h('div', { class: 'tkhead' }, h('b', {}, `#${t.number} · ${t.category_label || t.category}`), sevPill(t)),
            h('p', { class: 'small' }, h('span', { class: 'muted' }, 'Opened by '), name(t.opener) || '—', t.about ? [h('span', { class: 'muted' }, ' · About '), h('b', {}, name(t.about))] : null),
            h('p', { class: 'muted small' }, status(t))),
          h('div', { class: 'tkside' }, h('span', { class: 'muted small' }, when(t.opened_at)),
            h('div', { class: 'btns' },
              h('button', { class: 'btn quiet', type: 'button', onclick: () => detail(t.number) }, 'Open'),
              t.open ? h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { toast(await act(t, 'claim')); await reload(); }) }, t.claimed_by ? 'Release' : 'Claim') : null,
              t.open ? h('button', { class: 'btn quiet', type: 'button', onclick: () => closeAsk(t) }, 'Close') : null)))) : [h('p', { class: 'muted' }, S.tkFind ? 'No ticket matches that.' : 'No tickets here.')]));
      };
      // search what was said in every ticket (the archive), and the ticket number, the people and the category
      const find = h('input', { type: 'search', placeholder: 'Search every ticket: words anyone said, a number, a name', 'aria-label': 'Search tickets', value: S.tkFind || '', oninput: (e) => { S.tkFind = e.target.value.trim(); clearTimeout(S.tkT); S.tkT = setTimeout(() => reload().catch((er) => toast(er.message || String(er), true)), 300); } });
      const seg = h('div', { class: 'segs', role: 'group', 'aria-label': 'Show' }, [['all', 'All'], ['open', 'Open'], ['closed', 'Closed']].map(([k, l]) => h('button', { class: 'seg', type: 'button', 'aria-pressed': String(S.tkShow === k), onclick: (e) => { S.tkShow = k; for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); paint(); } }, l)));
      paint();
      return [h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('b', {}, r.open.toLocaleString()), h('span', {}, 'Open now')), h('div', { class: 'stat' }, h('b', {}, r.total.toLocaleString()), h('span', {}, 'In all'))),
        slot, h('div', { class: 'card' }, h('div', { class: 'tools' }, find, seg), list, r.total > r.tickets.length ? h('p', { class: 'muted small' }, `Showing the newest ${r.tickets.length} of ${r.total}.`) : null)];
    });
  }

  // ---- what the bot has just seen, kept up to date while the page is open
  const ACT_KINDS = [['all', 'Everything'], ['command', 'Commands'], ['mod', 'Moderation'], ['member', 'Joins and leaves'], ['ticket', 'Tickets'], ['level', 'Level-ups'], ['giveaway', 'Giveaways'], ['error', 'Problems'], ['music', 'Music']];
  const ACT_DOT = { mod: 'warn', member: 'on', ticket: 'info', level: 'on', giveaway: 'info', music: 'info', error: 'warn' };
  const ACT_KEPT = 200;
  /** Asks again every few seconds for as long as `el` is on the screen; leaving the page (or redrawing it) ends it. */
  function whileShown(el, every, work) {
    const again = async () => {
      if (!el.isConnected) return;
      try { await work(); } catch { /* the next try may work */ }
      if (el.isConnected) setTimeout(again, every);
    };
    setTimeout(again, every);
  }
  /** Arcade and Fishing, as in Good Boy 3: the games module's settings, split into the two pages. */
  function gamesPage(title, sub, fishing) {
    return withServer(title, sub, async (guild) => {
      const r = await call('settings', { guild, module: 'games' });
      const mine = r.settings.filter((d) => /fish/i.test(`${d.key} ${d.label}`) === fishing);
      const more = h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.open = 'games'; go('servers'); } }, 'Everything else');
      return [h('div', { class: 'card' }, h('p', { class: 'muted' }, fishing ? 'Fishing: /fish in Discord. Places, fish to collect, levels, challenges.' : 'Blackjack, slots, coin flip and the other arcade games: /arcade posts the panel.'),
        mine.length ? h('div', { class: 'settings' }, mine.map((d) => settingRow(guild, 'games', d, r))) : h('p', { class: 'muted' }, 'Nothing to set here.')),
        h('div', { class: 'card row' }, h('div', { class: 'text' }, h('strong', {}, 'Who can play, where it works, and history'), h('p', { class: 'muted small' }, 'These are on the Games module page.')), more)];
    });
  }
  const pageArcade = () => gamesPage('Arcade', 'Games and their limits', false);
  const pageFishing = () => gamesPage('Fishing', 'Places, fish and challenges', true);
  function pageActivity() {
    S.actKind = S.actKind || 'all';
    return withServer('Logs', 'What the bot has just seen', async (guild) => {
      const list = h('div', { class: 'list feed', 'aria-live': 'polite' });
      const empty = h('p', { class: 'muted' });
      const count = h('p', { class: 'muted small' });
      let all = [], last = 0;
      const row = (e) => h('div', { class: 'case', 'data-kind': e.kind, hidden: S.actKind !== 'all' && S.actKind !== e.kind }, h('span', { class: `dot ${ACT_DOT[e.kind] || ''}` }),
        h('div', { class: 'text' }, h('span', {}, e.text)), h('span', { class: 'muted small' }, new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
      // like Good Boy 3's module health: what went wrong lately, from the same feed
      const health = h('div', { class: 'health' });
      const checkHealth = () => {
        const recent = all.filter((e) => e.kind === 'error' && Date.now() - e.at < 10 * 60 * 1000);
        const last = all.filter((e) => e.kind === 'error').pop();
        health.className = `health ${recent.length ? 'bad' : 'good'}`;
        health.replaceChildren(h('b', {}, recent.length ? `${recent.length} problem${recent.length === 1 ? '' : 's'} in the last 10 minutes` : 'No problems in the last 10 minutes'),
          last ? h('span', { class: 'muted small' }, ` · last: ${last.text} (${new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`) : null);
      };
      const sum = () => {
        checkHealth();
        const shown = all.filter((e) => S.actKind === 'all' || e.kind === S.actKind).length;
        empty.hidden = shown > 0;
        empty.textContent = all.length ? 'Nothing of that kind yet.' : S.o.live.phase === 'online' ? 'Nothing yet. Things show up here as they happen.' : 'Nothing yet. Start the bot and things show up here as they happen.';
        count.textContent = all.length ? `Showing the newest ${shown.toLocaleString()}. This list is kept only while Good Boy is open, and never holds what anyone wrote.` : '';
      };
      // only what is new is asked for and added, newest on top; the oldest rows are dropped past the limit
      const load = async () => {
        const r = await call('activity', { guild, sinceId: last });
        if (r.last_id < last) { all = []; list.replaceChildren(); }
        last = r.last_id;
        for (const e of r.entries) { all.push(e); list.prepend(row(e)); }
        while (all.length > ACT_KEPT) { all.shift(); list.lastElementChild?.remove(); }
        sum();
      };
      const kind = h('select', { 'aria-label': 'Kind of activity', onchange: (e) => { S.actKind = e.target.value; for (const el of list.children) el.hidden = S.actKind !== 'all' && el.dataset.kind !== S.actKind; sum(); } },
        ACT_KINDS.map(([k, l]) => h('option', { value: k, selected: k === S.actKind }, l)));
      await load();
      whileShown(list, 3000, load);
      return [h('div', { class: 'card' }, health, h('div', { class: 'tools' }, kind, h('span', { class: 'live muted small' }, h('span', { class: 'dot on' }), 'Updates by itself')), empty, list, count)];
    });
  }


  // ---- Music: the page from Good Boy 3.1 (a library on the left, the player bar along the bottom)
  function pageMusic() {
    return withServer('Music', 'Play songs, keep playlists and control the player', async (guild) => {
      const root = h('div', { class: 'gbm-wrap' });
      // the page asks the way Good Boy 3's dashboard did; each request goes to the program by name
      const api = async (path, body) => {
        const m = /\/modules\/music\/(actions|views)\/([a-z]+)(?:\?(.*))?$/.exec(path);
        if (!m) throw new Error('The music page asked for something unknown.');
        const args = m[1] === 'views' ? Object.fromEntries(new URLSearchParams(m[3] || '')) : (body || {});
        return call('music_api', { guild, kind: m[1] === 'views' ? 'view' : 'action', name: m[2], args });
      };
      queueMicrotask(() => window.GBMusic.mount(root, { gid: guild, admin: true, api, toast, openSettings: () => { S.open = 'music'; go('servers'); } }));
      // live: ask again every few seconds so the bar and queue follow what happens in Discord
      whileShown(root, 4000, async () => { if (root.querySelector('input:focus, textarea:focus')) return; window.GBMusic.refresh(); });
      return [root];
    });
  }


  // ---- Inactive members: find the quiet ones, keep the ones that matter, remove the rest in one go
  const WHY = { never: 'Never sent a message', quiet: 'Gone quiet', unverified: 'Never got past verification' };
  function pageInactive() {
    S.inShow = S.inShow || 'all'; S.inFind = S.inFind || ''; S.inPick = S.inPick || new Set();
    return withServer('Inactive members', 'Find who has gone quiet and clean up in a few clicks', async (guild) => {
      const box = h('div', { class: 'stack big' });
      let v = await call('inactive_view', { guild });
      await learn(guild, v.keeps.map((k) => k.id));
      const reload = async () => { v = await call('inactive_view', { guild }); await learn(guild, v.keeps.map((k) => k.id)); paint(); };
      const rule = (label, value) => h('span', { class: 'chip' }, h('b', {}, value), ' ', label);
      const days = h('input', { type: 'number', min: 7, max: 365, value: S.inDays || v.rules.days || 30, 'aria-label': 'Days without activity' });
      const scan = h('button', { class: 'btn', type: 'button' }, v.snapshot ? 'Scan again' : 'Scan the server');
      scan.addEventListener('click', () => busy(scan, async () => {
        S.inDays = Number(days.value) || null; S.inPick = new Set();
        const before = v.snapshot ? v.snapshot.at : 0;
        await call('inactive_scan', { guild, days: S.inDays });
        // the member list comes from Discord, so the answer arrives a moment later
        for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1500)); await reload(); if (v.snapshot && v.snapshot.at !== before) break; }
        toast(v.snapshot && v.snapshot.at !== before ? 'Scan finished.' : 'Discord is taking a while. Press the button again in a minute.', !(v.snapshot && v.snapshot.at !== before));
      }));
      const rows = () => {
        const snap = v.snapshot; if (!snap) return [];
        const q = S.inFind.toLowerCase();
        return snap.rows.filter((r) => (S.inShow === 'all' || (S.inShow === 'never' && r.why === 'never') || (S.inShow === 'once' && r.why === 'quiet') || (S.inShow === 'unverified' && r.why === 'unverified')) && (!q || `${r.name} ${r.id}`.toLowerCase().includes(q)));
      };
      const csv = (list) => ['id,name,why,last_active,total_messages,joined,can_kick', ...list.map((r) => [r.id, `"${String(r.name).replace(/"/g, '""')}"`, r.why, r.last || '', r.total, r.joined ? new Date(r.joined).toISOString().slice(0, 10) : '', r.kickable].join(','))].join('\n');
      function paint() {
        const snap = v.snapshot, list = rows();
        const picked = list.filter((r) => S.inPick.has(r.id) && r.kickable);
        const t = snap ? snap.tiers : null;
        const tile = (n, l) => h('div', { class: 'stat' }, h('b', {}, Number(n).toLocaleString()), h('span', {}, l));
        const tabs = h('div', { class: 'segs', role: 'group', 'aria-label': 'Show' }, [['all', 'Everyone'], ['never', 'Never spoke'], ['once', 'Went quiet'], ['unverified', 'Unverified']].map(([k, l]) => h('button', { class: 'seg', type: 'button', 'aria-pressed': String(S.inShow === k), onclick: () => { S.inShow = k; paint(); } }, l)));
        const kick = h('button', { class: 'btn danger', type: 'button', disabled: picked.length === 0 }, picked.length ? `Remove ${picked.length} selected` : 'Remove selected');
        kick.addEventListener('click', () => {
          if (kick.dataset.sure !== '1') { kick.dataset.sure = '1'; kick.textContent = `Press again to remove ${picked.length}`; setTimeout(() => { kick.dataset.sure = ''; kick.textContent = picked.length ? `Remove ${picked.length} selected` : 'Remove selected'; }, 5000); return; }
          busy(kick, async () => { const n = await call('inactive_kick', { guild, ids: picked.map((r) => r.id), days: snap.days }); toast(`Removing ${n} members. They can rejoin with an invite.`); S.inPick = new Set(); setTimeout(reload, 4000); });
        });
        box.replaceChildren(
          h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'text' }, h('h3', {}, 'Rules in force'), h('p', { class: 'muted small' }, 'Staff, bots, kept members and people who joined recently are never listed.')),
            h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.open = 'stats'; go('servers'); } }, 'Change the rules')),
            h('div', { class: 'chips' }, rule('days quiet', v.rules.days), v.rules.ghostDays ? rule('days for people who never spoke', v.rules.ghostDays) : null, v.rules.protectMessages ? rule(`messages protect a veteran (wait ${v.rules.days * 2} days)`, v.rules.protectMessages) : null,
              v.rules.unverifiedDays ? rule('days behind the verification gate', v.rules.unverifiedDays) : null, rule('we-miss-you message', v.rules.warn ? 'on' : 'off'), rule('removal by itself', v.rules.auto === 'kick' ? `on, up to ${v.rules.autoMax}` : 'off'))),
          h('div', { class: 'card' }, h('div', { class: 'tools' }, h('label', { class: 'muted' }, 'Quiet for '), days, h('span', { class: 'muted' }, 'days'), scan),
            snap ? h('p', { class: 'muted small' }, `Last scan ${when(snap.at)} · looking back ${snap.days} days${snap.short ? ` · ⚠ activity has only been tracked for ${snap.covered} days, so "never spoke" may just mean before tracking began` : ''}`) : h('p', { class: 'muted' }, 'Nothing scanned yet. The bot must be running, because the member list comes from Discord.')),
          t ? h('div', { class: 'stats' }, tile(t.all, 'Listed'), tile(t.d60, 'Quiet 60+ days'), tile(t.d90, 'Quiet 90+ days'), tile(t.never, 'Never sent a message'), t.unverified ? tile(t.unverified, 'Still unverified') : null) : null,
          snap ? h('div', { class: 'card' },
            h('div', { class: 'tools' }, h('input', { type: 'search', placeholder: 'Search by name or ID', 'aria-label': 'Search', value: S.inFind, oninput: (e) => { S.inFind = e.target.value; clearTimeout(S.inT); S.inT = setTimeout(paint, 200); } }), tabs),
            h('div', { class: 'btns' },
              h('button', { class: 'btn quiet', type: 'button', onclick: () => { for (const r of list) if (r.kickable) S.inPick.add(r.id); paint(); } }, `Select all ${list.filter((r) => r.kickable).length}`),
              h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.inPick = new Set(); paint(); } }, 'Clear'),
              h('button', { class: 'btn quiet', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(csv(list)); toast('Copied. Paste it into a spreadsheet.'); } catch { toast('Copying is not allowed here.', true); } } }, 'Copy as spreadsheet'), h('span', { class: 'grow' }), kick),
            list.length ? h('div', { class: 'list' }, list.slice(0, 300).map((r) => h('div', { class: 'case' },
              h('input', { type: 'checkbox', 'aria-label': `Select ${r.name}`, checked: S.inPick.has(r.id), disabled: !r.kickable, onchange: (e) => { if (e.target.checked) S.inPick.add(r.id); else S.inPick.delete(r.id); paint(); } }),
              h('div', { class: 'text' }, h('b', {}, r.name || `Member ${String(r.id).slice(-4)}`), h('p', { class: 'muted small' }, [WHY[r.why], r.last ? `last active ${r.last}` : 'no activity on record', r.total ? `${r.total.toLocaleString()} messages` : null, r.joined ? `joined ${new Date(r.joined).toLocaleDateString()}` : null, r.kickable ? null : "can't be removed by the bot"].filter(Boolean).join(' · '))),
              h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await call('inactive_keep', { guild, user: r.id, keep: true }); toast(`${r.name} will never be listed.`); snap.rows = snap.rows.filter((x) => x.id !== r.id); await reload(); }) }, 'Keep')))) : h('p', { class: 'muted' }, 'Nobody matches. Nothing to clean up.'),
            list.length > 300 ? h('p', { class: 'muted small' }, `Showing the first 300 of ${list.length.toLocaleString()}. Use the search or the filters to narrow it down.`) : null) : null,
          (() => {
            const pick = memberPicker(guild);
            const add = h('button', { class: 'btn', type: 'button' }, 'Keep them');
            add.addEventListener('click', () => busy(add, async () => { if (!pick.id()) throw new Error('Pick a member first.'); const name = pick.name(); await call('inactive_keep', { guild, user: pick.id(), keep: true }); toast(`${name} will never be listed.`); pick.clear(); await reload(); }));
            return h('div', { class: 'card' }, h('h3', {}, v.keeps.length ? `Kept members (${v.keeps.length})` : 'Kept members'), h('p', { class: 'muted small' }, 'These are never listed as inactive.'),
              h('div', { class: 'tools' }, pick.el, add),
              v.keeps.length ? h('div', { class: 'list' }, v.keeps.map((k) => h('div', {}, h('span', {}, who(k.id)), h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await call('inactive_keep', { guild, user: k.id, keep: false }); await reload(); }) }, 'Stop keeping')))) : null);
          })(),
          v.log.length ? h('div', { class: 'card' }, h('h3', {}, 'Who was removed'), h('div', { class: 'list' }, v.log.map((e) => h('div', { class: 'case' }, h('div', { class: 'text' }, h('b', {}, `${e.count} member${e.count === 1 ? '' : 's'} · ${({ automatic: 'by itself', launcher: 'from the launcher', command: 'by command' })[e.how] || 'removed'}`),
            h('p', { class: 'muted small' }, (e.members || []).slice(0, 12).map((m) => m.name || m.id).join(', ') + ((e.members || []).length > 12 ? '…' : ''))), h('span', { class: 'muted small' }, when(e.at)))))) : null);
      }
      paint();
      return [box];
    });
  }


  // ---- AutoMod: every rule on one page (spam, scam links, words, links, mentions, repeats, capitals, emoji)
  /** AutoMod, one card per rule in plain words: what it does, a switch, what happens, and the numbers to fine-tune. */
  const AUTOMOD_RULES = [
    { id: 'scams', title: 'Scam and phishing links', icon: '🎣', about: 'Removes links that look like scams: fake giveaways, fake Discord and Steam pages, stolen-account links.', on: 'automodScams', action: 'scamsAction', tune: [] },
    { id: 'spam', title: 'Spam', icon: '💬', about: 'Stops someone flooding the chat with a lot of messages in a few seconds.', on: 'automodSpam', action: 'spamAction',
      tune: [['spamMaxMessages', 'Allow this many messages…'], ['spamWindowSeconds', '…within this many seconds']] },
    { id: 'words', title: 'Banned words', icon: '🚫', about: 'Removes messages with words or phrases you list. Type a word and press Enter; paste a whole list and it is split up for you.', on: 'automodWords', action: 'wordsAction',
      tune: [['bannedWords', 'Words and phrases to remove']], open: true },
    { id: 'links', title: 'Links and invites', icon: '🔗', about: 'Removes links and Discord invites, except to the websites you allow.', on: 'automodLinks', action: 'linksAction',
      tune: [['allowedDomains', 'Websites people may link to']] },
    { id: 'mentions', title: 'Mass mentions', icon: '📣', about: 'Removes messages that ping a lot of people at once.', on: null, action: 'mentionsAction',
      tune: [['maxMentions', 'Most people one message may mention (0 turns this rule off)']] },
    { id: 'repeat', title: 'Repeated messages', icon: '🔁', about: 'Stops someone sending the same message again and again.', on: 'automodRepeat', action: 'repeatAction',
      tune: [['repeatMax', 'Allow the same message this many times…'], ['repeatWindowSeconds', '…within this many seconds']] },
    { id: 'caps', title: 'SHOUTING (capital letters)', icon: '🔠', about: 'Removes messages that are mostly capital letters.', on: 'automodCaps', action: 'capsAction',
      tune: [['capsPercent', 'Remove when this much of the message is capitals (%)'], ['capsMinLetters', 'Ignore short messages (fewer letters than this)']] },
    { id: 'emoji', title: 'Too many emoji', icon: '😀', about: 'Removes messages stuffed with emoji.', on: 'automodEmoji', action: 'emojiAction',
      tune: [['emojiMax', 'Most emoji allowed in one message']] },
  ];
  function pageAutomod() {
    return withServer('AutoMod', 'Rules that act on messages by themselves', async (guild) => {
      const r = await call('settings', { guild, module: 'moderation' });
      const by = Object.fromEntries(r.settings.map((d) => [d.key, d]));
      const servers = await call('servers');
      const m = (servers.find((x) => x.id === guild) || { modules: [] }).modules.find((x) => x.id === 'moderation');
      const row = (key, label) => by[key] ? settingRow(guild, 'moderation', { ...by[key], label }, r) : null;
      const active = (rule) => (rule.on ? !!(by[rule.on] || {}).value : Number((by.maxMentions || {}).value) > 0);
      const stat = h('div', { class: 'stats' });
      const tally = () => { const n = AUTOMOD_RULES.filter(active).length; stat.replaceChildren(h('div', { class: 'stat' }, h('b', {}, `${n} of ${AUTOMOD_RULES.length}`), h('span', {}, 'Rules switched on'))); };
      tally();
      const card = (rule) => {
        const sw = rule.on ? row(rule.on, 'Switch this rule on') : null;
        if (sw) sw.querySelector('input').addEventListener('change', () => setTimeout(tally, 400));
        return h('div', { class: 'card rule' },
          h('div', { class: 'rulehead' }, h('span', { class: 'ruleicon', 'aria-hidden': 'true' }, rule.icon), h('div', { class: 'grow' }, h('h3', {}, rule.title), h('p', { class: 'muted' }, rule.about))),
          sw,
          rule.action ? row(rule.action, 'When someone breaks this rule') : null,
          rule.tune.length ? h('details', { class: 'group', open: !!rule.open }, h('summary', {}, h('span', {}, 'Fine-tune'), h('span', { class: 'small muted' }, 'numbers and lists')), h('div', { class: 'settings' }, rule.tune.map(([k, l]) => row(k, l)))) : null);
      };
      return [
        m && !m.on ? h('div', { class: 'card note' }, 'Moderation is off in this server, so AutoMod does nothing yet. Turn it on in Modules.') : null,
        stat,
        h('div', { class: 'card' }, h('h2', {}, 'The usual response'),
          h('p', { class: 'muted' }, 'What AutoMod does when a rule catches something and the rule has no answer of its own below. Staff, bots and exempt roles are never caught. Every catch is recorded as a case.'),
          h('div', { class: 'settings' }, row('automodAction', 'Usually, when a rule catches something'), row('automodTimeoutMinutes', 'If it times someone out, for how many minutes'), row('automodKeepSnippets', 'Keep a short preview of what was removed (so staff can see why)'))),
        ...AUTOMOD_RULES.map(card),
        whereCard({ id: guild }, { id: 'moderation', name: 'AutoMod' }, r),
      ];
    });
  }


  // ---- Economy: the treasury, taxes and the second currency
  const KIND_WORDS = { 'tax:pay': 'Tax on payments', 'tax:income': 'Tax on daily and work', 'tax:withdraw': 'Bank withdrawal fees', 'tax:winnings': 'Tax on game winnings', shop: 'Shop sales', 'fee:exchange': 'Exchange fees', grant: 'Paid out', donation: 'Gifts from members', staff: 'Added by staff' };
  function pageEconomy() {
    return withServer('Economy', 'The treasury, taxes and the second currency', async (guild) => {
      const box = h('div', { class: 'stack big' });
      let v = await call('economy', { guild });
      const know = () => learn(guild, [...v.log.map((e) => e.user), ...v.top_gems.map((g) => g.user)]);
      await know();
      const reload = async () => { v = await call('economy', { guild }); await know(); paint(); };
      const n = (x) => Number(x || 0).toLocaleString();
      const coin = (x) => `${n(x)} ${v.rates.currencyEmoji || ''}`.trim();
      const save = async (key, value, el) => { try { await call('setting_set', { guild, module: 'economy', key, value }); v.rates[key] = value; toast('Saved'); } catch (e) { toast(e.message, true); if (el) el.value = v.rates[key]; } };
      const num = (key, label, hint, max = 50) => h('div', { class: 'field' }, h('label', {}, label), h('input', { type: 'number', min: 0, max, value: v.rates[key] ?? 0, onchange: (e) => save(key, Number(e.target.value), e.target) }), hint ? h('p', { class: 'muted small' }, hint) : null);
      const toggle = (key, label) => h('label', { class: 'setting inline' }, h('span', {}, label), h('input', { type: 'checkbox', class: 'toggle', role: 'switch', checked: !!v.rates[key], onchange: (e) => { save(key, e.target.checked).then(reload); } }));
      function give() {
        const pick = memberPicker(guild);
        const amount = h('input', { type: 'text', placeholder: 'e.g. 500' });
        const reason = h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. Event winner' });
        const go = h('button', { class: 'btn', type: 'button' }, 'Pay out');
        go.addEventListener('click', () => busy(go, async () => {
          if (!pick.id()) throw new Error('Pick a member first.');
          const left = await call('treasury_give', { guild, user: pick.id(), amount: Number(String(amount.value).replace(/[, ]/g, '')) || 0, reason: reason.value });
          toast(`Paid out. The treasury has ${n(left)} left.`); pick.clear(); amount.value = ''; reason.value = ''; await reload();
        }));
        const f = (l, el) => h('div', { class: 'field' }, h('label', {}, l), el);
        return h('div', { class: 'card' }, h('h3', {}, 'Pay out from the treasury'), h('p', { class: 'muted small' }, 'Prizes, event rewards, refunds. The reason is kept in the record. It never pays more than it has.'),
          h('div', { class: 'grid2' }, f('Member', pick.el), f('Amount', amount)), f('Reason', reason), h('div', { class: 'btns' }, go));
      }
      function addCoins() {
        const amount = h('input', { type: 'text', placeholder: 'e.g. 50000' });
        const note = h('input', { type: 'text', maxlength: 100, placeholder: 'What it is for (optional)' });
        const go = h('button', { class: 'btn', type: 'button' }, 'Add to the treasury');
        go.addEventListener('click', () => busy(go, async () => {
          const total = await call('treasury_add', { guild, amount: Number(String(amount.value).replace(/[, ]/g, '')) || 0, note: note.value });
          toast(`Added. The treasury has ${n(total)}.`); amount.value = ''; note.value = ''; await reload();
        }));
        const f = (l, el) => h('div', { class: 'field' }, h('label', {}, l), el);
        return h('div', { class: 'card' }, h('h3', {}, 'Add coins to the treasury'), h('p', { class: 'muted small' }, 'Puts new coins in the treasury, for prizes and rewards you pay out later. It shows in the record as added by staff.'),
          h('div', { class: 'grid2' }, f('Amount', amount), f('Note', note)), h('div', { class: 'btns' }, go));
      }
      function paint() {
        const t = v.treasury;
        const kinds = (rows) => rows.length ? h('div', { class: 'list' }, rows.map(([k, x]) => h('div', {}, h('span', {}, KIND_WORDS[k] || k), h('b', {}, `${x < 0 ? '−' : '+'}${n(Math.abs(x))}`)))) : h('p', { class: 'muted' }, 'Nothing yet.');
        box.replaceChildren(
          !v.on ? h('div', { class: 'card note' }, 'Money is off in this server. Turn it on in Modules to use any of this.') : null,
          h('div', { class: 'stats' },
            h('div', { class: 'stat' }, h('b', {}, n(t.balance)), h('span', {}, 'In the treasury')), h('div', { class: 'stat' }, h('b', {}, n(t.collected)), h('span', {}, 'Collected in all')),
            h('div', { class: 'stat' }, h('b', {}, n(t.paid_out)), h('span', {}, 'Paid out')), h('div', { class: 'stat' }, h('b', {}, n(v.wallets)), h('span', {}, 'Wallets'))),
          h('div', { class: 'two' }, h('div', { class: 'card' }, h('h3', {}, 'Last 7 days'), kinds(v.week)), h('div', { class: 'card' }, h('h3', {}, 'Last 30 days'), kinds(v.month))),
          h('div', { class: 'card' }, h('h3', {}, 'Taxes'), h('p', { class: 'muted small' }, 'All start at 0, so nothing changes until you choose. Taxes come off what members earn or move and go to the treasury.'),
            h('div', { class: 'grid2' }, num('taxPay', 'Payments between members (%)', 'Comes off what the receiver gets'), num('taxIncome', 'Daily and work rewards (%)'), num('taxWithdraw', 'Bank withdrawals (%)'), num('taxWinnings', 'Game winnings (%)', 'Only on the profit, never the stake')),
            toggle('shopToTreasury', 'Shop sales go to the treasury (otherwise the coins disappear)')),
          h('div', { class: 'card' }, h('h3', {}, 'Second currency'), h('p', { class: 'muted small' }, 'Members swap coins for it with /exchange. Staff can hand it out with the wallet form.'),
            toggle('gemsEnabled', 'Turn the second currency on'),
            v.rates.gemsEnabled ? h('div', { class: 'grid2' }, num('exchangeRate', `${v.rates.currencyName || 'Coins'} for one ${v.rates.gemName || 'gem'}`, null, 1000000), num('exchangeFee', 'Exchange fee, either way (%)', 'Goes to the treasury')) : null,
            v.rates.gemsEnabled && v.top_gems.length ? h('div', { class: 'list' }, v.top_gems.map((g, i) => h('div', {}, h('span', {}, `${i + 1}. ${who(g.user)}`), h('b', {}, `${n(g.gems)} ${v.rates.gemEmoji || ''}`)))) : null,
            h('p', { class: 'muted small' }, 'The name and emoji are in Modules > Money > Settings.')),
          addCoins(), give(),
          h('div', { class: 'card' }, h('h3', {}, 'Record'), v.log.length ? h('div', { class: 'list' }, v.log.map((e) => h('div', { class: 'case' }, h('div', { class: 'text' }, h('b', {}, `${e.delta < 0 ? '−' : '+'}${n(Math.abs(e.delta))} · ${KIND_WORDS[e.kind] || e.kind}`), h('p', { class: 'muted small' }, [e.user ? who(e.user) : null, e.note].filter(Boolean).join(' · ') || ' ')), h('span', { class: 'muted small' }, when(e.at))))) : h('p', { class: 'muted' }, 'No taxes or fees collected yet.')));
      }
      paint();
      return [box];
    });
  }


  // ---- Leavers: who left, how, and whether anything stood out (kept for a while, then forgotten)
  const HOW = { left: 'Left', kicked: 'Kicked', banned: 'Banned' };
  function pageLeavers() {
    S.lvDays = S.lvDays || 30; S.lvFind = S.lvFind || ''; S.lvHow = S.lvHow || 'all'; S.lvFlag = !!S.lvFlag;
    return withServer('Leavers', 'Who left, how, and anything that stood out', async (guild) => {
      const box = h('div', { class: 'stack big' });
      let r = await call('leavers', { guild, days: S.lvDays, q: S.lvFind });
      await learn(guild, r.leavers.map((l) => l.by));
      const fetchAgain = async () => { r = await call('leavers', { guild, days: S.lvDays, q: S.lvFind }); await learn(guild, r.leavers.map((l) => l.by)); paint(); };
      const span = (ms) => { const d = Math.floor(ms / 864e5); return d < 1 ? 'under a day' : d === 1 ? '1 day' : d < 60 ? `${d} days` : `${Math.round(d / 30)} months`; };
      const roles = (ids) => ids.map((i) => r.roles[i]).filter(Boolean);
      function paint() {
        if (!r.keeps) { box.replaceChildren(h('div', { class: 'card note' }, 'Leave records are switched off in this server. Turn them on in Modules > Moderation > Settings > Who leaves.')); return; }
        const all = r.leavers;
        const shown = all.filter((l) => (S.lvHow === 'all' || l.how === S.lvHow) && (!S.lvFlag || l.flags.length));
        const tile = (n, l) => h('div', { class: 'stat' }, h('b', {}, n.toLocaleString()), h('span', {}, l));
        const days = h('div', { class: 'segs', role: 'group', 'aria-label': 'How far back' }, [7, 30, r.days].filter((d, i, a) => a.indexOf(d) === i && d <= r.days).map((d) => h('button', { class: 'seg', type: 'button', 'aria-pressed': String(S.lvDays === d), onclick: () => { S.lvDays = d; fetchAgain(); } }, `${d} days`)));
        const how = h('div', { class: 'segs', role: 'group', 'aria-label': 'How they went' }, [['all', 'Everyone'], ['left', 'Left'], ['kicked', 'Kicked'], ['banned', 'Banned']].map(([k, l]) => h('button', { class: 'seg', type: 'button', 'aria-pressed': String(S.lvHow === k), onclick: () => { S.lvHow = k; paint(); } }, l)));
        box.replaceChildren(
          h('div', { class: 'stats' }, tile(all.length, `In the last ${S.lvDays} days`), tile(all.filter((l) => l.flags.length).length, 'Something stood out'), tile(all.filter((l) => l.how !== 'left').length, 'Kicked or banned'), tile(all.filter((l) => l.returned_at).length, 'Came back')),
          h('div', { class: 'card' },
            h('div', { class: 'tools' }, h('input', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search', value: S.lvFind, oninput: (e) => { S.lvFind = e.target.value; clearTimeout(S.lvT); S.lvT = setTimeout(fetchAgain, 250); } }), days),
            h('div', { class: 'tools' }, how, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.lvFlag, onchange: (e) => { S.lvFlag = e.target.checked; paint(); } }), ' Only ones that stood out')),
            shown.length ? h('div', { class: 'list' }, shown.map((l) => h('div', { class: 'case leaver' },
              l.avatar ? h('img', { src: l.avatar, alt: '', width: 36, height: 36, class: 'lvface', referrerpolicy: 'no-referrer' }) : h('span', { class: 'pickdot big' }, (l.name || '?').slice(0, 1).toUpperCase()),
              h('div', { class: 'text' },
                h('b', {}, l.name, ' ', h('span', { class: `badge ${l.how}` }, HOW[l.how] || l.how), l.returned_at ? h('span', { class: 'badge back' }, 'Came back') : null),
                h('p', { class: 'muted small' }, [`left ${when(l.left_at)}`, l.joined_at ? `was here ${span(l.left_at - l.joined_at)}` : null, roles(l.roles).length ? `roles: ${roles(l.roles).slice(0, 4).join(', ')}` : null, l.strikes ? `${l.strikes} warning${l.strikes === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')),
                l.reason || l.by ? h('p', { class: 'small' }, [l.reason ? `Reason: ${l.reason}` : null, l.by ? `by ${who(l.by)}` : null].filter(Boolean).join(' · ')) : null,
                l.flags.length ? h('div', { class: 'flags' }, l.flags.map((f) => h('span', { class: 'flag' }, f))) : null),
              h('button', { class: 'btn quiet', type: 'button', title: 'Erase everything kept about them', onclick: (e) => { if (e.currentTarget.dataset.sure !== '1') { const b = e.currentTarget; b.dataset.sure = '1'; b.textContent = 'Erase?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Forget'; }, 4000); return; } busy(e.currentTarget, async () => { await call('leaver_forget', { guild, user: l.user }); await fetchAgain(); }); } }, 'Forget'))))
              : h('p', { class: 'muted' }, all.length ? 'Nobody matches.' : 'Nobody has left in this time.'),
            h('p', { class: 'muted small' }, `Records are kept for ${r.days} days, then forgotten. They hold a name, when someone joined and left, their roles and whether anything stood out. Nothing they wrote. Change this in Modules > Moderation > Settings.`)));
      }
      paint();
      return [box];
    });
  }


  // ---- Images: every picture uploaded for the bot, kept in the server's gallery so it is saved and can be used again
  function pageImages() {
    return withServer('Images', 'Pictures saved for the bot, ready to use again', async (guild) => {
      const box = h('div', { class: 'stack big' });
      const draw = async () => {
        const v = await call('gallery_view', { guild });
        const slotName = Object.fromEntries(v.slots);
        const input = h('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'hidden-file', 'aria-label': 'Add pictures', onchange: async () => {
          const files = [...input.files]; input.value = '';
          let ok = 0; const bad = [];
          for (const f of files) { try { const pic = await readPicture(f); await call('gallery_add', { guild, name: pic.name, data: pic.data }); ok++; } catch (e) { bad.push(`${f.name}: ${e.message || e}`); } }
          if (ok) toast(ok === 1 ? 'Picture saved to the gallery.' : `${ok} pictures saved to the gallery.`);
          if (bad.length) toast(bad.join(' · '), true);
          await draw();
        } });
        const add = h('div', { class: 'row' }, h('div', {}, h('b', {}, `${v.pictures.length} of ${v.max} pictures`), h('p', { class: 'muted small' }, 'PNG, JPG, GIF or WebP, each under 8 MB. Pick as many as you like.')),
          h('div', { class: 'btns' }, input, h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, 'Add pictures')));
        const using = v.slots.map(([id, label]) => [label, v.pictures.find((p) => p.uses.includes(id))]);
        const where = h('div', { class: 'card' }, h('h3', {}, 'Where pictures are used'), h('div', { class: 'list' }, using.map(([label, p]) => h('div', {}, h('span', {}, label), h('span', { class: 'muted' }, p ? p.name : 'Nothing yet')))),
          h('p', { class: 'muted small' }, 'Pick a picture below and choose where to use it. Welcome and goodbye pictures can also be designed on the Welcome module page. Characters have their own pictures on the Critters page.'));
        const tile = (p) => {
          const menu = h('select', { 'aria-label': `Use ${p.name} for`, onchange: async (e) => {
            const slot = e.target.value; e.target.value = '';
            if (!slot) return;
            try { await call('gallery_use', { guild, id: p.id, slot }); toast(`${p.name} is now the ${slotName[slot].toLowerCase()}.`); await draw(); } catch (er) { toast(er.message || String(er), true); }
          } }, h('option', { value: '' }, 'Use for…'), v.slots.map(([id, label]) => h('option', { value: id }, label)));
          return h('div', { class: 'gtile' },
            p.preview ? h('img', { src: p.preview, alt: p.name, loading: 'lazy' }) : h('div', { class: 'gnone muted' }, 'No preview'),
            h('b', { class: 'gname', title: p.name }, p.name),
            h('span', { class: 'muted small' }, `${p.size >= 1048576 ? (p.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(p.size / 1024)) + ' KB'} · ${when(p.at)}`),
            p.uses.length ? h('div', { class: 'tags' }, p.uses.map((u) => h('span', { class: 'tag' }, slotName[u]))) : null,
            h('div', { class: 'btns' }, menu,
              h('button', { class: 'btn quiet small', type: 'button', onclick: (e) => busy(e.target, async () => {
                const name = prompt('New name for this picture', p.name);
                if (name === null || !name.trim()) return;
                await call('gallery_rename', { guild, id: p.id, name }); await draw();
              }) }, 'Rename'),
              h('button', { class: 'btn quiet small', type: 'button', onclick: (e) => busy(e.target, async () => {
                if (!confirm(`Delete ${p.name} from the gallery? Anywhere it is already in use keeps its own copy.`)) return;
                await call('gallery_remove', { guild, id: p.id }); toast('Picture deleted.'); await draw();
              }) }, 'Delete')));
        };
        box.replaceChildren(h('div', { class: 'card' }, add),
          v.pictures.length ? h('div', { class: 'ggrid' }, [...v.pictures].reverse().map(tile)) : h('div', { class: 'card empty' }, h('h2', {}, 'No pictures yet'), h('p', { class: 'muted' }, 'Add pictures here, or with /images add in Discord. Everything you upload for the bot is kept here.')),
          where);
      };
      await draw();
      return [box];
    });
  }
  // ---- Server setup: build a layout's roles and channels and connect them to the bot, or check a server that is already set up
  function pageSetup() {
    return withServer('Server setup', 'Build the roles and channels a server needs, or tidy the one you have', async (guild) => {
      const box = h('div', { class: 'stack big' });
      const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
      // the work happens in Discord and takes a little while: ask, then look every second or two for the answer
      const run = async (btn, step, what, doneWhen, say) => {
        const before = await call('setup_view', { guild });
        await call('setup_run', { guild, step, what });
        toast(say);
        for (let k = 0; k < 40; k++) {
          await new Promise((r) => setTimeout(r, 1500));
          const v = await call('setup_view', { guild });
          if (doneWhen(v, before)) { await draw(v); return v; }
        }
        toast('Still working. Look again in a moment.', true);
        await draw();
      };
      const sel = { id: null };
      const draw = async (given) => {
        const v = given || await call('setup_view', { guild });
        const scan = v.scan; const last = v.last;
        const check = h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', {}, h('h2', {}, 'Check my server'),
            h('p', { class: 'muted small' }, scan ? `Last checked ${ago(scan.at)}: ${scan.channels} channels, ${scan.roles} roles.` : 'Looks for clutter, risky permissions and channels the bot is not using. Nothing changes until you press a Fix button.')),
          h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, () => run(e.target, 'scan', '', (n, b) => n.scan && (!b.scan || n.scan.at > b.scan.at), 'Checking your server…')) }, scan ? 'Check again' : 'Check now'))),
          scan ? (scan.findings.length ? h('div', { class: 'stack' }, scan.findings.map((f) => h('div', { class: 'finding ' + f.level },
              h('div', {}, h('b', {}, (f.level === 'warn' ? '⚠️ ' : '💡 ') + f.title), h('p', { class: 'muted small' }, f.detail)),
              f.fix ? h('button', { class: 'btn quiet small', type: 'button', onclick: (e) => busy(e.target, async () => {
                const label = (v.fixes.find((x) => x[0] === f.fix) || [])[1] || 'Fix';
                if (!confirm(`${label}?\n\n${f.title}\n${f.detail}`)) return;
                await run(e.target, 'fix', f.fix, (n, b) => n.last && (!b.last || n.last.at > b.last.at), 'Working on it…');
              }) }, (v.fixes.find((x) => x[0] === f.fix) || [])[1] || 'Fix') : null))) : h('p', { class: 'ok' }, '✅ Nothing to tidy. Your channels, roles and bot connections look good.')) : null);
        const pick = (l) => h('button', { type: 'button', class: 'layout' + (sel.id === l.id ? ' on' : ''), 'aria-pressed': String(sel.id === l.id), onclick: () => { sel.id = l.id; draw(v); } },
          h('b', {}, l.name), h('span', { class: 'muted small' }, l.about), h('span', { class: 'muted small' }, `${l.roles.length} roles · ${l.channels} channels`));
        const chosen = v.layouts.find((l) => l.id === sel.id);
        const tree = chosen ? h('div', { class: 'tree' }, chosen.tree.map((c) => h('div', {}, h('b', {}, (c.private ? '🔒 ' : '') + c.name), h('ul', {}, c.channels.map((ch) => h('li', {}, (ch.voice ? '🔊 ' : '# ') + ch.name, ch.private ? ' 🔒' : ch.read_only ? ' (read only)' : ''))))),
          h('p', { class: 'muted small' }, `Roles: ${chosen.roles.join(', ')}. Turns on: ${chosen.modules.join(', ')}. Connects the welcome, log, ticket and suggestion channels, posts the rules and the ticket buttons.`)) : null;
        const build = h('div', { class: 'card' }, h('h2', {}, 'Build a layout'),
          h('p', { class: 'muted small' }, 'Pick one, look at what it adds, then build. It only adds what is missing and never changes or deletes anything you already have. The bot needs Manage Roles and Manage Channels.'),
          h('div', { class: 'layouts' }, v.layouts.map(pick)), tree,
          chosen ? h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, async () => {
            if (!confirm(`Build the ${chosen.name} layout? It adds the roles and channels this server is missing, and connects them to the bot.`)) return;
            await run(e.target, 'build', chosen.id, (n, b) => n.last && (!b.last || n.last.at > b.last.at), 'Building… this takes up to a minute.');
          }) }, `Build the ${chosen.name} layout`)) : h('p', { class: 'muted small' }, 'Pick a layout to see what it would add.'));
        const result = last ? h('div', { class: 'card' }, h('h3', {}, 'Last result'), h('p', {}, last.text), h('p', { class: 'muted small' }, `${last.what === 'build' ? 'Build' : last.what === 'error' ? 'Problem' : 'Fix'} · ${ago(last.at)}`)) : null;
        box.replaceChildren(check, build, result);
      };
      await draw();
      return [box];
    });
  }
  // ---- List pages (giveaways, custom commands, backups, top inviters, counting): what Good Boy 3's dashboard showed
  const LISTS = [['giveaways', 'Giveaways'], ['commands', 'Custom commands'], ['inviters', 'Top inviters'], ['counting', 'Counting'], ['backups', 'Backups']];
  function pageLists() {
    S.listTab = S.listTab || 'giveaways';
    return withServer('Lists', 'Giveaways, custom commands, top inviters, counting games and backups', async (guild) => {
      const box = h('div', { class: 'stack big' });
      const tabs = h('div', { class: 'segs', role: 'group', 'aria-label': 'List' }, LISTS.map(([id, label]) => h('button', { class: 'seg', type: 'button', 'aria-pressed': String(S.listTab === id), onclick: () => { S.listTab = id; draw(); } }, label)));
      let v = await call('panel', { guild, panel: S.listTab });
      const reload = async () => { v = await call('panel', { guild, panel: S.listTab }); paint(); };
      function paint() {
        box.replaceChildren(v.rows.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, v.rows.map((r) => h('div', { class: 'case' },
          h('div', { class: 'text' }, h('b', {}, r.title), h('p', { class: 'muted small' }, r.lines.join(' · '))),
          (r.actions || []).map((a) => h('button', { class: `btn ${a.ask ? 'quiet' : ''}`, type: 'button', onclick: (e) => {
            const b = e.currentTarget;
            if (a.ask && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sure?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = a.label; }, 5000); return; }
            busy(b, async () => { await call('panel_action', { guild, panel: v.id, row: r.id, action: a.id }); toast('Done.'); await reload(); });
          } }, a.label)))))) : h('div', { class: 'card empty' }, h('h2', {}, `No ${v.title.toLowerCase()} yet`), h('p', { class: 'muted' }, v.empty)));
      }
      paint();
      return [tabs, box];
    });
  }

  // ---- Permissions: who may use each command, in plain words
  function pagePermissions() {
    return withServer('Permissions', 'Who may use what. An administrator always can; with no role chosen, the normal rule applies', async (guild) => {
      const box = h('div', { class: 'stack big' });
      let v = await call('permissions', { guild });
      const DEF = { everyone: 'Everyone', moderator: 'Moderators', admin: 'Administrators' };
      const names = Object.fromEntries(v.roles.map((r) => [r.id, r.name]));
      S.permFind = S.permFind || '';
      function paint() {
        const groups = {};
        for (const p of v.permissions) if (!S.permFind || `${p.label} ${p.key}`.toLowerCase().includes(S.permFind.toLowerCase())) (groups[p.group] ||= []).push(p);
        box.replaceChildren(
          h('div', { class: 'tools' }, h('input', { type: 'search', placeholder: 'Find a permission', 'aria-label': 'Find a permission', value: S.permFind, oninput: (e) => { S.permFind = e.target.value; clearTimeout(S.permT); S.permT = setTimeout(paint, 200); } })),
          ...Object.keys(groups).sort().map((g) => h('div', { class: 'card' }, h('h2', {}, g.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())), h('div', { class: 'list' }, groups[g].map((p) => {
            const sel = h('select', { 'aria-label': `Add a role to ${p.label}`, onchange: async (e) => {
              const id = e.target.value; if (!id) return;
              try { await call('permission_set', { guild, key: p.key, roles: [...p.roles, id] }); v = await call('permissions', { guild }); toast('Saved.'); paint(); } catch (err) { toast(err.message, true); }
            } }, h('option', { value: '' }, p.roles.length ? 'Add another role…' : 'Choose roles…'), v.roles.filter((r) => !p.roles.includes(r.id)).map((r) => h('option', { value: r.id }, r.name)));
            return h('div', { class: 'case perm' }, h('div', { class: 'text' }, h('b', {}, p.label), h('p', { class: 'muted small' }, p.roles.length ? 'Only these roles (and administrators):' : `Normal rule: ${DEF[p.default] || p.default}`),
              p.roles.length ? h('div', { class: 'flags' }, p.roles.map((id) => h('button', { class: 'flag', type: 'button', title: 'Take this role off', onclick: async () => {
                try { await call('permission_set', { guild, key: p.key, roles: p.roles.filter((x) => x !== id) }); v = await call('permissions', { guild }); toast('Saved.'); paint(); } catch (err) { toast(err.message, true); }
              } }, `${names[id] || 'a deleted role'} ✕`))) : null), sel);
          })))));
      }
      paint();
      return [box];
    });
  }

  // ---- Commands: every command, run from here (so nothing needs typing in Discord)
  function pageCommands() {
    return withServer('Commands', 'Run any command from here: the same boxes as in Discord, filled in on this page', async (guild) => {
      const [cat, dir] = await Promise.all([call('commands_view'), call('directory', { guild })]);
      const all = cat.commands;
      const slot = h('div', { class: 'stack' });
      S.cmdFind ??= ''; S.cmdMod ??= 'all';
      const mods = [...new Map(all.map((c) => [c.module, c.module_name])).entries()].sort((x, y) => x[1].localeCompare(y[1]));
      function listView() {
        const q = S.cmdFind.trim().toLowerCase();
        const rows = all.filter((c) => (S.cmdMod === 'all' || c.module === S.cmdMod) && (!q || `${c.name} ${c.about} ${c.module_name} ${c.subs.map((s) => s.name + ' ' + s.about).join(' ')}`.toLowerCase().includes(q)));
        const find = h('input', { type: 'search', placeholder: 'Find a command', 'aria-label': 'Find a command', value: S.cmdFind, oninput: (e) => { S.cmdFind = e.target.value; clearTimeout(S.cmdT); S.cmdT = setTimeout(() => { slot.replaceChildren(listView()); const i = slot.querySelector('input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 150); } });
        const pick = h('select', { 'aria-label': 'Show commands of', onchange: (e) => { S.cmdMod = e.target.value; slot.replaceChildren(listView()); } }, h('option', { value: 'all' }, 'Everything'), mods.map(([id, name]) => h('option', { value: id, selected: S.cmdMod === id ? true : null }, name)));
        return h('div', { class: 'stack' }, h('div', { class: 'tools' }, find, pick),
          h('div', { class: 'card' }, rows.length ? h('div', { class: 'list' }, rows.map((c) => h('div', { class: 'case' },
            h('div', { class: 'text' }, h('b', {}, `/${c.name}`), h('p', { class: 'muted small' }, `${c.about} · ${c.module_name}${c.subs.length ? ` · ${c.subs.length} parts` : ''}`), h('p', { class: 'muted small' }, `In Discord: ${c.discord}`)),
            h('button', { class: 'btn quiet', type: 'button', onclick: () => slot.replaceChildren(formView(c)) }, c.own_popup && !c.subs.length ? 'About' : 'Open')))) : h('p', { class: 'muted' }, 'No command matches that.')));
      }
      function field(f, values) {
        const id = `cf-${f.id}`;
        const set = (v) => { values[f.id] = v; };
        let input;
        if (f.kind === 'select') input = h('select', { id, onchange: (e) => set(e.target.value) }, h('option', { value: '' }, 'Choose…'), f.options.map(([l, v]) => h('option', { value: v }, l)));
        else if (f.kind === 'role') input = h('select', { id, onchange: (e) => set(e.target.value) }, h('option', { value: '' }, 'Choose a role…'), dir.roles.map((r) => h('option', { value: r.id }, r.name)));
        else if (f.kind === 'channel') { const cats = (f.types || []).length === 1 && f.types[0] === 4; input = h('select', { id, onchange: (e) => set(e.target.value) }, h('option', { value: '' }, cats ? 'Choose a category…' : 'Choose a channel…'), dir.channels.filter((c) => (c.kind === 'category') === cats).map((c) => h('option', { value: c.id }, `${cats ? '' : c.kind === 'voice' ? '🔊 ' : '# '}${c.name}`))); }
        else if (f.kind === 'member') {
          const chosen = h('span', { class: 'muted small' }, 'Nobody chosen'); const results = h('div', { class: 'stack' });
          const look = async (q) => { if (q.trim().length < 2) { results.replaceChildren(); return; } try { const found = await call('members_search', { guild, q }); results.replaceChildren(...found.slice(0, 6).map((m) => h('button', { class: 'btn quiet', type: 'button', onclick: () => { set(m.id); chosen.textContent = m.name; results.replaceChildren(); } }, m.name))); } catch (e) { toast(e.message, true); } };
          let t; input = h('div', { class: 'stack' }, h('input', { id, type: 'search', placeholder: 'Type a name, or paste their ID', oninput: (e) => { const v = e.target.value.trim(); if (/^\d{15,25}$/.test(v)) { set(v); chosen.textContent = `ID ${v}`; results.replaceChildren(); } else { clearTimeout(t); t = setTimeout(() => look(v), 250); } } }), chosen, results);
        } else if (f.kind === 'files') input = h('p', { class: 'muted small' }, 'Pictures and files are added on that module\'s setup page (Modules).');
        else input = f.long ? h('textarea', { id, rows: 4, maxlength: f.max || 4000, placeholder: f.placeholder || '', oninput: (e) => set(e.target.value) }) : h('input', { id, type: 'text', maxlength: f.max || 4000, placeholder: f.placeholder || '', oninput: (e) => set(e.target.value) });
        return h('div', { class: 'field' }, h('label', { for: id }, f.label + (f.required ? ' *' : '')), input, f.desc ? h('p', { class: 'hint' }, f.desc) : null);
      }
      function formView(c) {
        const values = {}; let sub = c.subs.length ? c.subs[0].name : null;
        const out = h('div', { class: 'stack' });
        const body = h('div', { class: 'stack' });
        const part = () => (sub ? c.subs.find((s) => s.name === sub) : c);
        const draw = () => {
          for (const k of Object.keys(values)) delete values[k];
          const p = part();
          body.replaceChildren(...[
            c.subs.length ? h('div', { class: 'field slim' }, h('label', { for: 'cmd-sub' }, 'What to do'), h('select', { id: 'cmd-sub', onchange: (e) => { sub = e.target.value; out.replaceChildren(); draw(); } }, c.subs.map((s) => h('option', { value: s.name, selected: s.name === sub ? true : null }, `${s.name} · ${s.about}`)))) : null,
            p.own_popup ? h('p', { class: 'note' }, 'This one opens its own popup in Discord, so it is used there. Its settings are on the Modules page.') : null,
            ...p.fields.map((f) => field(f, values)),
            p.own_popup ? null : h('div', { class: 'btns' }, (() => { const run = h('button', { class: 'btn', type: 'button', onclick: () => busy(run, async () => {
              const r = await call('command_run', { guild, name: c.name, sub, values });
              out.replaceChildren(h('div', { class: 'card inner' }, ...(r.said.length ? r.said.map((t) => h('p', {}, String(t).replace(/\*\*/g, ''))) : [h('p', {}, 'Done.')]), r.note ? h('p', { class: 'note warn' }, r.note) : null));
              toast('Done.');
            }) }, `Run /${c.name}${sub ? ' ' + sub : ''}`); return run; })())].filter(Boolean));
        };
        draw();
        return h('div', { class: 'stack' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => slot.replaceChildren(listView()) }, '‹ All commands'),
          h('div', { class: 'card' }, h('h2', {}, `/${c.name}`), h('p', { class: 'muted' }, `${c.about}. In Discord: ${c.discord}.`), body), out);
      }
      slot.replaceChildren(listView());
      return [slot];
    });
  }

  // ---- Role menus: the menus posted in the server, and taking one away
  function pageRoleMenus() {
    return withServer('Role menus', 'The menus members use to pick their own roles', async (guild) => {
      const box = h('div', { class: 'stack big' });
      let v = await call('role_menus', { guild });
      const how = (m) => [m.mode === 'unique' ? 'Pick one (choosing another swaps it)' : m.max > 0 ? `Up to ${m.max} each` : 'Any number', m.type === 'dropdown' ? 'drop-down' : 'buttons', m.hours > 0 ? `roles last ${m.hours} hour${m.hours === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
      function paint() {
        box.replaceChildren(v.menus.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, v.menus.map((m) => h('div', { class: 'case' },
          h('div', { class: 'text' }, h('b', {}, m.title || 'Pick your roles'),
            h('p', { class: 'muted small' }, `${m.channel_name ? `#${m.channel_name}` : 'a channel'} · ${how(m)}`),
            h('p', { class: 'small' }, m.roles.map((r) => `${r.emoji ? `${r.emoji} ` : ''}${r.name || 'a role that was deleted'}`).join(', ') || 'No roles left on this menu')),
          h('button', { class: 'btn quiet', type: 'button', title: 'Delete the menu message; its buttons stop working', onclick: (e) => {
            const b = e.currentTarget;
            if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete it?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Delete'; }, 5000); return; }
            busy(b, async () => { await call('role_menu_delete', { guild, message: m.message }); toast('The menu was deleted.'); v = await call('role_menus', { guild }); paint(); });
          } }, 'Delete')))))
          : h('div', { class: 'card empty' }, h('h2', {}, 'No menus yet'), h('p', { class: 'muted' }, 'Make one in Discord with /rolemenu create. It shows up here once it is posted.')));
      }
      paint();
      return [box];
    });
  }

  // ---- Shop: the roles and items members buy with coins
  function pageShop() {
    return withServer('Shop', 'What members can buy with their coins', async (guild) => {
      const box = h('div', { class: 'stack big' });
      let v = await call('shop', { guild });
      const reload = async () => { v = await call('shop', { guild }); paint(); };
      const f = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('p', { class: 'muted small' }, hint) : null);
      function form(item) {
        const name = h('input', { type: 'text', maxlength: 60, value: item ? item.name : '', placeholder: 'e.g. VIP or Golden Bone' });
        const price = h('input', { type: 'number', min: 1, value: item ? item.price : '', placeholder: 'e.g. 5000' });
        const emoji = h('input', { type: 'text', maxlength: 8, value: item && item.emoji ? item.emoji : '', placeholder: '🦴' });
        const role = h('select', { 'aria-label': 'Role it gives' }, [h('option', { value: '' }, 'No role (an item)'), ...v.roles.map((r) => h('option', { value: r.id, selected: item && item.role_id === r.id }, r.name))]);
        const hours = h('input', { type: 'number', min: 0, value: item ? item.hours : 0 });
        const stock = h('input', { type: 'number', min: 0, value: item && item.stock != null ? item.stock : '', placeholder: 'No limit' });
        const text = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Roles: a description. Items: what using it says ({user} is the buyer).' }, item ? (item.role_id ? item.description || '' : item.message || '') : '');
        const used = h('input', { type: 'checkbox', checked: !!(item && item.consumable) });
        const roleBits = [f('Hours the role lasts', hours, '0 keeps it for good')];
        const sync = () => { for (const el of roleBits) el.hidden = !role.value; used.parentElement.hidden = !!role.value; };
        role.addEventListener('change', sync);
        const save = h('button', { class: 'btn', type: 'button' }, item ? 'Save changes' : 'Add to the shop');
        save.addEventListener('click', () => busy(save, async () => {
          toast(await call('shop_save', { guild, name: name.value, price: Number(price.value) || 0, emoji: emoji.value, role: role.value || null, hours: Number(hours.value) || 0, stock: stock.value === '' ? null : Number(stock.value), text: text.value, consumable: used.checked }));
          S.shopEdit = null; await reload();
        }));
        const card = h('div', { class: 'card' }, h('h3', {}, item ? `Change ${item.name}` : 'Add to the shop'),
          h('div', { class: 'grid2' }, f('Name', name), f('Price', price)), h('div', { class: 'grid2' }, f('Emoji', emoji), f('Role it gives', role)),
          h('div', { class: 'grid2' }, ...roleBits, f('How many to sell', stock, 'Empty for no limit')), f('Description or what using it says', text),
          h('label', { class: 'chk' }, used, ' Used up when a member uses it'),
          h('div', { class: 'btns' }, save, item ? h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.shopEdit = null; paint(); } }, 'Cancel') : null));
        sync();
        return card;
      }
      function paint() {
        const edit = S.shopEdit && v.items.find((i) => i.id === S.shopEdit);
        box.replaceChildren(
          h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, `In the shop (${v.items.length} of ${v.max})`), h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.shopEdit = null; paint(); document.querySelector('.main').scrollTo(0, 99999); } }, 'Add an item')),
            v.items.length ? h('div', { class: 'list' }, v.items.map((i) => h('div', { class: 'case' },
              h('span', { class: 'shopemoji' }, i.emoji || (i.role_id ? '🎭' : '🎁')),
              h('div', { class: 'text' }, h('b', {}, i.name), h('p', { class: 'muted small' }, [`${Number(i.price).toLocaleString()} coins`, i.role_id ? `gives ${(v.roles.find((r) => r.id === i.role_id) || {}).name || 'a role'}${i.hours ? ` for ${i.hours} hours` : ''}` : (i.consumable ? 'used up when used' : 'an item'), i.stock != null ? `${i.stock} left` : 'no limit'].join(' · '))),
              h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.shopEdit = i.id; paint(); } }, 'Change'),
              h('button', { class: 'btn quiet', type: 'button', onclick: (e) => { const b = e.currentTarget; if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Remove?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Remove'; }, 4000); return; } busy(b, async () => { await call('shop_remove', { guild, id: i.id }); await reload(); }); } }, 'Remove'))))
              : h('p', { class: 'muted' }, 'The shop has nothing of yours yet. Members always see the built-in items too (streak shield, padlock, lottery ticket and so on).')),
          form(edit || null));
      }
      paint();
      return [box];
    });
  }

  // ---- word lists: type a word and press Enter; pasted text is split into separate entries
  /**
   * Turns typed or pasted text into separate entries. Commas, semicolons, new lines, tabs and bullets always separate.
   * `spaces`: a pasted line with no other separator is split at its spaces too, so "one two three" is three words
   * (typing a phrase and pressing Enter keeps it whole). Returns { items, tooLong } (a run of `max` or more letters with
   * no space or comma in it is not a word: it is refused instead of being kept as one big word).
   */
  function splitEntries(text, { spaces = false, max = 40, pasted = false, clean = (x) => x } = {}) {
    const lines = String(text).replace(/[\r\n\t;|•·،，、]+/g, '\n').replace(/,/g, '\n').split('\n')
      .map((x) => x.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '').replace(/^["'“”‘’()[\]{}]+|["'“”‘’()[\]{}]+$/g, '').trim()).filter(Boolean);
    let parts = lines;
    // text with no separator at all that pasted in as several words: each word is its own entry
    if (spaces && pasted && lines.length === 1 && /\s/.test(lines[0])) parts = lines[0].split(/\s+/);
    const items = [], tooLong = [];
    for (const raw of parts) {
      const x = clean(raw);
      if (!x) continue;
      if (x.length > max && !/\s/.test(x)) { tooLong.push(x.slice(0, 24) + '…'); continue; }
      if (x.length > 200) { tooLong.push(x.slice(0, 24) + '…'); continue; }
      if (!items.some((y) => y.toLowerCase() === x.toLowerCase())) items.push(x);
    }
    return { items, tooLong };
  }
  /** A list as chips with a box: Enter adds what is typed, a pasted list is split up, a chip's × takes it out. */
  function chipList({ values, onChange, spaces, max, clean, placeholder, id }) {
    let list = [...(values || [])];
    const wrap = h('div', { class: 'chiplist' });
    const input = h('input', { type: 'text', id, class: 'chipbox', placeholder: placeholder || 'Type a word and press Enter', autocomplete: 'off', spellcheck: 'false' });
    const count = h('span', { class: 'muted small' });
    const draw = () => {
      wrap.replaceChildren(...list.map((w) => h('span', { class: 'chipw' }, w, h('button', { type: 'button', class: 'chipx', 'aria-label': `Remove ${w}`, title: 'Remove', onclick: () => { list = list.filter((x) => x !== w); draw(); onChange(list); } }, '×'))), input);
      count.textContent = list.length ? `${list.length} in the list. Press Enter after each one.` : '';
    };
    const add = (text, pasted) => {
      const { items, tooLong } = splitEntries(text, { spaces, max: max || 40, pasted, clean });
      const fresh = items.filter((x) => !list.some((y) => y.toLowerCase() === x.toLowerCase()));
      if (tooLong.length) toast(`Not added: ${tooLong.join(', ')}. That is too long to be one word. Put a space, comma or new line between words.`, true);
      if (!fresh.length) { input.value = ''; return; }
      if (list.length + fresh.length > 100) { toast('A list can have up to 100 entries.', true); return; }
      list = list.concat(fresh); input.value = ''; draw(); onChange(list);
      if (fresh.length > 1) toast(`Added ${fresh.length}.`);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) add(input.value, false); }
      else if (e.key === 'Backspace' && !input.value && list.length) { list = list.slice(0, -1); draw(); onChange(list); }
    });
    input.addEventListener('paste', (e) => { const t = (e.clipboardData || window.clipboardData).getData('text'); if (t && /[\s,;|]/.test(t.trim())) { e.preventDefault(); add(t, true); } });
    input.addEventListener('blur', () => { if (input.value.trim()) add(input.value, false); });
    draw();
    const box = h('div', { class: 'chipwrap' }, wrap, count);
    box.setValues = (v) => { list = [...(v || [])]; draw(); };
    return box;
  }
  // plain words for the values some settings choose between
  const CHOICE_WORDS = { default: 'Use the usual response', delete: 'Delete the message', 'delete-warn': 'Delete and warn', 'delete-timeout': 'Delete and time out' };
  function settingRow(guild, module, d, lists) {
    const id = `s-${module}-${d.key}`;
    const save = async (value, el) => {
      try { const kept = await call('setting_set', { guild, module, key: d.key, value }); d.value = kept; note.textContent = 'Saved'; note.className = 'saved show'; setTimeout(() => { note.className = 'saved'; }, 1500); }
      catch (e) { toast(e.message, true); if (el) setInput(d.value); }
    };
    const note = h('span', { class: 'saved', 'aria-live': 'polite' });
    let input, setInput = () => {};
    if (d.kind === 'toggle') {
      input = h('input', { type: 'checkbox', class: 'toggle', role: 'switch', id, checked: !!d.value, onchange: (e) => save(e.target.checked) });
      return h('div', { class: 'setting inline' }, h('label', { for: id }, d.label), note, input);
    }
    if (d.kind === 'number') {
      input = h('input', { type: 'number', id, min: d.min, max: d.max, value: d.value ?? '', inputmode: 'numeric', onchange: (e) => save(e.target.value, e.target) });
    } else if (d.kind === 'channel' || d.kind === 'category' || d.kind === 'role') {
      const all = d.kind === 'role' ? lists.roles : lists.channels.filter((c) => c.kind === (d.kind === 'category' ? 'category' : 'text'));
      if (all.length) {
        input = h('select', { id, onchange: (e) => save(e.target.value || null) }, h('option', { value: '' }, `No ${d.kind} chosen`), all.map((c) => h('option', { value: c.id, selected: c.id === d.value }, d.kind === 'channel' ? `# ${c.name}` : c.name)));
      } else {
        input = h('input', { type: 'text', id, value: d.value ?? '', placeholder: `Paste a ${d.kind} ID`, onchange: (e) => save(e.target.value.trim() || null, e.target) });
        input.dataset.hint = `Start the bot to pick from a list of ${d.kind}s.`;
      }
    } else if (d.kind === 'colour') {
      // a real colour picker next to the code, kept in step with each other
      const code = h('input', { type: 'text', id, class: 'colourcode', maxlength: 7, value: d.value ?? '', placeholder: '#rrggbb', spellcheck: 'false', 'aria-label': `${d.label} (code)` });
      const wheel = h('input', { type: 'color', class: 'colourwheel', value: /^#[0-9a-f]{6}$/i.test(d.value ?? '') ? d.value : '#000000', 'aria-label': `${d.label} (picker)`,
        oninput: (e) => { code.value = e.target.value; }, onchange: (e) => save(e.target.value, code) });
      code.addEventListener('change', () => { const v = code.value.trim(); if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) { const full = '#' + v.replace('#', ''); wheel.value = full.length === 4 ? '#' + [...full.slice(1)].map((c) => c + c).join('') : full; } save(v, code); });
      input = h('div', { class: 'colourrow' }, wheel, code);
    } else if (d.kind === 'select') {
      input = h('select', { id, onchange: (e) => save(e.target.value) }, d.options.map((x) => h('option', { value: x, selected: x === d.value }, CHOICE_WORDS[x] ?? x)));
    } else if (d.kind === 'list') {
      // the strike ladder is one step per line (so a step has spaces in it); every other list is words, links or names
      const steps = d.key === 'strikeLadder';
      input = chipList({ id, values: d.value || [], spaces: !steps, max: d.key === 'allowedDomains' ? 100 : 40,
        placeholder: steps ? 'Type a step like 2 timeout 1d and press Enter' : d.key === 'allowedDomains' ? 'Type a website like youtube.com and press Enter' : 'Type a word and press Enter',
        clean: d.key === 'allowedDomains' ? (x) => x.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '') : undefined,
        onChange: (list) => save(list) });
    } else {
      input = h('input', { type: 'text', id, maxlength: d.max, value: d.value ?? '', onchange: (e) => save(e.target.value, e.target) });
    }
    setInput = (v) => { if (input.setValues) return input.setValues(v); const box = input.matches('input,select') ? input : input.querySelector('.colourcode'); box.value = Array.isArray(v) ? v.join(', ') : v ?? ''; if (box.classList.contains('colourcode') && /^#[0-9a-f]{6}$/i.test(box.value)) input.querySelector('.colourwheel').value = box.value; };
    const hint = d.kind === 'number' ? `${d.min.toLocaleString()} to ${d.max.toLocaleString()}` : input.dataset.hint || null;
    return h('div', { class: 'setting field' }, h('div', { class: 'row tight' }, h('label', { for: id }, d.label), note), input, hint ? h('span', { class: 'hint' }, hint) : null);
  }

  /** A module's settings. With headings, each group folds away so a long list stays short; the first is open. */
  function grouped(guild, module, r) {
    const groups = [];
    // settings with the same heading go together, in the order the headings first appear
    for (const d of r.settings) {
      const name = d.group || '';
      const same = groups.find((x) => x.name === name);
      if (same) same.items.push(d); else groups.push({ name, items: [d] });
    }
    if (groups.length < 2) return [h('div', { class: 'settings' }, r.settings.map((d) => settingRow(guild, module, d, r)))];
    const opened = (S.groupOpen ??= {});
    return groups.map((gr, k) => {
      const key = `${module}:${gr.name}`;
      const box = h('details', { class: 'group', open: opened[key] ?? k === 0, ontoggle: (e) => { opened[key] = e.target.open; } },
        h('summary', {}, h('span', {}, gr.name), h('span', { class: 'small muted' }, `${gr.items.length} setting${gr.items.length === 1 ? '' : 's'}`)),
        h('div', { class: 'settings' }, gr.items.map((d) => settingRow(guild, module, d, r))));
      return box;
    });
  }

  /** Money's reset: one button, a plain question in its place, and a backup made before anything is cleared. */
  function resetZone(g) {
    const btn = h('button', { class: 'btn danger', type: 'button' }, 'Reset the economy…');
    btn.addEventListener('click', () => confirmInline(btn, `Reset everyone's coins, streaks, items and pets in ${g.name}? A backup is made first.`, 'Reset', async () => {
      const n = await call('economy_reset', { guild: g.id });
      toast(`The economy in ${g.name} was reset (${plural(n, 'wallet', 'wallets')}). A backup was made first.`);
      draw();
    }));
    return h('div', { class: 'danger-zone' }, h('div', { class: 'text' }, h('h3', {}, 'Start the economy again'), h('p', { class: 'small muted' }, 'Everyone goes back to the starting coins. The shop and settings stay. Members can also be reset one at a time with /money reset in Discord.')), btn);
  }

  // Modules as Good Boy 3's dashboard shows them: a grid of app tiles in groups, each opening its own page.
  const MOD_CATS = ['Safety & support', 'Welcome & members', 'Levels & stats', 'Money', 'Games & fun', 'Social & profiles', 'Roles & messages', 'Music & voice', 'Connections', 'Tools & backup'];
  const MOD_CAT = { moderation: 0, altwatch: 0, modmail: 0, support: 0,
    'member-management': 1, invites: 1, deadchat: 1,
    community: 2, stats: 2, achievements: 2,
    economy: 3,
    fun: 4, games: 4, critters: 4, counting: 4, roleplay: 4, giveaways: 4,
    eclipseid: 5, family: 5, plural: 5, partyfinder: 5, quotes: 5, timezones: 5,
    roles: 6, tags: 6, messages: 6, engagement: 6, botnews: 6,
    music: 7, voice: 7, tempvoice: 7,
    integrations: 8, clips: 8,
    reminders: 9, utility: 9, backup: 9 };
  const MOD_ICON = { moderation: '🛡️', support: '🎫', modmail: '📬', altwatch: '🕵️', community: '⭐', 'member-management': '👋', invites: '🔗', deadchat: '💬', stats: '📊', achievements: '🏆', economy: '🪙', fun: '🎲', games: '🎮', critters: '🐾', counting: '🔢', roleplay: '🤗', giveaways: '🎉', eclipseid: '🪪', family: '👪', plural: '🧩', partyfinder: '🧭', quotes: '❝', timezones: '🕒', roles: '🏷️', tags: '📝', messages: '📣', engagement: '🗳️', botnews: '📰', music: '🎵', voice: '🗣️', tempvoice: '🔊', integrations: '🔌', clips: '🎬', reminders: '⏰', utility: '🧰', backup: '💾' };
  const TAB_OF = (kind) => (kind === 'channel' || kind === 'category' || kind === 'role' ? 'setup' : kind === 'toggle' || kind === 'select' || kind === 'colour' ? 'settings' : 'advanced');
  function modStatus(m) {
    if (m.needs_setup) return h('span', { class: 'mstatus warn' }, h('i'), 'Needs setup');
    return h('span', { class: 'mstatus' + (m.on ? ' is-on' : '') }, h('i'), m.on ? 'On' : 'Off');
  }
  function moduleSwitch(g, m, after) {
    return h('input', { type: 'checkbox', class: 'toggle', role: 'switch', checked: m.on, 'aria-label': `${m.name} on`, onclick: (e) => e.stopPropagation(), onchange: async (e) => {
      try { await call('module_set', { guild: g.id, module: m.id, on: e.target.checked }); m.on = e.target.checked; toast(`${m.name} turned ${m.on ? 'on' : 'off'}`); after && after(); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); } } });
  }
  function pageServers() {
    const invite = h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, () => call('open', { what: 'invite' })) }, 'Invite to a server');
    const body = h('div', { class: 'stack big' }, h('p', { class: 'muted' }, 'Loading…'));
    (async () => {
      let servers;
      try { servers = await call('servers'); } catch (e) { body.replaceChildren(h('p', { class: 'msg bad' }, e.message)); return; }
      if (!servers.length) {
        body.replaceChildren(h('div', { class: 'head' }, h('h1', {}, 'Modules')), h('div', { class: 'card empty' }, h('h2', {}, 'No servers yet'), h('p', { class: 'muted' }, S.o.token_saved ? 'Invite the bot to a server, then start it. The server shows up here a moment after the bot joins.' : 'Add your bot\'s token first, then invite the bot to a server.'),
          h('div', { class: 'btns' }, S.o.token_saved ? invite : h('button', { class: 'btn', type: 'button', onclick: () => go('bot') }, 'Add token'))));
        return;
      }
      const g = servers.find((x) => x.id === S.guild) || servers[0];
      S.guild = g.id;
      const picker = servers.length > 1
        ? h('div', { class: 'field slim' }, h('label', { for: 'guild' }, 'Server'), h('select', { id: 'guild', onchange: (e) => { S.guild = e.target.value; S.open = null; draw(); } }, servers.map((x) => h('option', { value: x.id, selected: x.id === g.id }, x.name))))
        : h('span', { class: 'muted' }, g.name);
      const m = S.open && g.modules.find((x) => x.id === S.open);
      body.replaceChildren(...(m ? modulePage(g, m) : moduleGrid(g, picker, invite)));
    })();
    return [body];
  }
  function moduleGrid(g, picker, invite) {
    S.modq = S.modq || ''; S.modf = S.modf || 'all'; S.modc = S.modc ?? -1;
    const list = h('div', { class: 'modlist' });
    const search = h('input', { type: 'search', placeholder: 'Search modules', 'aria-label': 'Search modules', value: S.modq, oninput: (e) => { S.modq = e.target.value.toLowerCase(); paint(); } });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [['all', 'All'], ['on', 'On'], ['off', 'Off'], ['setup', 'Needs setup']].map(([k, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(S.modf === k), onclick: (e) => { S.modf = k; for (const b of seg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); paint(); } }, l)));
    const cats = h('div', { class: 'chips', role: 'group', 'aria-label': 'Category' }, [[-1, 'Everything'], ...MOD_CATS.map((c, k) => [k, c])].map(([k, label]) =>
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(S.modc === k), onclick: (e) => { S.modc = k; for (const b of cats.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); paint(); } }, label)));
    function paint() {
      const shown = g.modules.filter((m) => (!S.modq || `${m.name} ${m.id} ${m.about}`.toLowerCase().includes(S.modq))
        && (S.modc < 0 || (MOD_CAT[m.id] ?? 9) === S.modc)
        && (S.modf === 'all' || (S.modf === 'on' && m.on) || (S.modf === 'off' && !m.on) || (S.modf === 'setup' && m.needs_setup)));
      const groups = MOD_CATS.map((c, ci) => [c, shown.filter((m) => (MOD_CAT[m.id] ?? 9) === ci)]).filter(([, ms]) => ms.length);
      list.replaceChildren(...(groups.length ? groups.flatMap(([c, ms]) => [h('h3', { class: 'section-title' }, c), h('div', { class: 'tiles' }, ms.map((m) =>
        h('div', { class: 'tile', role: 'button', tabindex: '0', onclick: () => { S.open = m.id; S.modTab = null; draw(); }, onkeydown: (e) => { if (e.key === 'Enter') { S.open = m.id; S.modTab = null; draw(); } } },
          h('div', { class: 'ttop' }, h('span', { class: 'ticon', 'data-cat': String(MOD_CAT[m.id] ?? 9), 'aria-hidden': 'true' }, MOD_ICON[m.id] || '◆'), h('strong', {}, m.name)),
          h('p', { class: 'tdesc' }, m.about),
          h('div', { class: 'tfoot' }, modStatus(m), moduleSwitch(g, m, paint)))))]) : [h('div', { class: 'card empty' }, h('p', { class: 'muted' }, 'No modules match. Try another word.'))]));
    }
    paint();
    return [
      h('div', { class: 'card modhead' }, h('div', {}, h('h1', {}, 'Modules'), h('p', { class: 'muted' }, 'Turn features on or off. Click one to set it up.')),
        h('div', { class: 'modtools' }, picker, h('label', { class: 'msearch' }, h('span', { 'aria-hidden': 'true' }, '🔍'), search), seg, invite)),
      cats,
      list,
      g.waiting ? h('p', { class: 'note' }, `${plural(g.waiting, 'more module from Good Boy 3 is', 'more modules from Good Boy 3 are')} turned on in this server. Their settings and data are kept, and each one returns as it is rebuilt.`) : null,
    ].filter(Boolean);
  }
  // Panels people post from the dashboard, as in Good Boy 3: the ticket buttons and the music player.
  const PANELS = {
    support: { title: 'Post the ticket panel', about: 'The buttons members press to open a ticket. Post it again after adding your own ticket types.', wording: true },
    music: { title: 'Post the music player', about: 'The player with buttons. Posting it again moves it to the new channel.', wording: false },
  };
  function panelCard(g, m, r) {
    const p = PANELS[m.id];
    const text = (r.channels || []).filter((c) => c.kind !== 'category' && c.kind !== 'voice');
    const ch = h('select', { id: 'panel-ch' }, text.length ? text.map((c) => h('option', { value: c.id }, `# ${c.name}`)) : h('option', { value: '' }, 'Start the bot to pick a channel'));
    const title = h('input', { id: 'panel-title', value: 'Need help?', maxlength: 200 });
    const words = h('textarea', { id: 'panel-text', rows: 3, maxlength: 1500 }, 'Press the button that fits your problem. A private channel opens for you and our staff.');
    const pin = h('input', { type: 'checkbox', class: 'toggle', role: 'switch', id: 'panel-pin', checked: true });
    const preview = h('div', { class: 'dpreview' }, h('p', { class: 'muted small' }, 'Loading the preview…'));
    let timer = null;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(async () => {
      try { preview.replaceChildren(discordMessage(await call('panel_preview', { guild: g.id, module: m.id, title: p.wording ? title.value : null, text: p.wording ? words.value : null }), S.o.live.name || 'Good Boy')); }
      catch (e) { preview.replaceChildren(h('p', { class: 'muted small' }, e.message)); }
    }, 200); };
    title.addEventListener('input', refresh); words.addEventListener('input', refresh);
    refresh();
    const post = h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, async () => {
      if (!ch.value) throw new Error('Start the bot, then pick a channel.');
      await call('post_panel', { guild: g.id, module: m.id, channel: ch.value, title: p.wording ? title.value : null, text: p.wording ? words.value : null, pin: pin.checked });
      toast(`Posted${pin.checked ? ' and pinned' : ''} in #${text.find((c) => c.id === ch.value)?.name || 'the channel'}.`);
    }) }, 'Post it');
    return h('div', { class: 'card panelcard' },
      h('div', { class: 'stack' }, h('div', {}, h('h2', {}, p.title), h('p', { class: 'muted small' }, p.about)),
        h('div', { class: 'field' }, h('label', { for: 'panel-ch' }, 'Channel'), ch),
        ...(p.wording ? [h('div', { class: 'field' }, h('label', { for: 'panel-title' }, 'Title'), title), h('div', { class: 'field' }, h('label', { for: 'panel-text' }, 'Text'), words)] : []),
        h('label', { class: 'row pinrow', for: 'panel-pin' }, h('span', {}, h('strong', {}, 'Pin it in the channel'), h('span', { class: 'muted small' }, ' so it stays easy to find')), pin),
        h('div', { class: 'btns' }, post)),
      h('div', { class: 'stack' }, h('span', { class: 'muted small' }, 'How it will look in Discord'), preview));
  }
  // A card as Discord shows it (from the same layout the bot sends), for previews.
  function discordMessage(d, botName) {
    const md = (t) => {
      const esc = String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return esc.split('\n').map((line) => {
        let l = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(.+?)\*/g, '$1<i>$2</i>').replace(/&lt;#(\d+)&gt;/g, '<span class="dmention">#channel</span>').replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="dmention">@role</span>').replace(/&lt;@!?(\d+)&gt;/g, '<span class="dmention">@member</span>').replace(/&lt;t:\d+:\w&gt;/g, '<span class="dmention">just now</span>');
        if (l.startsWith('### ')) return `<div class="dh3">${l.slice(4)}</div>`;
        if (l.startsWith('-# ')) return `<div class="dsmall">${l.slice(3)}</div>`;
        return `<div>${l || '&nbsp;'}</div>`;
      }).join('');
    };
    const html = (x) => { const e = h('div'); e.innerHTML = x; return e; };
    const part = (c) => {
      if (c.type === 10) return h('div', { class: 'dtext' }, html(md(c.content)));
      if (c.type === 9) return h('div', { class: 'dsection' }, h('div', {}, ...c.components.map(part)), c.accessory?.media?.url ? h('img', { class: 'dthumb', src: c.accessory.media.url, alt: '' }) : null);
      if (c.type === 1) return h('div', { class: 'drow' }, ...c.components.map((b) => b.type === 2
        ? h('span', { class: `dbtn s${b.style}` }, b.emoji?.name ? `${b.emoji.name} ` : '', b.label || '')
        : h('span', { class: 'dselect' }, b.placeholder || 'Pick one')));
      if (c.type === 13) return h('div', { class: 'dfile' }, '📄 ', (c.file?.url || '').replace('attachment://', ''));
      return null;
    };
    const top = d.components[0];
    const colour = top.accent_color != null ? `#${top.accent_color.toString(16).padStart(6, '0')}` : 'transparent';
    return h('div', { class: 'dmsg' }, h('img', { class: 'davatar', src: 'mascot.png', alt: '' }),
      h('div', {}, h('div', { class: 'dwho' }, h('b', {}, botName), h('span', { class: 'dapp' }, 'APP'), h('span', { class: 'dwhen' }, 'Today at 4:20 PM')),
        h('div', { class: 'dbox', style: `--c:${colour}` }, ...top.components.map(part).filter(Boolean))));
  }
  /** "Where it works": the module is on everywhere except the channels and categories listed. */
  /**
   * "Where it works": you choose the channels it DOES work in (it works everywhere until you choose). What is kept is the
   * list of channels it is off in, which is every channel you did not pick, so the bot reads it as it always did.
   */
  function whereCard(g, m, r) {
    const chans = r.channels.filter((c) => c.kind !== 'category' && c.kind !== 'other');
    const cats = r.channels.filter((c) => c.kind === 'category');
    const isOff = (c, off) => off.includes(c.id) || (c.parent && off.includes(c.parent));
    // what is on now: everything not switched off (directly or through its category)
    let on = new Set(chans.filter((c) => !isOff(c, r.off_channels || [])).map((c) => c.id));
    let mode = (r.off_channels || []).length ? 'some' : 'all';
    const body = h('div', { class: 'stack' });
    const note = h('span', { class: 'saved', 'aria-live': 'polite' });
    let timer;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const off = mode === 'all' ? [] : chans.filter((c) => !on.has(c.id)).map((c) => c.id);
        try { r.off_channels = await call('off_channels_set', { guild: g.id, module: m.id, channels: off }); note.textContent = 'Saved'; note.className = 'saved show'; setTimeout(() => { note.className = 'saved'; }, 1500); }
        catch (e) { toast(e.message, true); }
      }, 350);
    };
    const row = (c) => h('label', { class: 'chanrow' }, h('input', { type: 'checkbox', checked: on.has(c.id), onchange: (e) => { if (e.target.checked) on.add(c.id); else on.delete(c.id); count(); save(); } }), h('span', {}, `${c.kind === 'voice' ? '🔊 ' : c.kind === 'forum' ? '💬 ' : '# '}${c.name}`));
    const countEl = h('p', { class: 'muted small' });
    const count = () => { countEl.textContent = on.size ? `Works in ${on.size} of ${chans.length} channels.` : 'Nothing is picked yet, so it is off everywhere until you pick some channels.'; };
    const paint = () => {
      if (mode === 'all') { body.replaceChildren(h('p', { class: 'muted small' }, 'It works in every channel, including ones made later.')); return; }
      if (!chans.length) { body.replaceChildren(h('p', { class: 'muted' }, 'Start the bot to see this server\'s channels.')); return; }
      const loose = chans.filter((c) => !c.parent || !cats.some((k) => k.id === c.parent));
      const groups = [...(loose.length ? [{ name: 'No category', items: loose, id: null }] : []), ...cats.map((k) => ({ name: k.name, id: k.id, items: chans.filter((c) => c.parent === k.id) })).filter((x) => x.items.length)];
      const setAll = (items, yes) => { for (const c of items) { if (yes) on.add(c.id); else on.delete(c.id); } paint(); save(); };
      body.replaceChildren(
        h('div', { class: 'btns' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => setAll(chans, true) }, 'Pick all'), h('button', { class: 'btn quiet', type: 'button', onclick: () => setAll(chans, false) }, 'Pick none')),
        countEl,
        ...groups.map((gr) => h('div', { class: 'chancat' },
          h('div', { class: 'row tight' }, h('b', {}, gr.name), h('span', { class: 'btns' }, h('button', { class: 'btn quiet small', type: 'button', onclick: () => setAll(gr.items, true) }, 'All of these'), h('button', { class: 'btn quiet small', type: 'button', onclick: () => setAll(gr.items, false) }, 'None'))),
          h('div', { class: 'chanlist' }, gr.items.map(row)))),
        h('p', { class: 'muted small' }, 'A channel made after you choose is not picked: it works there too until you open this again and choose.'));
      count();
    };
    const choose = (v) => { mode = v; if (v === 'some' && on.size === chans.length) on = new Set(); paint(); save(); for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === v)); };
    const seg = h('div', { class: 'segs', role: 'group', 'aria-label': 'Where it works' },
      h('button', { class: 'seg', type: 'button', 'data-v': 'all', 'aria-pressed': String(mode === 'all'), onclick: () => choose('all') }, 'Every channel'),
      h('button', { class: 'seg', type: 'button', 'data-v': 'some', 'aria-pressed': String(mode === 'some'), onclick: () => choose('some') }, 'Only channels I pick'));
    paint();
    return h('div', { class: 'card' }, h('div', { class: 'row tight' }, h('h2', {}, 'Where it works'), note),
      h('p', { class: 'muted' }, `Choose where ${m.name} does its job. Admins can still use its commands anywhere.`), seg, body);
  }
  /** "Who can use it": this module's permission lines, with role pickers. */
  function whoCard(g, m, r) {
    const DEF = { everyone: 'Everyone', moderator: 'Moderators', admin: 'Administrators' };
    const name = (id) => (r.roles.find((x) => x.id === id) || {}).name || 'a deleted role';
    const box = h('div', { class: 'card' }, h('h2', {}, 'Who can use it'), h('p', { class: 'muted' }, 'Each line starts with its default. Add roles to choose exactly who can do it instead. The owner and Administrators can always do everything.'));
    const list = h('div', { class: 'list' });
    const set = async (p, roles) => { try { await call('permission_set', { guild: g.id, key: p.key, roles }); p.roles = roles; toast('Saved.'); } catch (e) { toast(e.message, true); } paint(); };
    function paint() {
      list.replaceChildren(...r.permissions.map((p) => h('div', { class: 'case' }, h('div', { class: 'text' }, h('b', {}, p.label), h('p', { class: 'muted small' }, p.roles.length ? 'Only these roles (and administrators):' : `Normal rule: ${DEF[p.default] || p.default}`),
        p.roles.length ? h('div', { class: 'flags' }, p.roles.map((id) => h('button', { class: 'flag', type: 'button', title: 'Take this role off', onclick: () => set(p, p.roles.filter((x) => x !== id)) }, `@${name(id)} ✕`))) : null),
        h('select', { 'aria-label': `Add a role to ${p.label}`, onchange: (e) => { if (e.target.value) set(p, [...p.roles, e.target.value]); } }, h('option', { value: '' }, p.roles.length ? 'Add another role…' : 'Choose roles…'), r.roles.filter((x) => !p.roles.includes(x.id)).map((x) => h('option', { value: x.id }, x.name))))));
    }
    paint(); box.append(list); return box;
  }
  /** "History": what the bot has noted lately about this module. */
  function historyCard(g, m) {
    const box = h('div', { class: 'card' }, h('h2', {}, 'History'), h('p', { class: 'muted' }, 'Loading…'));
    call('activity', { guild: g.id, sinceId: 0 }).then((a) => {
      const words = [m.id, ...m.commands.map((c) => c.name)].map((w) => w.toLowerCase());
      const mine = a.entries.filter((e) => words.some((w) => e.text.toLowerCase().includes(w))).reverse().slice(0, 60);
      box.replaceChildren(h('h2', {}, 'History'), h('p', { class: 'muted small' }, 'What the bot has noted about this module since it started.'),
        mine.length ? h('div', { class: 'list' }, mine.map((e) => h('div', { class: 'case' }, h('div', { class: 'text' }, h('p', { class: e.kind === 'error' ? 'bad' : '' }, e.text), h('p', { class: 'muted small' }, new Date(e.at).toLocaleString()))))) : h('p', { class: 'muted' }, 'Nothing recorded for this module yet.'));
    }, (e) => box.replaceChildren(h('h2', {}, 'History'), h('p', { class: 'muted' }, e.message || String(e))));
    return box;
  }
  /** A picture chosen on this computer, as text the program can carry: { name, data }. */
  function readPicture(file) {
    return new Promise((ok, no) => {
      if (!file) return no(new Error('Pick a picture first.'));
      if (file.size > 8 * 1024 * 1024) return no(new Error('That picture is too big. Use one under 8 MB.'));
      const r = new FileReader();
      r.onload = () => ok({ name: file.name, data: String(r.result) });
      r.onerror = () => no(new Error('That picture could not be read.'));
      r.readAsDataURL(file);
    });
  }
  /** A button that opens the computer's file picker and hands back the chosen picture. */
  function pictureButton(label, onPicked) {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'hidden-file', 'aria-label': label, onchange: async () => {
      const file = input.files && input.files[0]; input.value = '';
      if (!file) return;
      try { await onPicked(await readPicture(file)); } catch (e) { toast(e.message || String(e), true); }
    } });
    return [input, h('button', { class: 'btn quiet', type: 'button', onclick: () => input.click() }, label)];
  }
  /** Welcome module: design the welcome and goodbye messages, with a live preview drawn the way Discord will get it. */
  const THEME_CHOICES = [['dark', 'Dark'], ['light', 'Light'], ['midnight', 'Midnight'], ['sunset', 'Sunset'], ['forest', 'Forest'], ['ocean', 'Ocean'], ['candy', 'Candy']];
  const HOLES = [['{user}', 'Mention them'], ['{username}', 'Their name'], ['{server}', 'Server name'], ['{count}', 'Member number']];
  /** Discord shows **words** in bold; the preview does the same (and nothing else, so nothing can be injected). */
  function boldWords(text) {
    return String(text).split('**').map((part, i) => (i % 2 ? h('b', {}, part) : part));
  }
  function greetingPicturesCard(g, r) {
    const get = (key) => ((r && r.settings.find((d) => d.key === key)) || {}).value;
    const root = h('div', { class: 'card gdesign-card' });
    let kind = 'welcome';
    const build = async () => {
      const keys = { look: `${kind}Look`, message: `${kind}Message`, title: `${kind}CardTitle`, line: `${kind}CardLine`, accent: `${kind}CardAccent`, theme: `${kind}CardTheme` };
      const v = {}; for (const [f, key] of Object.entries(keys)) v[f] = get(key) ?? '';
      if (!v.look) v.look = 'plain';
      let pics; try { pics = await call('images_view', { guild: g.id }); } catch (e) { root.replaceChildren(h('p', { class: 'msg bad' }, e.message || String(e))); return; }
      const pic = pics[kind];
      const preview = h('div', { class: 'gpreview', 'aria-live': 'polite' });
      let timer = 0;
      const paint = async () => {
        let out; try { out = await call('greeting_preview', { guild: g.id, kind, tried: v }); } catch (e) { preview.replaceChildren(h('p', { class: 'msg bad' }, e.message || String(e))); return; }
        const img = out.image || (v.look === 'plain' && pic.has ? pic.preview : null);
        preview.replaceChildren(
          h('div', { class: 'msgprev', 'aria-label': `How the ${kind} message will look` }, h('b', {}, 'Good Boy ', h('span', { class: 'tagapp' }, 'APP')),
            h('div', { class: 'msgtext' }, out.text ? boldWords(out.text) : h('span', { class: 'muted' }, 'No message written yet')),
            img ? h('img', { class: 'picprev wide', src: img, alt: 'The picture, as it will be sent' }) : null),
          v.look === 'card' && !out.has_picture ? h('p', { class: 'muted small' }, 'No background picture yet, so the card uses its colour theme. Add one to make it yours.') : null);
      };
      const soon = () => { clearTimeout(timer); timer = setTimeout(paint, 250); };
      const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
      const box = (f, max, area, ph) => { const el = area ? h('textarea', { rows: 3, maxlength: max, placeholder: ph || '' }) : h('input', { type: 'text', maxlength: max, placeholder: ph || '' }); el.value = v[f]; el.addEventListener('input', () => { v[f] = el.value; soon(); }); return el; };
      const message = box('message', 1900, true);
      const holes = h('div', { class: 'btns holes' }, HOLES.map(([code, label]) => h('button', { class: 'btn quiet small', type: 'button', title: `Adds ${code}`, onclick: () => { const at = message.selectionStart ?? message.value.length; message.value = message.value.slice(0, at) + code + message.value.slice(message.selectionEnd ?? at); v.message = message.value; message.focus(); message.setSelectionRange(at + code.length, at + code.length); soon(); } }, label)));
      const wheel = h('input', { type: 'color', class: 'colourwheel', value: /^#[0-9a-f]{6}$/i.test(v.accent) ? v.accent : '#6b93ff', 'aria-label': 'Ring and bar colour (picker)' });
      const code = h('input', { type: 'text', class: 'colourcode', maxlength: 7, value: v.accent, placeholder: '#rrggbb', spellcheck: 'false', 'aria-label': 'Ring and bar colour (code)' });
      wheel.addEventListener('input', () => { code.value = v.accent = wheel.value; soon(); });
      code.addEventListener('input', () => { v.accent = code.value; if (/^#[0-9a-f]{6}$/i.test(code.value)) { wheel.value = code.value; soon(); } });
      const theme = h('select', { 'aria-label': 'Colours behind your picture', onchange: (e) => { v.theme = e.target.value; soon(); } }, THEME_CHOICES.map(([id, label]) => h('option', { value: id, selected: id === v.theme }, label)));
      const cardFields = h('div', { class: 'stack', hidden: v.look !== 'card' },
        field('Big words', box('title', 120, false), 'You can use {username}, {server} and {count} here too.'), field('Smaller words', box('line', 160, false)),
        h('div', { class: 'row2' }, field('Ring and bar colour', h('div', { class: 'colourrow' }, wheel, code)), field('Colours behind your picture', theme)));
      const look = h('div', { class: 'seg', role: 'group', 'aria-label': 'Look' }, [['plain', 'Words'], ['card', 'Picture card']].map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(v.look === id), onclick: (e) => { v.look = id; for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); cardFields.hidden = id !== 'card'; soon(); } }, label)));
      const reload = () => build();
      const picture = h('div', { class: 'field' }, h('label', {}, 'Upload a picture'),
        h('p', { class: 'muted small' }, v.look === 'card' ? 'Goes behind the card. PNG, JPG, GIF or WebP under 8 MB.' : 'Sent with the message. PNG, JPG, GIF or WebP under 8 MB. A moving GIF stays moving.'),
        h('div', { class: 'btns' }, ...pictureButton(pic.has ? 'Change picture' : 'Choose a picture', async (f) => { await call('greeting_image_set', { guild: g.id, kind, name: f.name, data: f.data }); toast('Picture saved.'); reload(); }),
          pic.has ? h('button', { class: 'btn quiet', type: 'button', onclick: async () => { try { await call('greeting_image_clear', { guild: g.id, kind }); toast('Picture removed.'); reload(); } catch (e) { toast(e.message || String(e), true); } } }, 'Remove') : null));
      const save = h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, async () => {
        for (const [f, key] of Object.entries(keys)) { const kept = await call('setting_set', { guild: g.id, module: 'member-management', key, value: v[f] }); const d = r.settings.find((x) => x.key === key); if (d) d.value = kept; }
        toast('Saved. New members get this.'); await paint();
      }) }, 'Save');
      const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Which message' }, [['welcome', 'Welcome'], ['goodbye', 'Goodbye']].map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(kind === id), onclick: () => { kind = id; build(); } }, label)));
      root.replaceChildren(h('div', { class: 'row' }, h('h2', {}, 'Welcome and goodbye designer'), tabs),
        h('p', { class: 'muted' }, kind === 'welcome' ? 'What new members get when they join. Change anything and the preview updates. Nothing changes for members until you press Save.' : 'What is posted when someone leaves. Change anything and the preview updates. Nothing changes until you press Save.'),
        h('div', { class: 'gdesign' },
          h('div', { class: 'stack' }, picture, field('Look', look), field('Message', message, 'The words members read above the picture.'), holes, cardFields, h('div', { class: 'btns' }, save)),
          h('div', { class: 'stack' }, h('b', {}, 'Preview'), h('p', { class: 'muted small' }, 'With a sample member called Alex.'), preview)));
      paint();
    };
    build();
    return root;
  }
  /** Eclipse ID module: what it does here, the two switches that matter, and how many people use it. */
  function eclipseCard(g, r) {
    const get = (key) => ((r && r.settings.find((d) => d.key === key)) || {}).value;
    const root = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading…'));
    (async () => {
      let v; try { v = await call('eclipse_view', { guild: g.id }); } catch (e) { root.replaceChildren(h('p', { class: 'msg bad' }, e.message || String(e))); return; }
      const sw = (key, label, hint) => {
        const input = h('input', { type: 'checkbox', class: 'toggle', role: 'switch', checked: !!get(key), 'aria-label': label, onchange: async (e) => {
          try { const kept = await call('setting_set', { guild: g.id, module: 'eclipseid', key, value: e.target.checked }); const d = r.settings.find((x) => x.key === key); if (d) d.value = kept; toast('Saved'); } catch (er) { e.target.checked = !e.target.checked; toast(er.message || String(er), true); }
        } });
        return h('label', { class: 'setting inline' }, h('span', {}, h('b', {}, label), h('br'), h('span', { class: 'muted small' }, hint)), input);
      };
      const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, Number(n).toLocaleString()), h('span', {}, label));
      root.replaceChildren(h('h2', {}, 'Eclipse ID'),
        h('p', { class: 'muted' }, 'A gaming profile each member controls. It is one card per person, the same in every server that runs Good Boy, so members fill it in once. They choose who sees each part and which servers show it.'),
        h('div', { class: 'stats' }, stat(v.cards, 'Cards made'), stat(v.here, 'People seen here'), stat(v.picked, 'With games picked up')),
        sw('autoDetect', 'Pick up what members play', 'Reads the game a member is playing from their Discord status and adds it to their card as "picked up automatically", with the kind of device. Members can switch this off for themselves with /id auto, hide it, or erase it.'),
        v.auto && !v.presence ? h('p', { class: 'note' }, 'Discord is not sending statuses yet, so nothing can be picked up. Turn on "Presence Intent" on your application\'s Bot page in the Discord developer portal, then restart the bot. Servers with 100 or more members also need Discord to approve it.') : null,
        sw('robloxLookup', 'Let /id roblox check a Roblox name', 'Contacts Roblox to see that a username exists. It does not prove the account is theirs.'),
        h('h3', {}, 'What members can do'),
        h('ul', {}, [['/id edit', 'fill in their card'], ['/id privacy', 'choose who sees each part'], ['/id share', 'choose which servers show it'], ['/id auto', 'pick up games, or stop it and forget'], ['/id find', 'find members who play a game'], ['/id export and /id import', 'move the card to another Good Boy with a code']].map(([c, t]) => h('li', {}, h('code', {}, c), ' · ' + t))));
    })();
    return root;
  }
  /** Critters module: the server's own characters, each with its picture. */
  function crittersCard(g) {
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    let v = null;
    const load = async () => {
      try { v = await call('critters_view', { guild: g.id }); } catch (e) { body.replaceChildren(h('p', { class: 'msg bad' }, e.message || String(e))); return; }
      paint();
    };
    const label = (list, id) => (list.find((x) => x[1] === id) || [id, id])[0];
    function form(c) {
      const editing = !!c;
      const name = h('input', { type: 'text', maxlength: 30, value: c ? c.name : '', 'aria-label': 'Name' });
      const type = h('select', { 'aria-label': 'Type' }, v.types.map(([l, val]) => h('option', { value: val, selected: c ? c.element === val : null }, l)));
      const rarity = h('select', { 'aria-label': 'Rarity' }, v.rarities.map(([l, val]) => h('option', { value: val, selected: c ? c.rarity === val : null }, l)));
      const num = (k, l, d) => h('label', { class: 'mini' }, l, h('input', { type: 'number', min: 10, max: 200, value: c ? c[k] : d, 'aria-label': l }));
      const stats = { hp: num('hp', 'Health', 50), atk: num('atk', 'Attack', 50), def: num('def', 'Defense', 50), spd: num('spd', 'Speed', 50) };
      let chosen = null, remove = false;
      const prev = h('div', { class: 'picprev small' });
      const link = h('input', { type: 'url', placeholder: 'or paste a picture link (https://…)', value: c && c.picture && c.picture.kind === 'link' ? c.picture.link : '', 'aria-label': 'Picture link' });
      const showPrev = () => { const src = chosen ? chosen.data : (!remove && c && c.picture ? c.picture.preview : null); prev.replaceChildren(src ? h('img', { src, alt: 'Picture' }) : h('span', { class: 'muted small' }, 'No picture')); };
      showPrev();
      const save = h('button', { class: 'btn', type: 'button', onclick: () => busy(save, async () => {
        const picture = chosen ? 'file' : link.value.trim() && !(c && c.picture && c.picture.kind === 'link' && link.value.trim() === c.picture.link) ? 'link' : remove ? 'remove' : link.value.trim() ? 'keep' : (c && c.picture && c.picture.kind === 'link' ? 'remove' : 'keep');
        const n = (k) => Number(stats[k].querySelector('input').value) || 50;
        const said = await call('critter_save', { guild: g.id, editing: editing ? c.id : null, name: name.value, element: type.value, rarity: rarity.value, hp: n('hp'), atk: n('atk'), def: n('def'), spd: n('spd'), picture, link: link.value.trim(), file_name: chosen ? chosen.name : null, data: chosen ? chosen.data : null });
        toast(String(said).replace(/\*\*/g, '')); await load();
      }) }, editing ? 'Save changes' : 'Add character');
      return h('div', { class: 'card inner' }, h('div', { class: 'field' }, h('label', {}, 'Name'), name), h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', {}, 'Type'), type), h('div', { class: 'field' }, h('label', {}, 'Rarity'), rarity)),
        h('div', { class: 'row4' }, ...Object.values(stats)), h('div', { class: 'field' }, h('label', {}, 'Picture'), prev,
          h('div', { class: 'btns' }, ...pictureButton(chosen || (c && c.picture) ? 'Change picture' : 'Choose a picture', async (f) => { chosen = f; remove = false; showPrev(); }), c && c.picture ? h('button', { class: 'btn quiet', type: 'button', onclick: () => { chosen = null; remove = true; link.value = ''; showPrev(); } }, 'Remove picture') : null), link),
        h('div', { class: 'btns' }, save, h('button', { class: 'btn quiet', type: 'button', onclick: () => paint() }, 'Cancel')));
    }
    function paint() {
      const slot = h('div', { class: 'stack' });
      const add = h('button', { class: 'btn', type: 'button', onclick: () => { slot.replaceChildren(form(null)); add.hidden = true; } }, 'Add a character');
      body.replaceChildren(
        v.characters.length ? h('div', { class: 'list' }, v.characters.map((c) => h('div', { class: 'case' }, c.picture ? h('img', { class: 'thumb', src: c.picture.preview, alt: '' }) : h('div', { class: 'thumb none' }, '?'),
          h('div', { class: 'text' }, h('b', {}, c.name), h('p', { class: 'muted small' }, `${label(v.types, c.element)} · ${label(v.rarities, c.rarity)} · ❤️ ${c.hp} ⚔️ ${c.atk} 🛡️ ${c.def} 💨 ${c.spd}`)),
          h('div', { class: 'btns' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => { slot.replaceChildren(form(c)); add.hidden = true; } }, 'Edit'),
            (() => { const del = h('button', { class: 'btn danger', type: 'button', onclick: () => confirmInline(del, `Remove ${c.name}? Critters people already caught stay theirs.`, 'Remove', async () => { try { toast(String(await call('critter_remove', { guild: g.id, id: c.id })).replace(/\*\*/g, '')); await load(); } catch (e) { toast(e.message || String(e), true); } }) }, 'Remove'); return del; })()))))
          : h('p', { class: 'muted' }, 'No characters yet. Wild critters can only appear once you add some.'), slot, add);
    }
    load();
    return h('div', { class: 'card' }, h('h2', {}, 'Characters'), h('p', { class: 'muted' }, 'The characters that appear while people chat. Each can have a picture from your computer or a link.'), body);
  }
  function modulePage(g, m) {
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    const bar = h('div', { class: 'seg modtabs', role: 'tablist' });
    const head = h('div', { class: 'card mhead' }, h('span', { class: 'ticon big', 'data-cat': String(MOD_CAT[m.id] ?? 9), 'aria-hidden': 'true' }, MOD_ICON[m.id] || '◆'),
      h('div', { class: 'grow' }, h('h1', {}, m.name), h('p', { class: 'muted' }, m.about)), modStatus(m), moduleSwitch(g, m, () => draw()));
    call('settings', { guild: g.id, module: m.id }).then((r) => {
      const tabs = [['setup', 'Setup'], ['settings', 'Settings'], ['advanced', 'Advanced'], ['where', 'Where it works'], ['who', 'Who can use it'], ['commands', m.commands.length ? 'Commands' : 'About'], ['history', 'History']]
        .filter(([k]) => k === 'commands' || k === 'where' || k === 'history' || (k === 'who' ? (r.permissions || []).length : r.settings.some((d) => TAB_OF(d.kind) === k)));
      S.modTab = tabs.some(([k]) => k === S.modTab) ? S.modTab : tabs[0][0];
      bar.replaceChildren(...tabs.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.modTab === k), onclick: (e) => { S.modTab = k; for (const b of bar.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); tab(); } }, l)));
      function tab() {
        if (S.modTab === 'where') { body.replaceChildren(whereCard(g, m, r)); return; }
        if (S.modTab === 'who') { body.replaceChildren(whoCard(g, m, r)); return; }
        if (S.modTab === 'history') { body.replaceChildren(historyCard(g, m)); return; }
        if (S.modTab === 'commands') {
          body.replaceChildren(h('div', { class: 'card' }, m.commands.length ? m.commands.map((c) => h('div', { class: 'cmdrow' }, h('code', {}, `/${c.name}`), h('div', {}, h('div', {}, c.about), c.subs.length ? h('div', { class: 'muted small' }, c.subs.join(' · ')) : null)))
            : h('p', { class: 'muted' }, 'This module has no commands of its own.')));
          return;
        }
        const intro = { setup: 'The channels and roles this module uses.', settings: 'Switches and choices.', advanced: 'Numbers, lists and text you can fine-tune.' }[S.modTab];
        const part = { ...r, settings: r.settings.filter((d) => TAB_OF(d.kind) === S.modTab && !(m.id === 'member-management' && /^(welcome|goodbye)(Look|Message|Image|Card[A-Za-z]*)$/.test(d.key)) && !(m.id === 'eclipseid' && /^(autoDetect|robloxLookup)$/.test(d.key))) };
        body.replaceChildren(...(S.modTab === 'setup' && PANELS[m.id] ? [panelCard(g, m, r)] : []), ...(S.modTab === 'setup' && m.id === 'member-management' ? [greetingPicturesCard(g, r)] : []), ...(S.modTab === 'setup' && m.id === 'critters' ? [crittersCard(g)] : []), ...((S.modTab === 'setup' || S.modTab === 'settings') && m.id === 'eclipseid' ? [eclipseCard(g, r)] : []), ...(m.id === 'economy' && S.modTab === 'settings' ? [resetZone(g)] : []), h('div', { class: 'card' }, h('p', { class: 'muted' }, intro), ...grouped(g.id, m.id, part)));
      }
      tab();
    }, (e) => body.replaceChildren(h('p', { class: 'msg bad' }, e.message)));
    return [h('button', { type: 'button', class: 'btn quiet back', onclick: () => { S.open = null; draw(); } }, '‹ All modules'), head,
      m.on ? null : h('div', { class: 'card note' }, `${m.name} is off. You can change its settings now; they apply when you turn it on.`), bar, body].filter(Boolean);
  }
  function secretCard({ title, about, saved, add, replace, placeholder, kind, onSave, onTest, onForget, forgetAsk, steps }) {
    const slot = h('div', { class: 'stack', hidden: true });
    const openForm = () => {
      const input = h('input', { type: 'password', id: `in-${kind}`, autocomplete: 'off', spellcheck: 'false', placeholder });
      slot.replaceChildren(h('div', { class: 'field' }, h('label', { for: `in-${kind}` }, saved ? `New ${kind}` : title), input),
        h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, async () => { await onSave(input.value); input.value = ''; await refresh(); draw(); }) }, kind === 'token' ? 'Check and save' : 'Save'),
          h('button', { class: 'btn quiet', type: 'button', onclick: () => { input.value = ''; slot.hidden = true; } }, 'Cancel')));
      slot.hidden = false; input.focus();
    };
    const forget = h('button', { class: 'btn danger', type: 'button', onclick: () => confirmInline(forget, forgetAsk, 'Remove', async () => { await onForget(); await refresh(); draw(); }) }, `Remove ${kind}`);
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'text' }, h('h2', {}, title), h('p', { class: 'muted' }, about)), h('span', { class: saved ? 'pill good' : 'pill' }, saved ? 'Saved' : 'Not added')),
      h('div', { class: 'btns' }, h('button', { class: saved ? 'btn quiet' : 'btn', type: 'button', onclick: openForm }, saved ? replace : add),
        saved && onTest ? h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, onTest) }, 'Test connection') : null,
        h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.topic = steps; go('help'); } }, 'How to get it'),
        saved ? forget : null),
      slot);
  }
  /** Extra bots that only play music, so several channels can have music at once. */
  function musicBotsCard() {
    const list = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Loading…'));
    const input = h('input', { type: 'password', id: 'in-musicbot', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the new music bot\'s token here' });
    const load = async () => {
      try {
        const r = await call('helpers_list');
        if (!r.helpers.length) { list.replaceChildren(h('p', { class: 'muted small' }, 'No extra music bots yet. Each one you add can play in its own voice channel at the same time.')); return; }
        list.replaceChildren(...r.helpers.map((b) => h('div', { class: 'row' },
          h('div', {}, h('b', {}, b.name), b.problem ? h('p', { class: 'msg bad small' }, b.problem) : h('p', { class: 'muted small' }, 'Add it to a server with this link, then it joins by itself:'), b.invite ? h('a', { href: b.invite, target: '_blank', rel: 'noopener', class: 'small' }, 'Add ' + b.name + ' to a server') : null),
          h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, async () => { if (!confirm('Remove ' + b.name + ' from Good Boy? It stays on Discord; only its token is forgotten here.')) return; await call('helper_remove', { slot: b.slot }); toast('Removed.'); await load(); }) }, 'Remove'))));
      } catch (e) { list.replaceChildren(h('p', { class: 'msg bad' }, e.message)); }
    };
    load();
    return h('div', { class: 'card' }, h('h2', {}, 'Music bots'),
      h('p', { class: 'muted' }, 'Make another bot on Discord\'s developer page (no special settings), paste its token here, then add it to your servers. With more music bots, each voice channel can have its own music at once.'),
      list,
      h('div', { class: 'field' }, h('label', { for: 'in-musicbot' }, 'New music bot\'s token'), input),
      h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, async () => { const r = await call('helper_add', { token: input.value }); input.value = ''; toast(r.restarted ? `${r.name} added. Good Boy restarted so it can join.` : `${r.name} added.`); await load(); }) }, 'Check and add')));
  }
  function pageSwitch() {
    const box = h('div', { class: 'stack big' });
    let st = null, checked = null;
    S.swOk = S.swOk || { stopped: false, token: false };
    async function load() { st = await call('v3_status'); paint(); }
    const step = (n, title, ...kids) => h('div', { class: 'card pad' }, h('h2', {}, `${n}. ${title}`), ...kids);
    const tile = (n, l) => h('div', { class: 'stat' }, h('b', {}, (n ?? 0).toLocaleString()), h('span', {}, l));
    function paint() {
      const tick = (key, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.swOk[key], onchange: (e) => { S.swOk[key] = e.target.checked; paint(); } }), ` ${label}`);
      const ready = S.swOk.stopped && S.swOk.token && !st.running;
      let asked = false;
      box.replaceChildren(...[
        h('div', { class: 'stats' }, tile(st.v3?.servers, 'Servers in Good Boy 3'), tile(st.v3?.records, 'Saved records in Good Boy 3'), tile(st.v4?.servers, 'Servers in Good Boy 4'), tile(st.v4?.records, 'Saved records in Good Boy 4')),
        h('div', { class: 'card pad' }, h('h2', {}, st.found ? 'Where Good Boy 3\'s data is' : 'Good Boy 3\'s data was not found'),
          st.found ? h('p', { class: 'muted small' }, st.folder) : h('p', { class: 'muted' }, `Looked in ${st.looked_in || 'the usual place'}. If Good Boy 3 keeps its data somewhere else, paste the folder that holds the file eclipse.db (it is usually called bot-data).`),
          (() => { const inp = h('input', { type: 'text', placeholder: 'C:\\Users\\you\\AppData\\Roaming\\Good Boy\\bot-data', spellcheck: 'false', style: { width: '100%' } });
            return h('div', { class: 'field' }, h('label', {}, st.found ? 'Use a different folder' : 'Folder with eclipse.db'), inp, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { st = await call('v3_folder_set', { path: inp.value }); toast('Found it.'); paint(); }) }, 'Use this folder'))); })()),
        step(1, 'Copy your Good Boy 3 data', h('p', { class: 'muted' }, 'This only reads Good Boy 3\'s data; nothing there is changed, and Good Boy 3 keeps working. Copy again any time to bring in what happened since. Whatever Good Boy 4 has now is set aside in a dated folder, never deleted.'),
          st.running ? h('p', { class: 'note warn' }, 'Good Boy 4 is running. Stop it on Home first.') : null,
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', disabled: !st.found || st.running, onclick: (e) => {
            const b = e.currentTarget;
            if (st.v4 && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Set my current copy aside and copy again?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Copy my Good Boy 3 data again'; }, 6000); return; }
            busy(b, async () => { const r = await call('v3_recopy'); checked = null; toast(r.kept ? `Copied. The previous copy is kept in ${r.kept}` : 'Copied.'); await load(); });
          } }, st.v4 ? 'Copy my Good Boy 3 data again' : 'Copy my Good Boy 3 data'))),
        step(2, 'Check the copy', h('p', { class: 'muted' }, 'Compares every table in Good Boy 3 with the copy. More rows in the copy is fine (new activity). Fewer or missing means something did not carry across.'),
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', disabled: !st.v4 || !st.found, onclick: (e) => busy(e.currentTarget, async () => { checked = await call('v3_check'); paint(); }) }, 'Check the copy')),
          checked ? [h('p', { class: checked.problems || !checked.v3_ok || !checked.v4_ok ? 'msg bad' : 'msg good' }, !checked.v3_ok || !checked.v4_ok ? 'One of the databases did not pass its own integrity check. Do not switch yet.' : checked.problems ? `${plural(checked.problems, 'table has', 'tables have')} fewer rows than Good Boy 3 (listed below).` : `Everything from Good Boy 3 is in the copy (${plural(checked.rows.length, 'table', 'tables')} checked).`),
            checked.rows.some((r) => r.state !== 'same') ? h('div', { class: 'list' }, checked.rows.filter((r) => r.state !== 'same').map((r) => h('div', { class: 'case' }, h('div', { class: 'text' }, h('b', {}, r.table), h('p', { class: 'muted small' }, `Good Boy 3: ${r.v3.toLocaleString()} · Good Boy 4: ${r.v4 == null ? 'missing' : r.v4.toLocaleString()} · ${{ fewer: 'fewer in the copy', missing: 'not in the copy', more: 'more in the copy (new activity)' }[r.state]}`))))) : null] : null),
        step(3, 'Switch over', h('p', { class: 'muted' }, 'Two programs must never run the same bot at once: members would get every answer twice. Tick both, then start.'),
          tick('stopped', 'Good Boy 3 is closed completely (not just minimised).'), tick('token', 'Settings has the token of the bot I want Good Boy 4 to be.'),
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', disabled: !ready, onclick: (e) => busy(e.currentTarget, async () => { await call('bot_start'); toast('Good Boy 4 is starting. Watch Home for the green light.'); await refresh(); await load(); }) }, st.running ? 'Good Boy 4 is running' : 'Start Good Boy 4 now'))),
        step(4, 'Going back to Good Boy 3', h('p', { class: 'muted' }, 'Stop Good Boy 4 on Home, close this app, and open Good Boy 3 again. Its data was never changed, so it carries on where it was. Anything members earned or did while Good Boy 4 was running stays in Good Boy 4\'s copy and will not appear in Good Boy 3.'))].filter(Boolean));
      void asked;
    }
    load().catch((e) => box.replaceChildren(h('div', { class: 'card note' }, e.message || String(e))));
    return [h('div', { class: 'head' }, h('h1', {}, 'From Good Boy 3'), h('p', { class: 'muted' }, 'Try Good Boy 4 on a copy of your data, check it, and switch when you are happy. You can always go back.')), box];
  }

  // ---- Check-up: what would stop the bot working, in plain words
  function pageCheckup() {
    const box = h('div', { class: 'stack big' });
    async function run(btn) {
      const r = await call('health');
      const dot = { good: 'on', warn: 'warn', bad: 'off' };
      box.replaceChildren(h('div', { class: r.bad ? 'card note warn' : 'card note' }, r.bad ? `${plural(r.bad, 'thing needs', 'things need')} fixing before the bot will work properly.` : r.warn ? `Nothing is broken. ${plural(r.warn, 'thing is', 'things are')} worth a look.` : 'Everything looks fine.'),
        h('div', { class: 'card' }, h('div', { class: 'list' }, r.checks.map((c) => h('div', { class: 'case' }, h('span', { class: `dot ${dot[c.level] || ''}`, style: { flex: '0 0 auto' } }), h('div', { class: 'text' }, h('b', {}, c.title), h('p', { class: 'muted small' }, c.detail)))))));
    }
    const go = h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, () => run(e.currentTarget)) }, 'Run the check-up');
    setTimeout(() => go.click(), 0);
    return [h('div', { class: 'head' }, h('h1', {}, 'Check-up'), h('p', { class: 'muted' }, 'Looks at the token, the connection, your data, each server\'s modules and the permissions the bot has there. Press it again after you change something.')), go, box];
  }

  // ---- Phone and web: the same dashboard in a browser and as an app on iPhone and Android
  /** The licence (the same keys Good Boy 3 uses): who it is for, what it unlocks, paste or remove one. */
  /** The bot's name, picture, banner and description on Discord. Free: the Good Boy look, kept in place. Licence: your own. */
  function brandCard() {
    const slot = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Looking at your bot…'));
    const card = h('div', { class: 'card' }, h('h2', {}, 'Bot name, picture and banner'), slot);
    const WORDS = { avatar: 'profile picture', banner: 'banner', name: 'name', icon: 'app icon', description: 'description' };
    const read = (input) => new Promise((resolve, reject) => {
      const f = input.files && input.files[0];
      if (!f) return resolve(undefined);
      if (f.size > 8 * 1024 * 1024) return reject(new Error('That picture is too big. Discord takes up to 8 MB.'));
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('That picture could not be read.'));
      r.readAsDataURL(f);
    });
    (async () => {
      let st;
      try { st = await call('brand_status'); } catch (e) { slot.replaceChildren(h('p', { class: 'muted' }, e.message || String(e))); return; }
      if (!st.licensed) {
        const say = (r) => {
          const bad = Object.entries(r.problems || {});
          toast(bad.length ? bad.map(([k, v]) => `${WORDS[k] || k}: ${v}`).join(' ') : r.changed.length ? `Put back: ${r.changed.map((k) => WORDS[k] || k).join(', ')}.` : 'Everything is already in place.', bad.length > 0);
        };
        slot.replaceChildren(
          h('p', {}, st.done ? 'Your bot wears the Good Boy look.' : `Not in place yet: ${st.missing.map((k) => WORDS[k] || k).join(', ')}. Good Boy puts it back by itself in the background.`),
          h('p', { class: 'muted small' }, 'A licence lets you use your own name, picture, banner and description instead.'),
          h('div', { class: 'btns' },
            h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, async () => { say(await call('brand_keep', {})); await refresh(); draw(); }) }, 'Check and put back now'),
            h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, async () => { say(await call('brand_keep', { force: true })); }) }, 'Set everything again')));
        return;
      }
      const name = h('input', { type: 'text', id: 'brandname', maxlength: 32, value: st.name || '', 'aria-label': 'Bot name' });
      const about = h('textarea', { id: 'branddesc', rows: 4, maxlength: 400, 'aria-label': 'Description' }, (st.description || '').replace(/\n*Good Boy v\S+ · Basic Ghost Labs\s*$/, ''));
      const pic = h('input', { type: 'file', id: 'brandpic', accept: 'image/png,image/jpeg,image/gif', 'aria-label': 'Profile picture' });
      const ban = h('input', { type: 'file', id: 'brandban', accept: 'image/png,image/jpeg,image/gif', 'aria-label': 'Banner' });
      slot.replaceChildren(
        h('p', { class: 'muted' }, 'Your licence lets you choose how your bot looks on Discord. Leave a picture empty to keep the one it has. A short "Good Boy" credit line stays at the end of the description.'),
        h('div', { class: 'field' }, h('label', { for: 'brandname' }, 'Name (2 to 32 characters)'), name),
        h('div', { class: 'field' }, h('label', { for: 'brandpic' }, 'Profile picture (PNG, JPG or GIF)'), pic),
        h('div', { class: 'field' }, h('label', { for: 'brandban' }, 'Banner (about 680 × 240)'), ban),
        h('div', { class: 'field' }, h('label', { for: 'branddesc' }, 'Description'), about),
        h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, async () => {
          try { await call('brand_custom', { name: name.value, description: about.value, image: await read(pic), banner: await read(ban) }); toast('Saved. Discord can take a minute to show it.'); pic.value = ''; ban.value = ''; }
          catch (er) { toast(er.message || String(er), true); }
        }) }, 'Save')));
    })();
    return card;
  }
  function licenceCard() {
    const l = S.o.licence || { has_key: false };
    const box = h('input', { type: 'text', id: 'licencekey', placeholder: 'Paste your licence key (GB1.…)', 'aria-label': 'Licence key', autocomplete: 'off', spellcheck: 'false' });
    const save = async (key, msg) => { try { await call('licence_set', { key }); await refresh(); draw(); toast(msg); } catch (e) { toast(e.message, true); } };
    const ends = l.ends ? new Date(l.ends).toLocaleDateString() : 'never';
    const status = !l.has_key ? h('p', { class: 'muted' }, 'No licence. Everything works; a licence adds your own name, picture and banner for the bot.')
      : l.ok ? h('p', {}, h('b', {}, 'Licence active'), l.to ? ` for ${l.to}` : '', ` · ends ${ends} · unlocks ${l.features.join(', ') || 'nothing'}`)
      : h('p', { class: 'warn' }, l.error || 'This licence does not work.');
    return h('div', { class: 'card' }, h('h2', {}, 'Licence'), status,
      h('p', { class: 'muted small' }, 'A licence from Good Boy 3 carries over by itself because the bot and its token stay the same.'),
      h('div', { class: 'btns' }, box,
        h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, () => save(box.value, 'Licence saved.')) }, 'Save'),
        ...(l.has_key ? [h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, () => save('', 'Licence removed.')) }, 'Remove')] : []),
        h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, async () => { try { await call('licence_refresh'); await refresh(); draw(); toast('Checked for cancelled licences.'); } catch (err) { toast(err.message, true); } }) }, 'Check cancelled list')));
  }

  function webCard() {
    const o = S.o, w = o.web_status || {}, p = o.prefs;
    const save = async (patch, msg) => { try { await call('prefs_set', { patch }); await refresh(); draw(); if (msg) toast(msg); } catch (e) { toast(e.message, true); } };
    const addr = h('input', { type: 'text', id: 'webaddr', value: p.web_address || '', placeholder: 'https://dash.example.com', spellcheck: 'false', autocomplete: 'off' });
    const port = h('input', { type: 'number', id: 'webport', min: 1024, max: 65535, value: p.web_port || 47890 });
    return h('div', { class: 'card' }, h('h2', {}, 'Phone and web'),
      h('p', { class: 'muted' }, 'Opens this same dashboard in a browser and as an app on iPhone and Android. People sign in with Discord: you, and anyone with Manage Server in a server the bot is in (they only see their own servers).'),
      h('div', { class: 'list' },
        h('div', {}, h('label', { for: 'webon' }, 'Switch the web app on'), h('input', { type: 'checkbox', class: 'toggle', role: 'switch', id: 'webon', checked: p.web_on ? true : null, onchange: (e) => save({ web_on: e.target.checked }, e.target.checked ? 'Switched on.' : 'Switched off.') })),
        h('div', { class: 'field' }, h('label', { for: 'webaddr' }, 'The link people will open'), addr, h('span', { class: 'hint' }, 'The public https address that leads to this computer or web host, for example the one Tailscale Funnel or Cloudflare Tunnel gives you.')),
        h('div', { class: 'field' }, h('label', { for: 'webport' }, 'Port on this computer'), port),
        h('div', {}, h('label', { for: 'weball' }, 'Listen to the whole network (turn on for a web host)'), h('input', { type: 'checkbox', class: 'toggle', role: 'switch', id: 'weball', checked: p.web_all ? true : null, onchange: (e) => save({ web_all: e.target.checked }) })),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await save({ web_address: addr.value, web_port: Number(port.value) }, 'Saved.'); }) }, 'Save'))),
      w.on ? (w.error ? h('p', { class: 'msg bad' }, w.error) : h('p', { class: w.running ? 'msg good' : 'msg' }, w.running ? `Running at ${p.web_address} (port ${w.port}).` : 'Starting…')) : h('p', { class: 'muted small' }, 'Switched off.'),
      h('details', { class: 'small' }, h('summary', {}, 'How to set it up'),
        h('ol', { class: 'howto' },
          h('li', {}, 'Make a public https link that leads to this computer\'s port (above). With Tailscale Funnel: run  tailscale funnel ' + (p.web_port || 47890) + '  and use the address it prints.'),
          h('li', {}, 'In the Discord Developer Portal open your bot, then OAuth2, and under Redirects add the link followed by /auth/callback (for example https://dash.example.com/auth/callback). Save.'),
          h('li', {}, 'Make sure the client secret is saved above in Settings.'),
          h('li', {}, 'Open the link on your phone and sign in with Discord.'),
          h('li', {}, 'iPhone: in Safari press Share, then Add to Home Screen. Android: in Chrome press the menu, then Install app (or Add to Home screen).'))));
  }

  function pageBot() {
    const o = S.o;
    const seg = (value, label) => h('button', { class: 'seg', type: 'button', 'aria-pressed': String(o.prefs.theme === value), onclick: async () => { try { await call('prefs_set', { patch: { theme: value } }); await refresh(); draw(); } catch (e) { toast(e.message, true); } } }, label);
    return [
      h('div', { class: 'head' }, h('h1', {}, 'Settings'), h('p', { class: 'muted' }, `Your bot's keys are kept in ${o.secret_store}. This app never shows them again once saved.`)),
      secretCard({ title: 'Bot token', kind: 'token', saved: o.token_saved, add: 'Add token', replace: 'Replace token', placeholder: 'Paste the token here', steps: o.token_saved ? 'reset' : 'token',
        about: 'The bot\'s password. Good Boy needs it to connect to Discord.',
        onSave: async (token) => { const who = await call('token_save', { token }); toast(who.restarted ? `Saved. ${who.name} restarted on the new token.` : `Saved. Discord recognises it as ${who.name}.`); },
        onTest: async () => { const who = await call('token_test', {}); toast(`The saved token works. It belongs to ${who.name}.`); },
        onForget: async () => { await call('token_forget'); toast('The token was removed and the bot was stopped.'); },
        forgetAsk: 'This stops the bot. Your data stays.' }),
      secretCard({ title: 'Client secret', kind: 'client secret', saved: o.secret_saved, add: 'Add client secret', replace: 'Replace client secret', placeholder: 'Paste the client secret here', steps: 'secret',
        about: 'Used for signing in with Discord on the phone and web dashboard. The bot runs without it.',
        onSave: async (secret) => { await call('secret_save', { secret }); toast('The client secret was saved.'); },
        onForget: async () => { await call('secret_forget'); toast('The client secret was removed.'); },
        forgetAsk: 'Remove the saved client secret?' }),
      musicBotsCard(),
      licenceCard(),
      brandCard(),
      webCard(),
      h('div', { class: 'card' }, h('h2', {}, 'This app'),
        h('div', { class: 'list' },
          h('div', {}, h('label', { for: 'autostart' }, 'Start the bot when this app opens'), h('input', { type: 'checkbox', class: 'toggle', role: 'switch', id: 'autostart', checked: o.prefs.start_with_app, onchange: async (e) => { try { await call('prefs_set', { patch: { start_with_app: e.target.checked } }); await refresh(); } catch (err) { toast(err.message, true); } } })),
          h('div', { class: 'setting' }, h('label', { for: 'dismiss' }, 'Private messages go away'), h('select', { id: 'dismiss', onchange: async (e) => { try { await call('prefs_set', { patch: { private_dismiss_seconds: Number(e.target.value) } }); await refresh(); toast('Saved'); } catch (err) { toast(err.message, true); } } },
            [[0, 'Never (they stay until Discord clears them)'], [60, 'After 1 minute of nobody touching them'], [120, 'After 2 minutes'], [180, 'After 3 minutes'], [300, 'After 5 minutes (the default)'], [600, 'After 10 minutes']].map(([v, l]) => h('option', { value: v, selected: Number(o.prefs.private_dismiss_seconds ?? 180) === v }, l))),
            h('p', { class: 'muted small' }, 'Replies only the member can see (balance, forms, lists, game windows) are taken down after this long without anyone pressing anything on them. Pressing a button starts the wait again, and game windows have a Close button. Exports and transcripts stay.')),
          h('div', {}, h('span', {}, 'Look'), h('div', { class: 'segs', role: 'group', 'aria-label': 'Look' }, ...[['pixel', 'Pixel'], ['classic', 'Classic']].map(([v, l]) => h('button', { class: 'seg', type: 'button', 'aria-pressed': String((document.documentElement.dataset.look || 'pixel') === v), onclick: () => { try { localStorage.setItem('gb-look', v); } catch { /* not kept */ } document.documentElement.dataset.look = v; draw(); } }, l)))),
          h('div', {}, h('span', {}, 'Colours (classic look)'), h('div', { class: 'segs', role: 'group', 'aria-label': 'Colours' }, seg('system', 'Match Windows'), seg('dark', 'Dark'), seg('light', 'Light'))))),
      h('div', { class: 'card' }, h('h2', {}, 'Your data'), h('p', { class: 'muted small path' }, o.data_folder),
        h('div', { class: 'btns' }, h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, () => call('open', { what: 'data' })) }, 'Open folder'),
          h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, async () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); const file = await call('backup_now', { stamp: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` }); toast(`Backed up to ${file}`); }) }, 'Back up now'),
          !window.GB.web ? h('button', { class: 'btn quiet', type: 'button', title: 'Use this if Good Boy 4 shows old levels or coins instead of what Good Boy 3 had', onclick: (e) => confirmInline(e.currentTarget, 'This puts Good Boy 3\'s data here in place of what this app holds now. What is here now is kept in a dated folder, not deleted. The bot is stopped for a moment.', 'Copy it again', async () => {
            try { await call('bot_stop'); } catch { /* not running */ }
            try { const r = await call('v3_recopy'); toast(r.kept ? `Copied Good Boy 3's data. The old data is kept in ${r.kept}` : 'Copied Good Boy 3\'s data.'); } catch (err) { toast(err.message || String(err), true); }
            try { await call('bot_start'); } catch { /* the Home page says why */ }
            await refresh(); draw();
          }) }, 'Copy Good Boy 3\'s data again') : null,
          h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.topic = 'data'; go('help'); } }, 'About backups'))),
    ];
  }

  /** What changed in this version, from the change notes that come with the program. */
  /** Updates: what is installed, whether a newer Good Boy 4 is out, and one button to install it. */
  function pageUpdates() {
    const box = h('div', { class: 'stack' });
    const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
    const paint = () => {
      const u = S.upd || {};
      const a = u.available;
      const can = !window.GB.web && u.can_install;
      const bar = u.percent != null ? h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(u.percent), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { style: `width:${u.percent}%` })) : null;
      const install = (e) => busy(e.target, async () => {
        S.upd = { ...u, percent: 0 }; paint();
        const t = setInterval(async () => { try { S.upd = await call('update_status'); paint(); } catch { /* closing */ } }, 600);
        try { await call('update_install'); toast('Updated. Good Boy is restarting.'); }
        catch (err) { toast(err.message || String(err), true); }
        finally { clearInterval(t); try { S.upd = await call('update_status'); } catch { /* closed */ } paint(); }
      });
      box.replaceChildren(
        h('div', { class: 'card' },
          h('h2', {}, a ? `Good Boy ${a.version} is ready` : 'Good Boy is up to date'),
          h('p', { class: 'muted' }, a ? `You have ${u.current}. The update is ${mb(a.size)}, is checked against a checksum before it is used, and keeps your settings, data and token.` : `You have the newest version (${u.current}).`),
          a && a.notes ? h('details', {}, h('summary', {}, 'What is in it'), h('pre', { class: 'small' }, a.notes.replace(/\*\*(.+?)\*\*/g, '$1'))) : null,
          bar,
          h('div', { class: 'btns' },
            a && can ? h('button', { class: 'btn', type: 'button', disabled: u.percent != null, onclick: install }, 'Update now') : null,
            h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.target, async () => { try { S.upd = await call('update_check'); } catch (err) { toast(err.message || String(err), true); } paint(); }) }, 'Check again')),
          a && !can ? h('p', { class: 'muted small' }, window.GB.web ? 'To update, open Good Boy on the computer that runs the bot and press Update now there.' : 'This is a development build and does not update itself.') : null,
          a && can ? h('p', { class: 'muted small' }, 'The bot is stopped for a moment while it updates, and starts again by itself.') : null),
        h('p', { class: 'muted small' }, 'Good Boy looks for updates by itself a little after it opens, then every six hours.'));
    };
    paint();
    call('update_check').then((r) => { S.upd = r; paint(); }, () => { /* the last answer stays */ });
    return [h('div', { class: 'head' }, h('h1', {}, 'Updates'), h('p', { class: 'muted' }, 'Keep Good Boy 4 current without downloading anything.')), box];
  }
  function pageWhatsNew() {
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    call('whatsnew').then((r) => {
      const line = (t) => /^\s*[-*] /.test(t) ? h('li', {}, t.replace(/^\s*[-*] /, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')) : null;
      box.replaceChildren(...r.sections.map((s, i) => h('details', { class: 'card', open: i < 3 }, h('summary', {}, h('b', {}, s.title)),
        h('ul', {}, s.body.split('\n').map(line).filter(Boolean)))));
    }, (e) => box.replaceChildren(h('p', { class: 'msg bad' }, e.message || String(e))));
    return [h('div', { class: 'head' }, h('h1', {}, "What's new"), h('p', { class: 'muted' }, `Good Boy ${(S.o && S.o.version) || ''} and what came with each update`)), box];
  }
  /** The Commands guide: every command, its parts and what each box takes, written from the bot's own list. */
  function commandsGuide() {
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    const paint = (ref) => {
      const q = (S.cfind || '').trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hay = (c) => JSON.stringify([c.name, c.path, c.about, c.note, c.subs.map((x) => [x.name, x.about]), c.options.map((o) => o.name)]).toLowerCase();
      const opts = (list) => list.length ? h('ul', { class: 'cmdopts' }, list.map((o) => h('li', {}, h('code', {}, o.name), o.required ? '' : ' (optional)', ' · ', o.takes, h('span', { class: 'muted' }, ' — ' + o.about)))) : null;
      const card = (c) => h('details', { class: 'cmd', open: words.length > 0 && ref.count < 8 || null },
        h('summary', {}, h('code', {}, c.path), ' ', h('span', { class: 'muted' }, c.about), c.staff ? h('span', { class: 'tag' }, 'Staff') : null),
        c.note ? h('p', {}, c.note) : null, opts(c.options),
        c.subs.length ? h('div', {}, h('b', {}, 'Parts'), h('ul', { class: 'cmdsubs' }, c.subs.map((x) => h('li', {}, h('code', {}, x.name), ' · ', x.about, x.staff ? h('span', { class: 'tag' }, 'Staff') : null, opts(x.options))))) : null);
      const sections = ref.modules.map((m) => ({ m, list: m.commands.filter((c) => words.every((w) => hay(c).includes(w) || m.name.toLowerCase().includes(w))) })).filter((x) => x.list.length);
      ref.count = sections.reduce((n, x) => n + x.list.length, 0);
      box.replaceChildren(h('p', { class: 'muted small' }, `${ref.count} ${ref.count === 1 ? "command" : "commands"}. In Discord, type /help command: and a name to see the same thing. Commands inside a group (like /server) are opened from the group's menu.`),
        ...(sections.length ? sections.map(({ m, list }) => h('div', { class: 'card' }, h('h3', {}, m.name), h('p', { class: 'muted small' }, m.about), h('div', { class: 'stack' }, list.map(card)))) : [h('div', { class: 'card empty' }, h('h2', {}, 'Nothing matches that'), h('p', { class: 'muted' }, 'Try a command name or a word like "ban" or "picture".'))]));
    };
    const search = h('input', { type: 'search', id: 'cfind', value: S.cfind || '', placeholder: 'Find a command, e.g. ban, picture, music', 'aria-label': 'Find a command' });
    (async () => { try { S.cref = S.cref || await call('commands_guide'); paint(S.cref); } catch (e) { box.replaceChildren(h('p', { class: 'msg bad' }, e.message || String(e))); } })();
    search.addEventListener('input', () => { S.cfind = search.value; if (S.cref) paint(S.cref); });
    return [h('div', { class: 'field' }, search), box];
  }
  function pageHelp() {
    const guide = window.GBGuide;
    const textOf = (t) => (t.title + ' ' + t.blocks.map((b) => (Array.isArray(b[1]) ? b[1].join(' ') : b[1])).join(' ')).toLowerCase();
    const q = S.find.trim().toLowerCase();
    const words = q.split(/\s+/);
    // topics whose title has the words come first
    const hits = q ? guide.filter((t) => words.every((w) => textOf(t).includes(w))).sort((a, b) => words.filter((w) => b.title.toLowerCase().includes(w)).length - words.filter((w) => a.title.toLowerCase().includes(w)).length) : guide;
    const topic = (!q && hits.find((t) => t.id === S.topic)) || hits.find((t) => t.id === S.picked) || hits[0];
    const block = (b) => b[0] === 'p' ? h('p', {}, b[1]) : b[0] === 'h' ? h('h3', {}, b[1]) : b[0] === 'steps' ? h('ol', {}, b[1].map((x) => h('li', {}, x))) : b[0] === 'list' ? h('ul', {}, b[1].map((x) => h('li', {}, x)))
      : b[0] === 'note' ? h('p', { class: 'note' }, b[1]) : h('div', {}, h('button', { class: 'btn quiet', type: 'button', onclick: () => go(b[2]) }, b[1]));
    const search = h('input', { type: 'search', id: 'find', value: S.find, placeholder: 'Search the guide, e.g. reset token', 'aria-label': 'Search the guide' });
    search.addEventListener('input', () => { S.find = search.value; S.picked = null; const at = search.selectionStart; draw(); const again = document.getElementById('find'); again.focus(); again.setSelectionRange(at, at); });
    const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Help section' }, [['guide', 'Guide'], ['commands', 'Commands']].map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String((S.helpTab || 'guide') === id), onclick: () => { S.helpTab = id; draw(); } }, label)));
    if (S.helpTab === 'commands') return [h('div', { class: 'row' }, h('div', { class: 'head' }, h('h1', {}, 'Help'), h('p', { class: 'muted' }, 'Every command, what its parts do and what each box takes.')), tabs), ...commandsGuide()];
    return [
      h('div', { class: 'row' }, h('div', { class: 'head' }, h('h1', {}, 'Help'), h('p', { class: 'muted' }, 'The guide to everything in this app.'), tabs),
        h('div', { class: 'btns' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => window.GBTour.app(0) }, 'Show me around'), h('button', { class: 'btn', type: 'button', onclick: () => window.GBTour.showcase(0) }, 'What can Good Boy do?'))),
      h('div', { class: 'field' }, search),
      topic ? h('div', { class: 'guide' },
        h('nav', { class: 'topics', 'aria-label': 'Guide topics' }, hits.map((t) => h('button', { type: 'button', 'aria-current': String(t.id === topic.id), onclick: () => { S.topic = t.id; S.picked = t.id; draw(); } }, t.title))),
        h('article', { class: 'article card' }, h('h2', {}, topic.title), topic.blocks.map(block)))
        : h('div', { class: 'card empty' }, h('h2', {}, 'Nothing matches that'), h('p', { class: 'muted' }, 'Try fewer or different words, such as "token", "invite" or "backup".')),
    ];
  }

  // the same names and order as the Good Boy 3 dashboard, so nobody has to learn a new map
  const PAGES = { home: ['Home', pageHome, ''], servers: ['Modules', pageServers, ''], tickets: ['Tickets', pageTickets, ''], server: ['Members', pageServer, ''], inactive: ['Inactive', pageInactive, ''], leavers: ['Leavers', pageLeavers, ''], cases: ['Moderation', pageCases, ''], automod: ['AutoMod', pageAutomod, ''], economy: ['Economy', pageEconomy, ''], shop: ['Shop', pageShop, ''], rolemenus: ['Role menus', pageRoleMenus, ''], setup: ['Server setup', pageSetup, ''], images: ['Images', pageImages, ''], lists: ['Lists', pageLists, ''], commands: ['Commands', pageCommands, ''], permissions: ['Permissions', pagePermissions, ''], arcade: ['Arcade', pageArcade, 'Fun'], fishing: ['Fishing', pageFishing, 'Fun'], music: ['Music', pageMusic, 'Fun'], checkup: ['Check-up', pageCheckup, 'Bot'], switch: ['From Good Boy 3', pageSwitch, 'Bot'], activity: ['Logs', pageActivity, 'Bot'], updates: ['Updates', pageUpdates, 'Bot'], whatsnew: ["What's new", pageWhatsNew, 'Bot'], bot: ['Settings', pageBot, 'Bot'], help: ['Help', pageHelp, 'Bot'] };
  // The menu on the left, in sections that fold away so it never gets long. The section you are in stays open.
  const SECTIONS = [
    ['', ['home', 'servers']],
    ['People', ['server', 'inactive', 'leavers', 'tickets', 'rolemenus', 'images']],
    ['Safety', ['cases', 'automod', 'permissions']],
    ['Money', ['economy', 'shop']],
    ['Fun', ['arcade', 'fishing', 'music']],
    ['Tools', ['setup', 'lists', 'commands']],
    ['Bot', ['checkup', 'switch', 'activity', 'updates', 'whatsnew', 'bot', 'help']],
  ];
  function navMenu(pages) {
    let kept = {}; try { kept = JSON.parse(localStorage.getItem('gb-nav') || '{}'); } catch { /* the choice is only a convenience */ }
    const known = SECTIONS.flatMap(([, ids]) => ids);
    const button = (id) => h('button', { class: 'nav', type: 'button', 'aria-current': id === S.page ? 'page' : null, onclick: () => go(id) }, icon(id), PAGES[id][0]);
    const out = [];
    for (const [name, ids] of SECTIONS) {
      const shown = ids.filter((id) => pages.includes(id) && PAGES[id]);
      if (!shown.length) continue;
      if (!name) { out.push(...shown.map(button)); continue; }
      const here = shown.includes(S.page);
      const open = here || kept[name] === true;
      const head = h('button', { class: 'navgroup navfold', type: 'button', 'aria-expanded': String(open), onclick: (e) => {
        const now = e.currentTarget.getAttribute('aria-expanded') !== 'true';
        e.currentTarget.setAttribute('aria-expanded', String(now));
        e.currentTarget.nextElementSibling.hidden = !now;
        kept[name] = now; try { localStorage.setItem('gb-nav', JSON.stringify(kept)); } catch { /* ignore */ }
      } }, h('span', {}, name), h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'));
      out.push(head, h('div', { class: 'navsub', hidden: !open }, shown.map(button)));
    }
    // pages that are in no section still get a place
    const rest = pages.filter((id) => PAGES[id] && !known.includes(id));
    if (rest.length) out.push(...rest.map(button));
    return out;
  }
  function go(page) { S.page = page; draw(); document.querySelector('.main')?.scrollTo(0, 0); }
  // On the web some things stay on the computer (tokens, the move from Good Boy 3, this computer's settings), and only the
  // person who runs the bot sees the bot's own controls.
  function visiblePages() {
    // the move from Good Boy 3 happens by itself now, so its page is not in the menu
    const all = Object.keys(PAGES).filter((id) => id !== 'switch');
    if (!window.GB.web) return all;
    // ticket staff who do not manage the server see the Tickets page and nothing else
    if (S.o && S.o.web && S.o.web.staff_only) return ['tickets'];
    const gone = ['bot', 'switch', ...(S.o.web && S.o.web.owner ? [] : ['checkup'])];
    return all.filter((id) => !gone.includes(id));
  }
  function signinScreen() {
    app.replaceChildren(h('div', { class: 'wizard' }, h('div', { class: 'card signin' },
      h('img', { class: 'hello pup-logo', src: 'mascot.png', alt: '', width: 72, height: 72 }),
      h('h1', {}, 'Good Boy'), h('p', { class: 'muted' }, 'Sign in with Discord to manage your server. Only the person who runs the bot, and people with Manage Server, can come in.'),
      h('a', { class: 'btn', href: '/auth/login' }, 'Sign in with Discord'))));
  }
  function draw() {
    if (!S.o.prefs.setup_done) return wizard();
    const pages = visiblePages();
    if (!pages.includes(S.page)) S.page = pages[0];
    const [dot, line] = stateLine(S.o.live);
    // every scrolling panel keeps its place when the page is rebuilt (the page, the sidebar, the music library and list)
    const SCROLLS = ['.main', '.side', '.gbm-main', '.gbm-lib-list'];
    const kept = SCROLLS.map((q) => [q, document.querySelector(q)?.scrollTop || 0]);
    app.replaceChildren(h('div', { class: 'shell' },
      h('nav', { class: 'side', 'aria-label': 'Pages' }, h('div', { class: 'brand' }, h('img', { src: 'mascot.png', alt: '', width: 40, height: 40, class: 'pup-logo' }), h('span', {}, 'Good Boy')),
        navMenu(pages),
        h('span', { class: 'grow' }), h('div', { class: 'pup-corner' }, h('div', { class: 'pup-bubble', role: 'status' }), h('div', { class: 'dog' }, h('img', { src: 'mascot.png', alt: '' })), h('span', {}, 'On duty')), h('div', { class: 'state' }, h('span', { class: `dot ${dot}` }), h('span', {}, line)),
        window.GB.web ? h('button', { class: 'nav signout', type: 'button', title: `Signed in as ${S.o.web ? S.o.web.name : ''}`, onclick: async () => { try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-gb': '1' } }); } catch { /* leave anyway */ } location.reload(); } }, 'Sign out') : null),
      h('main', { class: 'main' }, h('div', { class: 'page' }, PAGES[S.page][1]()))));
    for (const [q, top] of kept) { const el = document.querySelector(q); if (el && top) el.scrollTop = top; }
    // the music panels are built a moment after the page, so they get their place back once they exist
    if (kept.some(([q, t]) => q.startsWith('.gbm') && t)) requestAnimationFrame(() => { for (const [q, top] of kept) { const el = document.querySelector(q); if (el && top && !el.scrollTop) el.scrollTop = top; } });
  }
  // The status is kept fresh: quickly while starting, every 5 seconds otherwise. A page is only redrawn when
  // something changed and nobody is typing in it.
  async function tick() {
    const before = JSON.stringify(S.o.live);
    try { await refresh(); } catch { /* try again next time */ }
    const changed = JSON.stringify(S.o.live) !== before;
    const typing = document.activeElement?.matches('input:not([type=checkbox]),select,textarea');
    // the music player keeps itself up to date, and rebuilding it would reset the list under the listener's finger
    if (S.o.prefs.setup_done && changed && !typing && S.page !== 'music') draw();
    S.timer = setTimeout(tick, S.o.live.phase === 'starting' ? 700 : 5000);
  }

  matchMedia('(prefers-color-scheme: light)').addEventListener('change', theme);
  window.GBTour.attach({
    go,
    openModule: (id) => { S.open = id; S.scrollOpen = true; go('servers'); },
    done: () => { call('prefs_set', { patch: { toured: true } }).then(refresh).catch(() => {}); },
  });

  // Start-up: the boot animation follows the real steps, and the app is drawn underneath before it fades away.
  async function start() {
    const boot = window.GBBoot();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    boot.step('Opening your data', 0.25);
    try { await refresh(); } catch (e) {
      if (e.signin) { boot.finish(true); return signinScreen(); }
      boot.finish(false);
      app.replaceChildren(h('div', { class: 'wizard' }, h('div', { class: 'card' }, h('h1', {}, 'Good Boy could not open'), h('p', { class: 'msg bad' }, e.message))));
      return;
    }
    boot.step(`Loading ${plural(S.o.modules.length, 'module', 'modules')}`, 0.5);
    draw();
    // a bot that starts with the app: wait for it to come online (but never more than a few seconds)
    if (S.o.prefs.setup_done && S.o.token_saved && S.o.prefs.start_with_app) {
      boot.step('Connecting to Discord', 0.75);
      for (let k = 0; k < 24 && !boot.closed; k++) {
        if (S.o.live.phase === 'online' || S.o.live.phase === 'problem') break;
        await wait(250);
        try { await refresh(); } catch { /* keep waiting */ }
      }
      if (S.o.live.phase === 'online') boot.step('Online as', 1, S.o.live.name || 'your bot');
      else boot.step(S.o.live.phase === 'problem' ? 'The bot needs attention' : 'Still connecting', 1);
    } else {
      boot.step(S.o.prefs.setup_done ? 'Ready' : 'Let\'s get you set up', 1);
    }
    draw();
    await boot.finish(S.o.live.phase !== 'problem');
    S.timer = setTimeout(tick, 1000);
    // the tour is offered once, the first time the app opens after setting up
    if (S.o.prefs.setup_done && !S.o.prefs.toured) setTimeout(() => window.GBTour.offer(), 400);
  }
  start();
})();
