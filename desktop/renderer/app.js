// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The window. Built from DOM nodes and text only (no HTML strings). Talks to the app only through window.goodBoy.
'use strict';
const gb = window.goodBoy;
const app = document.getElementById('app');
let S = null, sum = null, logLines = [], page = 'overview', lastPage = null, setupFound = null, finding = false, busy = false;

// ---------------------------------------------------------------- tiny DOM helpers
const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  puzzle: 'M9 3h6v3a2 2 0 1 0 4 0V3h2v6h-3a2 2 0 1 0 0 4h3v8h-6v-3a2 2 0 1 0-4 0v3H3v-8h3a2 2 0 1 0 0-4H3V3z',
  log: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3',
  down: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .3-1.4-1.4L17 5l-3-1-1 2h-2l-1-2-3 1 .4 2L6 8.3 4 8 3 11l2 1-2 1 1 3 2-.3 1.4 1.4L7 19l3 1 1-2h2l1 2 3-1-.4-2 1.4-1.4 2 .3 1-3z',
  restart: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  check: 'M5 12l5 5 9-10',
  key: 'M14 7a4 4 0 1 1-3.5 6H8v2H6v2H3v-3l6.5-6.5A4 4 0 0 1 14 7z',
};
const COLORS = { blue: '#1A6BFF', mint: '#22C38E', violet: '#7B5CFF', amber: '#F2A93B', teal: '#14B3C7', gray: '#8B97AB', pink: '#EE5DA6', indigo: '#4657E8', red: '#F0525C' };
const AVATAR = ['#1A6BFF', '#7B5CFF', '#14B3C7', '#EE5DA6', '#F2A93B', '#22C38E', '#4657E8', '#F0525C'];
function icon(name) { const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', ICONS[name]); s.append(p); return s; }
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) n.style.setProperty(sk, sv); else n.style[sk] = sv; }
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
const tile = (name, color) => el('span', { class: 'ic', style: { background: COLORS[color] } }, icon(name));
const num = (n) => Number(n).toLocaleString();
const has = (f) => !!S?.edition?.features?.includes(f);
const prettyModule = (n) => n.split('-').map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.replaceChildren(el('span', { class: 'ic', style: { background: bad ? COLORS.red : COLORS.mint, width: '22px', height: '22px', borderRadius: '50%' } }, icon(bad ? 'restart' : 'check')), msg);
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 3400);
}

// numbers count up when they change (and only then)
const shown = new Map();
function countUp(node, key, value) {
  const from = shown.get(key); shown.set(key, value);
  if (typeof value !== 'number' || from === undefined || from === value || matchMedia('(prefers-reduced-motion: reduce)').matches) { node.textContent = typeof value === 'number' ? num(value) : value; return; }
  const t0 = performance.now(), d = 600;
  const step = (t) => { const k = Math.min(1, (t - t0) / d), e = 1 - (1 - k) ** 3; node.textContent = num(Math.round(from + (value - from) * e)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- theme
const mq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = S?.settings?.theme ?? 'system';
  const dark = t === 'dark' || (t === 'system' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  gb.chrome(dark);
}
mq.addEventListener('change', applyTheme);

// ---------------------------------------------------------------- pieces
const STATE_TEXT = { stopped: 'Stopped', starting: 'Starting', running: 'Online', stopping: 'Stopping', failed: 'Stopped with a problem' };
const STATE_COLOR = { running: 'var(--mint)', starting: 'var(--amber)', stopping: 'var(--amber)', failed: 'var(--red)' };

function orb(state) { return el('div', { class: 'orb', 'data-state': state }, el('img', { src: 'good-boy-logo.png', alt: '' })); }

function problemsList() {
  const out = [];
  if (!S.bundled) {
    if (!S.node.found) out.push('Node.js was not found. Install the current LTS from nodejs.org, then choose "Check again" in Settings.');
    else if (!S.node.ok) out.push(`Node.js ${S.node.version} is too old. Good Boy needs 22.13 or newer.`);
  }
  for (const p of S.folder.problems) out.push(p);
  return out;
}

function statusCard() {
  const st = S.bot.state, ready = S.folder.ok && S.node.ok, isOn = st === 'running' || st === 'starting', moving = st === 'starting' || st === 'stopping';
  const since = S.bot.startedAt ? new Date(S.bot.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  const line = st === 'running' ? `Running on this computer since ${since}.` : st === 'starting' ? 'Connecting to Discord...' : st === 'failed' ? (S.bot.error || 'The bot stopped. See the log.') : ready ? 'Ready to start.' : 'Not ready yet.';
  const stateEl = el('div', { class: 'state', style: { '--c': STATE_COLOR[st] ?? 'var(--ink-3)' } }, el('i'), STATE_TEXT[st] ?? st);
  const figs = [['members', sum?.memberCount ?? 0, 'members with XP'], ['modules', (sum?.modules ?? []).filter((m) => m.enabled).length, 'modules on'], ['version', sum ? `v${S.version}` : `v${S.version}`, 'app version']];
  return el('div', { class: 'group' },
    el('div', { class: 'status' }, orb(st),
      el('div', {}, stateEl, el('p', {}, line),
        el('div', { class: 'actions' },
          isOn
            ? el('button', { class: 'btn', disabled: moving, onclick: async () => { await gb.restart(); toast('Restarting the bot...'); } }, icon('restart'), 'Restart')
            : el('button', { class: 'btn', disabled: !ready || moving, onclick: () => gb.start() }, 'Start'),
          el('button', { class: 'btn quiet', disabled: !isOn || moving, onclick: () => gb.stop() }, 'Stop'),
          el('button', { class: 'btn quiet', disabled: st !== 'running', onclick: () => gb.openDashboard() }, 'Open dashboard')))),
    S.bot.blocked ? takeoverBox() : null,
    el('div', { class: 'figures' }, figs.map(([k, v, label]) => { const b = el('b'); countUp(b, k, v); return el('div', {}, b, el('small', {}, label)); })));
}

// An older copy of the bot is still running somewhere on this computer: offer to stop it and start fresh.
function takeoverBox() {
  const other = S.bot.blocked.other;
  return el('div', { class: 'callout' }, el('b', {}, other ? 'This bot is already running in another Good Boy app' : 'An older copy of the bot is still running'),
    el('p', {}, other ? 'Another Good Boy app on this computer is running the same bot. Two copies would answer every command twice, so this one waited.' : 'It was left running in the background, so Start could not take over. Take control stops it and starts the bot here.'),
    el('button', { class: 'btn', disabled: busy, onclick: async () => { busy = true; render(); const r = await gb.takeover(); busy = false; toast(r.ok ? (r.stale ? 'Cleared. Starting the bot...' : 'Stopped the old copy. Starting the bot...') : r.error, !r.ok); render(); } }, busy ? 'Working...' : 'Take control'));
}

function memberRows(list, max, wide = false) {
  if (!list?.length) return el('div', { class: 'group' }, el('div', { class: 'empty' }, sum?.empty ? 'No server data yet. Once the bot is running, members earn XP as they chat.' : 'No one has earned XP yet.'));
  return el('div', { class: 'group' }, list.slice(0, max).map((m, i) => el('div', { class: 'row' },
    el('span', { class: 'rank' }, i + 1),
    el('span', { class: 'avatar', style: { background: AVATAR[i % AVATAR.length] } }, m.id.slice(-2)),
    el('div', { class: 'two' }, el('span', { class: 'lab' }, `Member …${m.id.slice(-4)}`), el('span', { class: 'bar', style: wide ? { width: '240px' } : {} }, el('i', { style: { width: `${Math.round((m.into / m.needed) * 100)}%` } }))),
    wide ? el('span', { class: 'meta', style: { marginLeft: 'auto', whiteSpace: 'nowrap' } }, `${num(m.into)} of ${num(m.needed)} XP to level ${m.level + 1}`) : null,
    el('div', { class: 'lvl', style: wide ? { marginLeft: '24px', width: '100px' } : {} }, el('b', {}, `Level ${m.level}`), el('small', {}, `${num(m.xp)} XP`)))));
}

const MOD = { live: null, loading: false, busy: null, at: 0 };
async function refreshModules(force = false) {
  if (!S || S.bot.state !== 'running') { MOD.live = null; return; }
  if (MOD.loading || (!force && Date.now() - MOD.at < 8000)) return;
  MOD.loading = true;
  const r = await gb.modules(sum?.guild?.id ?? null);
  MOD.loading = false; MOD.at = Date.now();
  MOD.live = r.ok ? r : null;
  render();
}
async function toggleModule(m, on) {
  MOD.busy = m.name; render();
  const r = await gb.moduleSet({ guildId: MOD.live?.guildId, name: m.name, enabled: on });
  MOD.busy = null;
  toast(r.ok ? `${prettyModule(m.name)} is now ${on ? 'on' : 'off'}.` : r.error, !r.ok);
  await refreshModules(true); refreshSummary();
}
function moduleRows(max) {
  const live = S?.bot?.state === 'running' ? MOD.live : null;
  if (S?.bot?.state === 'running' && !MOD.live) refreshModules();
  const mods = live?.modules ?? (sum?.modules ?? []).map((m) => ({ ...m, description: '' }));
  if (!mods.length) return el('div', { class: 'group' }, el('div', { class: 'empty' }, 'No modules yet. Start the bot to see every module you can turn on.'));
  const rows = mods.slice(0, max).map((m) => el('div', { class: 'row' },
    el('div', { class: 'two' }, el('span', { class: 'lab' }, prettyModule(m.name)), max > 10 && m.description ? el('span', { class: 'meta' }, m.description) : null, m.requires && max > 10 ? el('span', { class: 'meta' }, `Add-on for ${prettyModule(m.requires)}`) : null),
    el('input', { type: 'checkbox', class: 'switch', checked: m.enabled, disabled: !live || MOD.busy === m.name, 'aria-label': `${prettyModule(m.name)} ${m.enabled ? 'on' : 'off'}`, onchange: (e) => toggleModule(m, e.target.checked) })));
  if (max < mods.length) rows.push(el('div', { class: 'row' }, el('button', { class: 'btn quiet', onclick: () => go('modules') }, `Show all ${mods.length}`)));
  return el('div', { class: 'group' }, rows);
}

const opt = (key, label, invert = false) => el('div', { class: 'row' }, el('span', { class: 'lab' }, label),
  el('input', { type: 'checkbox', class: 'switch', checked: invert ? S.settings[key] !== 'quit' : !!S.settings[key], 'aria-label': label,
    onchange: (e) => gb.saveSettings(key === 'closeAction' ? { closeAction: e.target.checked ? 'minimize' : 'quit' } : { [key]: e.target.checked }) }));

// ---------------------------------------------------------------- pages
const PAGES = {
  overview() {
    const probs = problemsList();
    return [el('h1', {}, 'Overview'), el('p', { class: 'sub' }, sum?.guild?.name ?? 'Your Discord bot, running on this computer.'),
      el('div', { class: 'cols' },
        el('div', {}, statusCard(), probs.map((p) => el('p', { class: 'problem' }, p)), el('div', { class: 'section-title' }, 'Top members'), memberRows(sum?.members, 5),
          sum?.members?.length ? el('p', { class: 'note' }, 'Members are shown by the end of their Discord ID. The dashboard shows their names.') : null),
        el('div', {}, el('div', { class: 'section-title' }, 'Modules'), moduleRows(6), el('div', { class: 'section-title' }, 'This computer'),
          el('div', { class: 'group' }, opt('startBotWithApp', 'Start the bot when Good Boy opens'), opt('startAtLogin', 'Open Good Boy when I sign in'), opt('closeAction', 'Keep running when I close the window', true))))];
  },
  levels() {
    return [el('h1', {}, 'Levels'), el('p', { class: 'sub' }, sum?.memberCount ? `${num(sum.memberCount)} members have earned XP${sum.guild ? ` in ${sum.guild.name}` : ''}.` : 'Members earn XP as they chat.'),
      memberRows(sum?.members, 50, true), sum?.memberCount > 50 ? el('p', { class: 'note' }, `Showing the top 50 of ${num(sum.memberCount)}.`) : null];
  },
  modules() {
    const running = S.bot.state === 'running';
    const add = async () => { const r = await gb.moduleAdd(); if (r.cancelled) return; if (!r.ok) return toast(r.error, true); toast(r.later ? `${prettyModule(r.name)} was added. It loads the next time the bot starts.` : `${prettyModule(r.name)} was added. Turn it on below.`); refreshModules(true); };
    return [el('div', { class: 'titlerow' }, el('div', {}, el('h1', {}, 'Modules'), el('p', { class: 'sub' }, running ? `Features for ${MOD.live?.guildName ?? 'your server'}. Switch them on or off here.` : 'Start the bot to switch modules on or off.')),
        el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: add }, 'Add module...'), has('licenses') ? el('button', { class: 'btn quiet', onclick: async () => { const r = await gb.moduleSign(); if (r.cancelled) return; toast(r.ok ? `Signed ${r.name}. Anyone's Good Boy can now add it.` : r.error, !r.ok); } }, 'Sign a module...') : null)),
      moduleRows(999),
      el('p', { class: 'note' }, S.edition.id === 'consumer' ? 'For safety, only modules signed by Basic Ghost Labs can be added. A module is code that runs inside your bot.' : 'A module is code that runs inside your bot. Only add modules you trust.')];
  },
  log() {
    const pre = el('pre', { class: 'log', 'aria-label': 'Bot log' }, logLines.join('\n') || 'Nothing yet. Start the bot to see what it is doing.');
    requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    return [el('h1', {}, 'Log'), el('p', { class: 'sub' }, 'What the bot is saying. Tokens and secrets are hidden.'), el('div', { class: 'group' }, pre)];
  },
  updates() {
    const u = S.update ?? { phase: 'off' };
    const text = { off: 'Updates are checked by the installed app.', idle: 'Checking soon after Good Boy opens.', checking: 'Checking for updates...', downloading: `Downloading version ${u.version ?? ''}${u.percent != null ? ` (${Math.round(u.percent)}%)` : ''}...`, ready: `Version ${u.version} is downloaded and ready.`, available: `Version ${u.version} is out.`, current: 'You have the latest version.', none: 'No version has been published yet, so there is nothing to update to.', error: `Could not check: ${u.error ?? 'unknown problem'}` }[u.phase] ?? '';
    const tag = { current: ['tag ok', 'Up to date'], none: ['tag off', 'Nothing published'], ready: ['tag ok', 'Ready'], downloading: ['tag wait', 'Downloading'], checking: ['tag wait', 'Checking'], available: ['tag wait', 'New version'], error: ['tag off', 'Problem'], off: ['tag off', 'Off'], idle: ['tag off', 'Waiting'] }[u.phase] ?? ['tag off', ''];
    const how = u.mode === 'auto' ? 'New versions download by themselves and install when you restart Good Boy. Your settings, token and server data are kept.'
      : u.mode === 'notify' ? (S.edition.id === 'owner' ? 'The Owner build is not published, so it tells you when a new version is out. Ask for the new Owner build.' : 'This copy cannot replace itself (portable or Mac), so it tells you when a new version is out and opens the download page.')
        : 'Running from source: no update checks.';
    const actions = [];
    if (u.phase === 'ready') actions.push(el('button', { class: 'btn', onclick: async () => { const r = await gb.updateInstall(); if (!r.ok) toast(r.error, true); } }, 'Restart and update'));
    if (u.phase === 'available') actions.push(el('button', { class: 'btn', onclick: () => gb.updateOpen() }, 'Get the new version'));
    if (u.mode !== 'off' && !['checking', 'downloading', 'ready'].includes(u.phase)) actions.push(el('button', { class: 'btn quiet', onclick: async () => { await gb.updateCheck(); } }, 'Check now'));
    return [el('h1', {}, 'Updates'), el('p', { class: 'sub' }, 'Good Boy checks GitHub for new versions. The bot and dashboard update together with the app.'),
      el('div', { class: 'cols' },
        el('div', {}, el('div', { class: 'section-title' }, 'Installed'), el('div', { class: 'group' },
          el('div', { class: 'row inset' }, tile('box', 'blue'), el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Good Boy app'), el('span', { class: 'meta' }, `Version ${S.version}`)), el('span', { class: 'val' }, el('span', { class: 'tag ok' }, 'Installed'))),
          el('div', { class: 'row inset' }, tile('puzzle', 'violet'), el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Bot and dashboard'), el('span', { class: 'meta' }, S.bundled ? `Version ${S.version}, inside the app` : 'From your Good Boy folder')), el('span', { class: 'val' }, el('span', { class: 'tag ok' }, 'Installed'))))),
        el('div', {}, el('div', { class: 'section-title' }, 'New versions'), el('div', { class: 'group' },
          el('div', { class: 'row inset' }, tile('down', 'mint'), el('div', { class: 'two' }, el('span', { class: 'lab' }, text), u.checkedAt ? el('span', { class: 'meta' }, `Last checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`) : null), el('span', { class: 'val' }, el('span', { class: tag[0] }, tag[1]))),
          u.phase === 'downloading' && u.percent != null ? el('div', { class: 'row' }, el('span', { class: 'bar', style: { width: '100%' } }, el('i', { style: { width: `${Math.round(u.percent)}%` } }))) : null,
          actions.length ? el('div', { class: 'row' }, el('div', { class: 'row-btns' }, actions)) : null),
          el('p', { class: 'note' }, how)))];
  },
  settings() {
    const v = S.vault;
    const themeSeg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Appearance' }, [['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([t, label]) => el('button', { 'aria-pressed': (S.settings.theme ?? 'system') === t, onclick: () => gb.saveSettings({ theme: t }) }, label)));
    return [el('h1', {}, 'Settings'), el('p', { class: 'sub' }, 'How Good Boy looks and runs on this computer.'),
      el('div', { class: 'cols' },
        el('div', {}, el('div', { class: 'section-title' }, 'Appearance'), el('div', { class: 'group' }, el('div', { class: 'row' }, el('span', { class: 'lab' }, 'Look'), el('span', { class: 'val' }, themeSeg))),
          el('div', { class: 'section-title' }, 'This computer'), el('div', { class: 'group' }, opt('startBotWithApp', 'Start the bot when Good Boy opens'), opt('startAtLogin', 'Open Good Boy when I sign in'), opt('closeAction', 'Keep running when I close the window', true), opt('dashboardOnStart', 'Open the dashboard when the bot is running')),
          S.bundled ? brandGroup() : null, S.bundled && S.edition.id !== 'owner' ? licenceGroup() : null),
        el('div', {}, S.bundled ? [el('div', { class: 'section-title' }, 'Bot'), el('div', { class: 'group' },
          el('div', { class: 'row inset' }, tile('key', 'amber'), el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Bot token'), el('span', { class: 'meta' }, S.secure ? 'Saved, encrypted by this computer' : 'This computer cannot encrypt it')), el('span', { class: 'val' }, el('span', { class: v?.hasToken ? 'tag ok' : 'tag wait' }, v?.hasToken ? 'Saved' : 'Missing'))),
          el('div', { class: 'row inset' }, tile('lock', 'indigo'), el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Dashboard login'), el('span', { class: 'meta' }, 'Discord client secret')), el('span', { class: 'val' }, el('span', { class: v?.hasClientSecret ? 'tag ok' : 'tag off' }, v?.hasClientSecret ? 'Saved' : 'Not set'))),
          el('div', { class: 'field' }, el('label', { for: 'new-secret' }, 'Change client secret'), el('div', { class: 'copyrow' },
            el('input', { type: 'password', id: 'new-secret', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste a new client secret' }),
            el('button', { class: 'btn quiet', onclick: async () => { const i = document.getElementById('new-secret'); const v = i.value.trim(); if (!v) return toast('Paste the new client secret first.', true); const r = await gb.setupSecret(v); i.value = ''; toast(r.ok ? 'Client secret checked with Discord and saved. Restart the bot to use it.' : r.error, !r.ok); } }, 'Check and save')),
            el('span', { class: 'meta' }, 'Developer Portal > your app > OAuth2 > Reset Secret.')),
          el('div', { class: 'row' }, el('button', { class: 'btn quiet', onclick: () => { forceSetup = true; W.step = 'welcome'; setupFound = null; render(); } }, 'Run setup again'))),
          shareGroup(),
          el('div', { class: 'section-title' }, 'Server data'), el('div', { class: 'group' },
            el('div', { class: 'row inset' }, tile('folder', 'teal'), el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Move or back up your data'), el('span', { class: 'meta' }, 'Levels, settings, tickets and everything else, in one .goodboy file. The token is never included.'))),
            el('div', { class: 'row' }, el('div', { class: 'row-btns' },
              el('button', { class: 'btn quiet', onclick: async () => { const r = await gb.dataExport(); if (r.cancelled) return; toast(r.ok ? `Saved${r.memberCount != null ? ` (${num(r.memberCount)} members with XP)` : ''}.` : r.error, !r.ok); } }, 'Export data...'),
              el('button', { class: 'btn quiet', onclick: async () => { const r = await gb.dataImport(); if (r.cancelled) return; toast(r.ok ? `Loaded${r.guild ? ` ${r.guild.name}` : ''}: ${num(r.memberCount ?? 0)} members with XP.` : r.error, !r.ok); refreshSummary(); } }, 'Import data...'))),
            el('div', { class: 'row inset' }, tile('star', 'amber'), el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Levels only'), el('span', { class: 'meta' }, 'Save just members\' XP, or add levels from a file: everyone keeps their higher level and nothing else changes.'))),
            el('div', { class: 'row' }, el('div', { class: 'row-btns' },
              el('button', { class: 'btn quiet', onclick: async () => { const r = await gb.levelsExport(); if (r.cancelled) return; toast(r.ok ? `Saved the levels of ${num(r.memberCount ?? 0)} members.` : r.error, !r.ok); } }, 'Export levels...'),
              el('button', { class: 'btn quiet', onclick: async () => { const r = await gb.levelsMerge(); if (r.cancelled) return; toast(r.ok ? `Merged: ${num(r.added)} new, ${num(r.raised)} raised, ${num(r.unchanged)} already higher here.` : r.error, !r.ok); refreshSummary(); } }, 'Merge levels...')))),
          el('p', { class: 'note' }, 'The token never leaves this computer and is never shown again after you save it.')]
          : [el('div', { class: 'section-title' }, 'Good Boy folder'), el('div', { class: 'group' }, el('div', { class: 'row' }, el('span', { class: 'path' }, S.settings.botDir || 'Not chosen yet')),
            el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => gb.chooseFolder() }, 'Choose folder...'), el('button', { class: 'btn quiet', onclick: async () => { S = await gb.recheck(); render(); } }, 'Check again'))),
            el('div', { class: 'section-title' }, 'Node.js'), el('div', { class: 'group' }, el('div', { class: 'row' }, el('span', { class: 'path' }, S.node.found ? `${S.node.path === 'node' ? 'Found on this computer' : S.node.path} (version ${S.node.version})` : 'Not found')),
              el('div', { class: 'row' }, el('button', { class: 'btn quiet', onclick: () => gb.chooseNode() }, 'Choose node...')))]))];
  },
  setup() { return wizard(); },
  licenses() {
    const L = LIC.state;
    if (!L) { refreshLic(); return [el('h1', {}, 'Licences'), el('p', { class: 'sub' }, 'Loading...')]; }
    if (!L.hasKey) return [el('h1', {}, 'Licences'), el('p', { class: 'sub' }, 'Give other servers a white-label licence for a set time.'),
      el('div', { class: 'group' }, el('div', { class: 'row inset' }, tile('key', 'amber'), el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Make your signing key'), el('span', { class: 'meta' }, 'Licences are signed with a key that stays on this computer, encrypted. Nobody can make or change a licence without it.')),
        el('span', { class: 'val' }, el('button', { class: 'btn', onclick: async () => { const r = await gb.licKeygen(); if (!r.ok) return toast(r.error, true); toast('Signing key made.'); LIC.state = null; render(); } }, 'Make key'))))];
    const f = LIC.form;
    const durations = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['lifetime', 'Lifetime'], ['date', 'Pick a date']];
    const appIn = el('input', { value: f.appId, placeholder: 'For example 1469714389648015571', inputmode: 'numeric', oninput: (e) => { f.appId = e.target.value.trim(); } });
    const toIn = el('input', { value: f.to, placeholder: 'For example Joe\'s server', oninput: (e) => { f.to = e.target.value; } });
    const dateIn = el('input', { type: 'date', value: f.until, oninput: (e) => { f.until = e.target.value; } });
    const now = Date.now();
    const status = (x) => (x.revoked ? ['tag off', 'Cancelled'] : x.exp && x.exp <= now ? ['tag wait', 'Ended'] : ['tag ok', 'Active']);
    return [el('h1', {}, 'Licences'), el('p', { class: 'sub' }, 'White-label licences for other servers: their own bot name and picture, no Good Boy credit.'),
      L.builtInKeyMatches ? null : el('div', { class: 'callout' }, el('b', {}, 'One-time step: build your key into Good Boy'),
        el('p', {}, 'Other copies of Good Boy can only check your licences once your public key is built in. Copy it and send it to your developer; it is safe to share.'),
        el('button', { class: 'link', onclick: async () => { await gb.copy(L.publicKey); toast('Public key copied.'); } }, 'Copy public key')),
      el('div', { class: 'cols' },
        el('div', {}, el('div', { class: 'section-title' }, 'New licence'), el('div', { class: 'group' },
          el('div', { class: 'field' }, el('label', {}, 'Who it is for'), toIn),
          el('div', { class: 'field' }, el('label', {}, 'Their bot\'s Application ID'), appIn, el('span', { class: 'meta' }, 'They find it in the Developer Portal: their app > General Information > Application ID.')),
          el('div', { class: 'field' }, el('label', {}, 'How long'), el('span', { class: 'seg wrap', role: 'group' }, durations.map(([v, label]) => el('button', { 'aria-pressed': f.days === v, onclick: () => { f.days = v; render(); } }, label))), f.days === 'date' ? dateIn : null),
          el('div', { class: 'row' }, el('span', { class: 'lab' }, 'White-label: own name and picture, no Good Boy credit'), el('input', { type: 'checkbox', class: 'switch', checked: true, disabled: true, 'aria-label': 'White-label' })),
          el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => {
            const r = await gb.licCreate({ appId: f.appId, to: f.to, days: f.days === 'date' ? '' : f.days, until: f.days === 'date' ? f.until : '', features: ['whitelabel'] });
            if (!r.ok) return toast(r.error, true);
            LIC.last = r.key; LIC.state = null; await gb.copy(r.key); toast('Licence made and copied. Send it to them.'); refreshLic();
          } }, 'Create licence'))),
          LIC.last ? el('div', { class: 'redirect' }, el('b', {}, 'New licence key'), el('div', { class: 'copyrow' }, el('code', { class: 'key' }, LIC.last), el('button', { class: 'btn quiet', onclick: async () => { await gb.copy(LIC.last); toast('Copied.'); } }, 'Copy'))) : null),
        el('div', {}, el('div', { class: 'section-title' }, `Licences you made (${L.issued.length})`), el('div', { class: 'group' },
          L.issued.length ? L.issued.map((x) => { const [cls, label] = status(x); return el('div', { class: 'row' }, el('div', { class: 'two' }, el('span', { class: 'lab' }, x.to || 'No name'), el('span', { class: 'meta' }, `Bot ${x.app} · ${x.exp ? `until ${new Date(x.exp).toLocaleDateString()}` : 'lifetime'}`)),
            el('span', { class: 'val' }, el('span', { class: cls }, label), el('button', { class: 'link', onclick: async () => { await gb.copy(x.key); toast('Copied.'); } }, 'Copy'),
              x.revoked ? null : el('button', { class: 'link', onclick: async () => { await gb.licRevoke(x.id); LIC.state = null; toast('Licence cancelled.'); refreshLic(); } }, 'Cancel'))); })
            : el('div', { class: 'empty' }, 'No licences yet.')),
          el('p', { class: 'note' }, 'Cancelling marks the licence here. It stops working on their side once update publishing is set up, because cancelled keys are shared along with updates.')))];
  },
};
let forceSetup = false;

// ---------------------------------------------------------------- dashboard link (works from anywhere)
const SH = { st: null, at: 0, busy: false, fix: null, manual: null, steps: null, qr: null };
const SETUP_STEPS = [['install', 'Install Tailscale'], ['login', 'Sign in to Tailscale'], ['funnel', 'Turn on the link'], ['discord', 'Add it to Discord login'], ['phone', 'Pair your phone']];
gb.onShareStep?.((m) => { SH.steps = { ...(SH.steps ?? {}), [m.id]: m }; render(); });
async function refreshShare(force = false) {
  if (SH.busy || (!force && Date.now() - SH.at < 15000)) return;
  SH.at = Date.now(); SH.st = await gb.shareState(); if (SH.st?.qr) SH.qr = SH.st.qr; render();
}
async function runShareSetup() {
  SH.busy = true; SH.steps = {}; SH.fix = null; render();
  const r = await gb.shareSetup();
  SH.busy = false; SH.at = 0;
  if (r.ok) { SH.manual = r.redirectAdded ? null : r.redirectUri; SH.qr = r.qr ?? SH.qr; toast('Your dashboard link is on. It turns itself on whenever Good Boy starts.'); }
  else { SH.fix = r.link ? { link: r.link, text: r.error } : null; toast(r.error, true); }
  refreshShare(true);
}
function shareSteps() {
  if (!SH.steps) return null;
  const icon = { busy: '…', done: '✓', error: '!', manual: '→' };
  return el('div', { class: 'group steps' }, SETUP_STEPS.map(([id, label]) => {
    const m = SH.steps[id];
    return el('div', { class: 'row inset' }, el('span', { class: `stepdot ${m?.state ?? 'todo'}`, 'aria-hidden': 'true' }, icon[m?.state] ?? ''),
      el('div', { class: 'two' }, el('span', { class: 'lab' }, label), m?.text ? el('span', { class: 'meta' }, m.text) : null),
      m?.state === 'error' && m.link ? el('button', { class: 'btn quiet', onclick: () => gb.shareLink(m.link) }, 'Open the page') : null);
  }));
}
function shareGroup() {
  if (!S.bundled) return null;
  refreshShare();
  const st = SH.st, rows = [];
  const act = async (fn) => { SH.busy = true; render(); const r = await fn(); SH.busy = false; SH.at = 0; return r; };
  const head = (label, meta, tag) => el('div', { class: 'row inset' }, tile('chart', 'violet'), el('div', { class: 'two' }, el('span', { class: 'lab' }, label), meta ? el('span', { class: 'meta' }, meta) : null), tag ? el('span', { class: 'val' }, el('span', { class: tag[0] }, tag[1])) : null);
  const setupBtn = (label) => el('div', { class: 'row' }, el('button', { class: 'btn', disabled: SH.busy, onclick: runShareSetup }, SH.busy ? 'Setting up...' : label));
  if (!st) rows.push(head('Dashboard link', 'Checking...'));
  else if (st.state === 'on') {
    rows.push(head('Your dashboard link', st.auto ? 'Works from anywhere while this computer and Good Boy are on. Turns itself back on at every start.' : 'Works from anywhere while this computer and Good Boy are on.', ['tag ok', 'Shared']),
      el('div', { class: 'row' }, el('div', { class: 'copyrow' }, el('code', { class: 'key' }, st.url), el('button', { class: 'btn quiet', onclick: async () => { await gb.copy(st.url); toast('Link copied.'); } }, 'Copy'))),
      SH.qr ? el('div', { class: 'row qrrow' }, el('img', { class: 'qr', src: SH.qr, alt: 'QR code for the phone app', width: '180', height: '180' }),
        el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Pair your phone'), el('span', { class: 'meta' }, 'Scan with your phone\'s camera. iPhone: open it in Safari, then Share > Add to Home Screen. Android: tap "Open in the Good Boy app".'))) : null,
      opt('keepAwake', 'Keep this computer awake while the bot runs'),
      el('div', { class: 'row' }, el('button', { class: 'btn quiet', disabled: SH.busy, onclick: async () => { const r = await act(() => gb.shareOff()); toast(r.ok ? 'Stopped sharing. The dashboard is on this computer only again.' : r.error, !r.ok); SH.steps = null; refreshShare(true); } }, 'Stop sharing')));
  } else rows.push(head('A link that works from anywhere', st.state === 'off' && st.url ? `Your link will be ${st.url}` : 'Use the dashboard and the phone app from anywhere. One button sets it all up with Tailscale (free); you only sign in once.', ['tag off', 'Off']),
    setupBtn(st.state === 'missing' ? 'Set up' : 'Turn on'));
  if (SH.fix && !SH.steps) rows.push(el('div', { class: 'row' }, el('span', { class: 'meta' }, SH.fix.text), el('button', { class: 'btn quiet', onclick: () => gb.shareLink(SH.fix.link) }, 'Open the page')));
  return [el('div', { class: 'section-title' }, 'Dashboard link'), el('div', { class: 'group' }, rows), st?.state !== 'on' || SH.busy ? shareSteps() : null,
    SH.manual ? el('div', { class: 'redirect' }, el('b', {}, 'Add this to your bot\'s Redirects'), el('p', {}, 'Discord only lets you log in from addresses on the Redirects list. Copy it, open the OAuth2 page, click Add Redirect, paste, then Save Changes.'),
      el('div', { class: 'copyrow' }, el('code', { class: 'key' }, SH.manual), el('button', { class: 'btn quiet', onclick: async () => { await gb.copy(SH.manual); gb.openLink('oauth'); } }, 'Copy and open OAuth2'))) : null];
}

// ---------------------------------------------------------------- first-run setup: one question per screen
const W = { step: 'welcome', token: '', verify: null, checking: false, secret: '', imported: null };
const STEPS = ['token', 'secret', 'brand', 'invite', 'done'];
const B = { status: null, busy: false, results: null };
const LIC = { state: null, form: { appId: '', to: '', days: '30', until: '' }, last: null, loading: false };
async function refreshLic() { if (LIC.loading) return; LIC.loading = true; LIC.state = await gb.licState(); LIC.loading = false; render(); }
function brandGroup() {
  const st = B.status;
  if (!st && !B.asked) { B.asked = true; refreshBrand(); }
  if (S.whiteLabel) {
    const nameIn = el('input', { placeholder: 'Bot name', maxlength: '32', 'aria-label': 'Bot name' });
    return [el('div', { class: 'section-title' }, 'Your bot\'s look'), el('div', { class: 'group' },
      el('div', { class: 'field' }, el('label', {}, 'Name'), nameIn),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const r = await gb.brandCustom({ name: nameIn.value }); toast(r.ok ? 'Name changed.' : r.error, !r.ok); } }, 'Save name'),
        el('button', { class: 'btn quiet', onclick: async () => { const r = await gb.brandCustom({ pickImage: true }); if (r.cancelled) return; toast(r.ok ? 'Picture changed.' : r.error, !r.ok); } }, 'Choose picture...'),
        el('button', { class: 'link', disabled: B.busy, onclick: applyBrandNow }, 'Use the Good Boy look'))),
      el('p', { class: 'note' }, 'Your licence lets you use your own name and picture.')];
  }
  return [el('div', { class: 'section-title' }, 'Good Boy look'), el('div', { class: 'group' }, el('div', { class: 'row inset' }, el('img', { class: 'mini', src: 'brand/avatar.png', alt: '' }), el('div', { class: 'two' }, el('span', { class: 'lab' }, 'Name, picture and banner on Discord'), el('span', { class: 'meta' }, st ? (st.done ? 'Your bot looks like Good Boy. It is kept that way automatically.' : 'Some parts are not set yet. Good Boy keeps trying in the background.') : 'Checking...')),
    el('span', { class: 'val' }, el('button', { class: st?.done ? 'btn quiet' : 'btn', disabled: B.busy, onclick: applyBrandNow }, B.busy ? 'Applying...' : st?.done ? 'Apply again' : 'Apply'))))];
}
function licenceGroup() {
  const l = S.licence;
  const input = el('input', { placeholder: 'Paste a licence key', 'aria-label': 'Licence key', spellcheck: 'false' });
  return [el('div', { class: 'section-title' }, 'Licence'), el('div', { class: 'group' },
    l?.ok ? el('div', { class: 'row' }, el('div', { class: 'two' }, el('span', { class: 'lab' }, 'White-label'), el('span', { class: 'meta' }, l.exp ? `Until ${new Date(l.exp).toLocaleDateString()}` : 'Lifetime')), el('span', { class: 'val' }, el('span', { class: 'tag ok' }, 'Active'), el('button', { class: 'link', onclick: async () => { await gb.licApply(''); toast('Licence removed.'); } }, 'Remove')))
      : [l ? el('div', { class: 'row' }, el('span', { class: 'err' }, l.error)) : null, el('div', { class: 'field' }, el('label', {}, 'Licence key'), input),
        el('div', { class: 'row' }, el('button', { class: 'btn quiet', disabled: !S.licencesOn, onclick: async () => { const r = await gb.licApply(input.value); if (!r.ok) return toast(r.error, true); toast('Licence added.'); } }, 'Add licence'), S.licencesOn ? null : el('span', { class: 'meta' }, 'Licences come in a later version.'))])];
}
let verifyTimer = null;
function wgo(step) { W.step = step; lastPage = null; render(); }

function botCard(v) {
  return el('div', { class: 'botcard' }, el('img', { src: v.bot.avatar, alt: '' }),
    el('div', { class: 'two' }, el('b', {}, v.bot.name), el('span', { class: 'meta' }, v.guilds ? `In ${v.guilds.length} server${v.guilds.length === 1 ? '' : 's'}` : 'Connected to Discord')),
    el('span', { class: 'tag ok', style: { marginLeft: 'auto' } }, 'Token works'));
}
function helpLine(text, linkLabel, kind) {
  return el('p', { class: 'help' }, text, ' ', el('button', { class: 'link', onclick: () => gb.openLink(kind) }, linkLabel));
}
function stepDots() {
  const i = STEPS.indexOf(W.step);
  return el('div', { class: 'steps', 'aria-label': `Step ${i + 1} of ${STEPS.length}` }, STEPS.map((s, n) => el('i', { class: n < i ? 'done' : n === i ? 'now' : '' })));
}
function wizardNav(back, next) {
  return el('div', { class: 'wnav' }, back ? el('button', { class: 'btn quiet', onclick: back.on }, back.label ?? 'Back') : el('span'), next);
}
function intentNote(v) {
  if (!v?.intents) return null;
  const missing = [!v.intents.members && 'Server Members Intent', !v.intents.messageContent && 'Message Content Intent'].filter(Boolean);
  if (!missing.length) return null;
  return el('div', { class: 'callout' }, el('b', {}, `Turn on ${missing.join(' and ')}`),
    el('p', {}, 'Levels, welcome messages and moderation need it. On the Bot page, scroll to Privileged Gateway Intents and switch it on, then press Save Changes.'),
    el('button', { class: 'link', onclick: () => gb.openLink('bot') }, 'Open the Bot page'));
}

async function runVerify(value) {
  W.checking = true; paintTokenStatus();
  const r = await gb.verifyToken(value);
  if (value !== W.token) return; // they kept typing; a newer check is coming
  W.checking = false; W.verify = r; paintTokenStatus();
}
function paintTokenStatus() {
  const box = document.getElementById('token-status'), next = document.getElementById('token-next');
  if (!box) return;
  const v = W.verify;
  const content = W.checking ? el('p', { class: 'checking' }, el('span', { class: 'spinner' }), 'Checking with Discord...')
    : v?.ok ? [botCard(v), intentNote(v)] : v && W.token ? el('p', { class: 'err' }, v.error) : [];
  box.replaceChildren(...[content].flat(Infinity).filter(Boolean));
  if (next) next.disabled = !(v?.ok) || W.checking;
}

function wizard() {
  const found = setupFound ?? [];
  if (W.step === 'welcome') {
    return el('div', { class: 'setup wizard' }, orb('starting'), el('h1', {}, 'Welcome to Good Boy'),
      el('p', { class: 'sub' }, 'Let\'s get your Discord bot online. It takes about two minutes.'),
      has('import') && found.length ? [el('div', { class: 'section-title' }, 'Your bot is already on this computer'), el('div', { class: 'group' },
        found.map((f) => el('div', { class: 'row inset' }, tile('folder', 'blue'), el('div', { class: 'two' }, el('span', { class: 'path' }, f.dir), el('span', { class: 'meta' }, f.hasData ? 'Token, settings and server data (levels)' : 'Token and settings')),
          el('span', { class: 'val' }, el('button', { class: 'btn', disabled: busy, onclick: () => useExisting(f.dir) }, busy ? 'Bringing it over...' : 'Use this bot')))))] : null,
      el('div', { class: 'wnav center' }, el('button', { class: found.length ? 'btn quiet big' : 'btn big', onclick: () => wgo('token') }, found.length ? 'Set up a different bot' : 'Get started')),
      has('import') ? el('p', { class: 'help' }, 'Have Good Boy in another folder? ', el('button', { class: 'link', onclick: async () => { const f = await gb.setupPick(); if (!f) return; if (!f.hasToken) return toast('That folder has no Discord bot token in its .env file.', true); setupFound = [f, ...found.filter((x) => x.dir !== f.dir)]; render(); } }, 'Choose the folder')) : null);
  }
  if (W.step === 'token') {
    const input = el('input', { type: 'password', id: 'token-input', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste your Discord bot token here', 'aria-label': 'Discord bot token', value: W.token,
      oninput: (e) => { W.token = e.target.value.trim(); W.verify = null; clearTimeout(verifyTimer); if (W.token) verifyTimer = setTimeout(() => runVerify(W.token), 500); paintTokenStatus(); } });
    const show = el('button', { class: 'link', onclick: (e) => { input.type = input.type === 'password' ? 'text' : 'password'; e.target.textContent = input.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const next = el('button', { class: 'btn big', id: 'token-next', disabled: !W.verify?.ok, onclick: async () => {
      const r = await gb.setupSave({ token: W.token, clientSecret: '' });
      if (!r.ok) return toast(r.error, true);
      W.token = ''; wgo('secret');
    } }, 'Next');
    queueMicrotask(() => { paintTokenStatus(); document.getElementById('token-input')?.focus(); });
    return el('div', { class: 'setup wizard' }, stepDots(), el('h1', {}, 'Discord bot token'),
      el('p', { class: 'sub' }, 'This is how Good Boy signs in to Discord as your bot.'),
      el('div', { class: 'group' }, el('div', { class: 'field' }, el('div', { class: 'labelrow' }, el('label', { for: 'token-input' }, 'Discord bot token'), show), input)),
      helpLine('Find it in the Discord Developer Portal: your app > Bot > Reset Token, then copy it.', 'Open the Developer Portal', 'portal'),
      el('div', { id: 'token-status', class: 'status-area' }),
      el('details', { class: 'guide' }, el('summary', {}, 'Don\'t have a bot yet? Make one in about a minute'),
        el('ol', {},
          el('li', {}, 'Open the ', el('button', { class: 'link', onclick: () => gb.openLink('portal') }, 'Discord Developer Portal'), ' and sign in with your Discord account.'),
          el('li', {}, 'Click ', el('b', {}, 'New Application'), ' (top right), type any name, tick the box and click ', el('b', {}, 'Create'), '. Good Boy renames it for you later.'),
          el('li', {}, 'In the menu on the left, click ', el('b', {}, 'Bot'), '.'),
          el('li', {}, 'Click ', el('b', {}, 'Reset Token'), ', confirm, then click ', el('b', {}, 'Copy'), '.'),
          el('li', {}, 'On the same page, under ', el('b', {}, 'Privileged Gateway Intents'), ', switch on ', el('b', {}, 'Server Members Intent'), ' and ', el('b', {}, 'Message Content Intent'), ', then click ', el('b', {}, 'Save Changes'), '.'),
          el('li', {}, 'Come back here and paste the token in the box above.'))),
      wizardNav({ on: () => wgo('welcome') }, next),
      el('p', { class: 'note' }, 'Your token is encrypted by this computer and is never shown again after you continue.'));
  }
  if (W.step === 'secret') {
    let err = null;
    const input = el('input', { type: 'password', id: 'secret-input', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste your client secret (optional)', 'aria-label': 'Client secret', value: W.secret, oninput: (e) => { W.secret = e.target.value.trim(); } });
    const go2 = async (skip) => {
      if (!skip && W.secret) { const r = await gb.setupSecret(W.secret); if (!r.ok) { err.textContent = r.error; return; } }
      W.secret = ''; wgo('brand'); refreshBrand();
    };
    err = el('p', { class: 'err' });
    queueMicrotask(() => document.getElementById('secret-input')?.focus());
    return el('div', { class: 'setup wizard' }, stepDots(), el('h1', {}, 'Client secret'),
      el('p', { class: 'sub' }, 'Optional. It lets you sign in to the dashboard with your Discord account. You can add it later in Settings.'),
      el('div', { class: 'group' }, el('div', { class: 'field' }, el('label', { for: 'secret-input' }, 'Client secret'), input)),
      helpLine('Find it in the Discord Developer Portal: your app > OAuth2 > Client Secret > Reset Secret.', 'Open the OAuth2 page', 'oauth'), err,
      redirectBlock(),
      wizardNav({ on: () => wgo('token') }, el('div', { class: 'row-btns' }, el('button', { class: 'btn quiet big', onclick: () => go2(true) }, 'Skip'), el('button', { class: 'btn big', onclick: () => go2(false) }, 'Next'))));
  }
  if (W.step === 'brand') {
    const st = B.status;
    const free = !S.whiteLabel;
    if (free && !B.autoTried && st && !st.done && !B.busy) { B.autoTried = true; queueMicrotask(applyBrandNow); }
    const items = [['avatar', 'Profile picture'], ['banner', 'Profile banner'], ['name', 'Name: Good Boy'], ['icon', 'App icon on the invite page'], ['description', 'Description']];
    const failed = B.results && Object.values(B.results).some((x) => !x.ok);
    return el('div', { class: 'setup wizard' }, stepDots(), el('h1', {}, free ? 'Giving your bot the Good Boy look' : 'Your bot\'s look'),
      el('p', { class: 'sub' }, free ? 'Good Boy puts its name, picture and banner on your bot. This happens by itself.' : 'Your licence lets you use your own name and picture, or the Good Boy look.'),
      el('div', { class: 'brandpreview' }, el('img', { src: 'brand/banner.png', alt: '' }), el('img', { class: 'pfp', src: 'brand/avatar.png', alt: '' }), el('b', {}, 'Good Boy')),
      el('div', { class: 'group' }, items.map(([k, label]) => el('div', { class: 'row' }, el('span', { class: 'lab' }, label),
        el('span', { class: 'val' }, B.results?.[k] && !B.results[k].ok ? el('span', { class: 'meta err', style: { maxWidth: '260px' } }, B.results[k].error) : null,
          el('span', { class: st?.items?.[k] ? 'tag ok' : B.results?.[k] && !B.results[k].ok ? 'tag wait' : 'tag off' }, st?.items?.[k] ? 'Done' : B.results?.[k] && !B.results[k].ok ? 'Not yet' : B.busy ? 'Working...' : st ? 'To do' : '...'))))),
      free && failed ? el('p', { class: 'help' }, 'Good Boy will finish the rest by itself in the background, for example once Discord allows another name change.') : null,
      free ? wizardNav({ on: () => wgo('secret') }, el('button', { class: 'btn big', disabled: B.busy || !st, onclick: () => { wgo('invite'); refreshInvite(); } }, B.busy ? 'Working...' : 'Next'))
        : wizardNav({ on: () => wgo('secret') }, el('div', { class: 'row-btns' },
          el('button', { class: 'btn quiet big', onclick: () => { wgo('invite'); refreshInvite(); } }, 'Keep my own look'),
          st?.done ? el('button', { class: 'btn big', onclick: () => { wgo('invite'); refreshInvite(); } }, 'Next') : el('button', { class: 'btn big', disabled: B.busy, onclick: applyBrandNow }, B.busy ? 'Applying...' : 'Use the Good Boy look'))));
  }
  if (W.step === 'invite') {
    const v = W.verify?.ok ? W.verify : null;
    return el('div', { class: 'setup wizard' }, stepDots(), el('h1', {}, 'Add the bot to your server'),
      el('p', { class: 'sub' }, 'Pick your server on the Discord page that opens, then press Authorize.'),
      v ? botCard(v) : null,
      el('div', { class: 'wnav center' }, el('button', { class: 'btn big', onclick: () => gb.openLink('invite') }, 'Add to my Discord server')),
      el('div', { class: 'group' }, el('div', { class: 'row' }, el('div', { class: 'two' }, el('span', { class: 'lab' }, v?.guilds?.length ? `Your bot is in ${v.guilds.length} server${v.guilds.length === 1 ? '' : 's'}` : 'Your bot is not in a server yet'),
        el('span', { class: 'meta' }, v?.guilds?.length ? v.guilds.slice(0, 4).map((g) => g.name).join(', ') + (v.guilds.length > 4 ? ` and ${v.guilds.length - 4} more` : '') : 'After you add it, press Check again.')),
        el('span', { class: 'val' }, el('button', { class: 'btn quiet', onclick: () => refreshInvite(true) }, W.checking ? 'Checking...' : 'Check again')))),
      intentNote(v),
      wizardNav({ on: () => wgo('brand') }, el('button', { class: 'btn big', onclick: () => wgo('done') }, v?.guilds?.length ? 'Next' : 'I\'ll do this later')));
  }
  // done
  const v = W.verify?.ok ? W.verify : null;
  const row = (label, value, ok) => el('div', { class: 'row' }, el('span', { class: 'lab' }, label), el('span', { class: 'val' }, value, el('span', { class: ok ? 'tag ok' : 'tag off' }, ok ? 'Done' : 'Later')));
  return el('div', { class: 'setup wizard' }, stepDots(), orb('running'), el('h1', {}, 'You\'re all set'),
    el('p', { class: 'sub' }, W.imported ? `Your bot and ${W.imported} came over from your old folder.` : 'Good Boy is ready to go online.'),
    el('div', { class: 'group' }, row('Discord bot token', v ? v.bot.name : 'Saved', true), row('Dashboard login', '', !!S.vault?.hasClientSecret), row('Your server', v?.guilds?.length ? v.guilds[0].name : '', !!v?.guilds?.length)),
    el('div', { class: 'wnav center' }, el('button', { class: 'btn big go', onclick: () => finishSetup(true) }, 'Start the bot')),
    el('p', { class: 'help' }, el('button', { class: 'link', onclick: () => finishSetup(false) }, 'Finish without starting')));
}

function redirectBlock() {
  const uris = W.verify?.app?.redirectUris;
  const added = Array.isArray(uris) ? uris.includes(S.redirectUri) : null;
  return el('div', { class: 'redirect' },
    el('b', {}, 'For the dashboard login, add this redirect'),
    el('p', {}, 'On the OAuth2 page, under Redirects, click Add Redirect, paste this address exactly, then click Save Changes.'),
    el('div', { class: 'copyrow' }, el('code', {}, S.redirectUri), el('button', { class: 'btn quiet', onclick: async () => { await gb.copy(S.redirectUri); toast('Address copied.'); } }, 'Copy')),
    el('div', { class: 'copyrow' }, el('span', { class: added ? 'tag ok' : added === false ? 'tag wait' : 'tag off' }, added ? 'Redirect added' : added === false ? 'Not added yet' : 'Not checked yet'),
      el('button', { class: 'link', onclick: () => gb.openLink('oauth') }, 'Open the OAuth2 page'),
      el('button', { class: 'link', onclick: async () => { const r = await gb.verifyToken(null); if (r.ok) W.verify = r; lastPage = null; render(); toast(r.ok ? (r.app.redirectUris?.includes(S.redirectUri) ? 'Redirect found. The dashboard login will work.' : 'Not there yet. Paste it and click Save Changes.') : r.error, !r.ok || !r.app.redirectUris?.includes(S.redirectUri)); } }, 'Check again')));
}
async function refreshBrand() {
  const r = await gb.brandStatus();
  B.status = r.ok ? r : null; if (!r.ok) toast(r.error, true);
  if (W.step === 'brand' || page === 'settings') { lastPage = null; render(); }
}
async function applyBrandNow() {
  B.busy = true; render();
  const r = await gb.brandApply();
  B.busy = false;
  if (!r.ok) { render(); return toast(r.error, true); }
  B.results = r.results; B.status = r.items ? r : B.status;
  const failed = Object.values(r.results).filter((x) => !x.ok).length;
  toast(failed ? 'Some parts could not be changed. See the list.' : 'Your bot now looks like Good Boy.', !!failed);
  lastPage = null; render();
}
async function refreshInvite(force = false) {
  if (W.checking && !force) return;
  W.checking = true; render();
  const r = await gb.verifyToken(null);
  W.checking = false; if (r.ok) W.verify = r; render();
}
async function useExisting(dir) {
  busy = true; render();
  const r = await gb.setupImport(dir);
  busy = false;
  if (!r.ok) { render(); return toast(r.error, true); }
  const d = r.data;
  W.imported = d?.ok && d.guild ? `${d.guild.name}${d.memberCount ? ` (${d.memberCount} members with levels)` : ''}` : null;
  if (d && !d.ok) toast(`Your settings came over, but the server data could not: ${d.error}`, true);
  wgo('invite'); refreshInvite(true); refreshSummary();
}
async function finishSetup(start) {
  S = await gb.setupFinish(start); forceSetup = false; page = 'overview'; W.step = 'welcome';
  toast(start ? 'Starting your bot...' : 'Setup finished.');
  refreshSummary();
}

// ---------------------------------------------------------------- layout
const NAV = () => [
  ['Bot', [['overview', 'Overview', 'home', 'blue'], ['levels', 'Levels', 'star', 'amber', sum?.memberCount], ['modules', 'Modules', 'puzzle', 'violet', (sum?.modules ?? []).length || null], ['log', 'Log', 'log', 'gray']]],
  [S.edition.id === 'owner' ? 'Owner' : 'App', [['updates', 'Updates', 'down', 'mint'], ...(has('licenses') ? [['licenses', 'Licences', 'key', 'amber']] : []), ['settings', 'Settings', 'gear', 'teal']]],
];
function go(p) { page = p; render(); }

function render() {
  if (!S) return;
  applyTheme();
  document.body.classList.toggle('mac', S.platform === 'darwin');
  const inSetup = S.setupNeeded || forceSetup;
  const current = inSetup ? 'setup' : page;
  if (inSetup && setupFound === null && !finding && has('import')) { finding = true; gb.setupFind().then((f) => { setupFound = f; finding = false; render(); }); }
  // do not wipe what someone is typing into the setup form
  const typing = document.activeElement?.tagName === 'INPUT' && current === 'setup';
  if (typing && lastPage === `setup-${W.step}`) return;
  if (current === 'settings' && lastPage === 'settings' && document.activeElement?.id === 'new-secret') return;
  const side = el('aside', { class: 'side', 'aria-label': 'Good Boy' },
    el('div', { class: 'brand' }, el('img', { src: 'good-boy-logo.png', alt: '' }), 'Good Boy', S.edition.name ? el('span', { class: 'edition' }, S.edition.name) : null),
    inSetup ? null : NAV().map(([label, rows]) => [el('div', { class: 'group-label' }, label), rows.map(([id, text, ic, color, count]) => el('button', { class: 'nav', 'data-nav': id, 'aria-current': current === id ? 'page' : null, onclick: () => go(id) }, tile(ic, color), text, count ? el('span', { class: 'count' }, count) : null))]),
    el('div', { class: 'server' }, el('span', { class: 'av' }, (sum?.guild?.name ?? 'Good Boy').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()), el('div', {}, el('b', {}, sum?.guild?.name ?? 'No server yet'), el('small', {}, S.edition.id === 'owner' ? 'Owner' : S.edition.id === 'developer' ? 'Developer' : 'Your server'))));
  const key = current === 'setup' ? `setup-${W.step}` : current;
  const main = el('main', { 'data-page': current, 'data-step': current === 'setup' ? W.step : null, class: key !== lastPage ? 'enter' : '' }, el('div', { class: 'wrap' }, PAGES[current]()));
  lastPage = key;
  app.classList.toggle('in-setup', inSetup);
  app.replaceChildren(...(inSetup ? [main] : [side, main]));
}

async function refreshSummary() {
  if (!S || S.setupNeeded) { render(); return; }
  const r = await gb.summary();
  if (r?.ok) sum = r;
  render();
}

gb.onState((s) => { const was = S?.bot?.state; S = s; if (s.bot.state !== 'running') MOD.live = null; if (s.bot.state !== was && s.bot.state === 'running') toast('The bot is online.'); if (was === 'running' && s.bot.state === 'failed') toast(s.bot.error || 'The bot stopped.', true); refreshSummary(); });
gb.onLog((line) => {
  logLines.push(line); if (logLines.length > 1000) logLines.shift();
  const pre = document.querySelector('pre.log');
  if (pre) { const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40; pre.textContent = logLines.join('\n'); if (atEnd) pre.scrollTop = pre.scrollHeight; }
});
gb.state().then((s) => { S = s; logLines = s.logs ?? []; refreshSummary(); });
setInterval(() => { if (S && !S.setupNeeded && document.visibilityState === 'visible') refreshSummary(); }, 30000);
