// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Every page is built from DOM nodes and text only (no HTML strings), so names can't inject script.
const app = document.getElementById('app');

// Browser-only preferences. Storage can be blocked, so every read and write is guarded.
const pref = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked: the choice just won't be remembered */ } },
};
const state = { me: null, gid: null, data: null, live: null, pulse: null, activity: [], panels: new Map(), page: 'overview', theme: pref.get('gb-theme', 'dark'), motion: pref.get('gb-motion', 'on') !== 'off' };

function applyAppearance() {
  document.body.classList.toggle('theme-light', state.theme === 'light');
  document.body.classList.toggle('theme-blue', state.theme === 'blue');
  document.body.classList.toggle('motion-off', !state.motion);
}
applyAppearance();
// Back to the phone app after logging in from it.
if (pref.get('gb-return', '') === '/app') { pref.set('gb-return', ''); location.replace('/app'); }

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

function toast(msg, bad, undo) {
  const t = document.getElementById('toast');
  put(t, msg);
  if (typeof undo === 'function') t.append(h('button', { type: 'button', class: 'undo', onclick: () => { t.className = ''; undo(); } }, 'Undo'));
  t.className = 'show' + (bad ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), undo ? 6000 : 3500);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GoodBoy': '1' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}

function clear() { app.replaceChildren(); }
/** replaceChildren() prints null/undefined as the words "null"/"undefined", so empty parts are dropped first. */
function put(el, ...kids) { el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)); return el; }

/**
 * The page's own dialog, instead of the browser's prompt/confirm boxes.
 * field: { type: 'number' | 'text' | 'select', options: [{ value, label }], value, placeholder }
 * confirmWord: the person must type it (for big, irreversible actions).
 * Resolves to the entered value (or true when there is no field), or null when cancelled.
 */
function ask({ title, text, field = null, confirmWord = null, okLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    let input = null;
    if (field?.type === 'select') input = h('select', { class: 'field' }, field.options.map((o) => h('option', { value: o.value, selected: o.value === field.value }, o.label)));
    else if (field?.type === 'paragraph') input = h('textarea', { class: 'field', placeholder: field.placeholder ?? '', maxlength: field.max ?? 1000 }, field.value ?? '');
    else if (field) input = h('input', { class: 'field', type: field.type === 'number' ? 'number' : 'text', value: field.value ?? '', placeholder: field.placeholder ?? '' });
    const word = confirmWord ? h('input', { class: 'field', type: 'text', placeholder: confirmWord, autocomplete: 'off' }) : null;
    const ok = h('button', { class: danger ? 'danger' : '' }, okLabel);
    const cancel = h('button', { class: 'ghost' }, 'Cancel');
    const done = (v) => { back.remove(); document.removeEventListener('keydown', key); prev?.focus?.(); resolve(v); };
    const value = () => (field ? (field.type === 'number' ? Number(input.value) : input.value) : true);
    const valid = () => (!word || word.value === confirmWord) && (!field || field.type === 'select' || String(input.value).trim() !== '') && (field?.type !== 'number' || Number.isFinite(Number(input.value)));
    const refresh = () => { ok.disabled = !valid(); };
    const key = (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter' && field?.type !== 'paragraph' && valid()) done(value()); };
    ok.addEventListener('click', () => valid() && done(value()));
    cancel.addEventListener('click', () => done(null));
    for (const x of [input, word]) x?.addEventListener('input', refresh);
    const back = h('div', { class: 'dialog-back', role: 'presentation' },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h3', {}, title), text ? h('p', { class: 'muted' }, text) : null, input,
        word ? h('label', { class: 'small' }, `Type ${confirmWord} to confirm`) : null, word,
        h('div', { class: 'dialog-buttons' }, cancel, ok)));
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    document.addEventListener('keydown', key);
    document.body.append(back);
    refresh();
    (input ?? word ?? ok).focus();
  });
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- sign-in and server list
async function boot() {
  try { state.me = await api('/api/me'); }
  catch (e) {
    clear();
    app.append(h('div', { class: 'card welcome' }, h('img', { src: '/good-boy-logo.png', alt: 'Good Boy logo' }), h('h2', {}, 'Sign in to Good Boy'),
      h('p', { class: 'muted' }, e.data?.loginReady === false
        ? 'Login is not set up yet. Add DISCORD_CLIENT_SECRET to your .env file (see the README) and restart the bot.'
        : 'Log in with Discord to manage your servers.'),
      h('a', { class: 'btn', href: '/login' }, 'Log in with Discord')));
    return;
  }
  document.getElementById('who').replaceChildren(document.createTextNode(state.me.user.username + ' · '), h('a', { href: '/logout', class: 'muted' }, 'log out'));
  mountIsland();
  // A link from another Good Boy bot's switcher opens that server straight away (?guild=<id>).
  const asked = new URLSearchParams(location.search).get('guild');
  if (asked && state.me.guilds.some((g) => g.id === asked)) { state.gid = asked; history.replaceState(null, '', location.pathname); }
  state.gid ? await loadGuild() : showGuilds();
  whatsNewOnce();
}

function showGuilds() {
  state.gid = null; stopLive(); clear();
  app.append(h('h2', {}, 'Your servers'));
  if (!state.me.guilds.length) {
    app.append(h('p', { class: 'muted' }, "I'm not in any server where you can use the dashboard. Add me to one, or ask an admin to give your role the dashboard.access permission."));
    return;
  }
  app.append(h('div', { class: 'grid' }, state.me.guilds.map((g) =>
    h('button', { class: 'card guild', 'aria-label': g.name, onclick: () => { state.gid = g.id; state.page = 'overview'; loadGuild(); } },
      g.icon ? h('img', { src: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96`, alt: '' }) : h('div', { class: 'ph' }, g.name.slice(0, 1)),
      h('div', {}, g.name),
      g.access === 'panel' ? h('div', { class: 'hint' }, 'limited access') : null))));
}

async function loadGuild() {
  try { state.data = await api(`/api/guilds/${state.gid}`); }
  catch (e) { toast(e.message, true); return showGuilds(); }
  if (!pages().some((p) => p.id === state.page)) state.page = 'overview';
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
  startLive();
}

// ---------------------------------------------------------------- live updates (2.3)
// One stream per open server. The bot sends a pulse every 15 seconds and an event whenever something changes,
// so numbers, panels and the activity feed update by themselves.
function stopLive() { state.live?.es.close(); state.live = null; }
/* The Dynamic Island in the top bar: bot status, live news flowing in, quick jumps when opened. */
function mountIsland() {
  if (!window.GB || document.querySelector('.gb-island')) return;
  const bar = document.querySelector('.topbar');
  const who = document.getElementById('who');
  const wrap = GB.island.mount(bar, { actions: [
    { label: '⌂ Overview', run: () => { GB.island.toggle(); go('overview'); } },
    { label: '▦ Modules', run: () => { GB.island.toggle(); go('modules'); } },
    { label: '🤖 AutoMod', run: () => { GB.island.toggle(); go('automod'); } },
  ] });
  if (wrap && who) bar.insertBefore(wrap, who);
  wrap?.classList.add('gb-dock');
  GB.island.status({ text: 'Good Boy', title: 'Good Boy', sub: 'Pick a server to see it live', ok: true });
}
function islandStatus() {
  if (!window.GB) return;
  const p = state.pulse ?? {};
  GB.island.status({ text: state.data?.guild?.name ? `${state.data.guild.name} · live` : 'Good Boy', ms: p.ping ?? null, ok: !!state.live,
    title: state.data?.guild?.name ?? 'Good Boy', sub: [p.members != null ? `${p.members} members` : null, p.inVoice ? `${p.inVoice} in voice` : null, p.uptimeSeconds != null ? `up ${duration(p.uptimeSeconds)}` : null].filter(Boolean).join(' · ') });
  GB.island.feed((state.activity ?? []).slice(0, 4).map((a) => `${a.icon ?? '•'} ${a.text}`));
}

function startLive() {
  if (state.live?.gid === state.gid || typeof EventSource === 'undefined') return;
  stopLive();
  const es = new EventSource(`/api/guilds/${state.gid}/live`);
  state.live = { es, gid: state.gid };
  const on = (type, fn) => es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch { /* ignore a bad event */ } });
  on('hello', (d) => { state.activity = d.activity ?? []; paintFeed(); liveChip('on'); islandStatus(); });
  on('pulse', (d) => { state.pulse = d; paintPulse(); liveChip('on'); islandStatus(); });
  on('activity', (d) => { state.activity.unshift(d); state.activity.length = Math.min(state.activity.length, 30); paintFeed(true); islandStatus(); window.GB?.island.news(d.icon ?? '•', d.text); });
  on('data', (d) => refreshModule(d.module));
  on('modules', () => softReload());
  on('settings', () => softReload());
  on('feedback', () => { if (state.page === 'feedback') render(); else if (state.data?.access === 'admin') toast('💬 New feedback from a tester'); });
  es.onerror = () => liveChip('off');
}
function liveChip(mode) {
  const c = document.getElementById('live-chip');
  if (!c) return;
  c.className = 'live-chip ' + (mode === 'on' ? 'on' : 'off');
  c.textContent = mode === 'on' ? `● Live${state.pulse?.ping != null ? ` · ${state.pulse.ping} ms` : ''}` : '○ Reconnecting…';
}
/** Numbers on the page with data-stat="..." follow the pulse, with a small bump when they change. */
function paintPulse() {
  const p = state.pulse ?? {};
  const values = { members: p.members, inVoice: p.inVoice, ping: p.ping != null ? `${p.ping} ms` : null, uptime: p.uptimeSeconds != null ? duration(p.uptimeSeconds) : null, modulesOn: p.modulesOn };
  for (const el of document.querySelectorAll('[data-stat]')) {
    const v = values[el.dataset.stat];
    if (v == null || String(v) === el.textContent) continue;
    el.textContent = String(v);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  }
  liveChip('on');
}
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
function paintFeed(fresh = false) {
  const list = document.getElementById('feed');
  if (!list) return;
  put(list, state.activity.length ? state.activity.slice(0, 12).map((a, k) => h('li', { class: fresh && k === 0 ? 'enter' : '' },
    h('span', { class: 'feed-icon', 'aria-hidden': 'true' }, a.icon ?? '•'), h('span', { class: 'feed-text' }, a.text), h('time', {}, ago(a.at))))
    : h('li', { class: 'feed-empty' }, 'Quiet for now. Things that happen in the server appear here the moment they happen.'));
}
setInterval(() => paintFeed(), 30000); // keeps the "x min ago" labels current
const pending = new Map();
function refreshModule(mod) {
  clearTimeout(pending.get(mod));
  pending.set(mod, setTimeout(() => { for (const fn of state.panels.get(mod) ?? []) fn(); }, 400));
}
let reloadTimer = null;
function softReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    // Never yank a form out from under someone who is typing or has a dialog open: offer a refresh instead.
    const busy = document.querySelector('.dialog-back') || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.closest('.workspace'));
    if (busy) { const b = document.getElementById('changed-banner'); if (b) b.hidden = false; return; }
    loadGuild();
  }, 700);
}

// ---------------------------------------------------------------- pages and navigation
const ICON = { moderation: '🛡', support: '🎫', community: '🏆', engagement: '💬', voice: '🔊', quotes: '❝', reminders: '⏰', roles: '🏷', integrations: '🔌', 'member-management': '👥', stats: '📊', achievements: '🏆', eclipseid: '🪪', partyfinder: '🎮', tempvoice: '🎙', economy: '🪙', games: '🎰', deadchat: '💬' };
const TITLE = { moderation: 'Moderation', support: 'Support', community: 'Community', engagement: 'Engagement', voice: 'Voice', quotes: 'Quotes', reminders: 'Reminders', roles: 'Roles', integrations: 'Integrations', 'member-management': 'Members', stats: 'Statistics', achievements: 'Achievements', eclipseid: 'Member ID', partyfinder: 'Party Finder', tempvoice: 'Temporary voice', economy: 'Economy', games: 'Games', deadchat: 'Dead chat ping' };

/**
 * Every page this person can open, laid out like the 3.0 design: Home, Modules, Tickets, Members, Moderation; then Fun
 * (Arcade, Fishing, Music) and Bot (Logs, Settings). Other tools stay reachable from Home. Panel-only people get the
 * pages for the tools they hold.
 */
function pages() {
  const d = state.data, admin = d.access === 'admin';
  const on = (name) => d.modules.find((m) => m.name === name && (admin ? m.enabled : true));
  const hasPanel = (name, id) => (on(name)?.panels ?? []).some((p) => !id || p.id === id);
  const list = [{ id: 'overview', icon: '⌂', label: 'Home', group: '' }];
  if (admin) list.push({ id: 'modules', icon: '▦', label: 'Modules', group: '' });
  if (hasPanel('support', 'archive')) list.push({ id: 'tickets', icon: '🎫', label: 'Tickets', group: '' });
  if (hasPanel('community')) list.push({ id: 'tool:community', icon: '👥', label: 'Members', group: '' });
  const mod = on('moderation');
  if (mod && (admin || hasPanel('moderation', 'automod') || hasPanel('moderation', 'cases'))) list.push({ id: 'automod', icon: '🛡', label: 'Moderation', group: '' });
  if (admin && on('games')) list.push({ id: 'arcade', icon: '🎮', label: 'Arcade', group: 'FUN' }, { id: 'fishing', icon: '🎣', label: 'Fishing', group: 'FUN' });
  if (admin && on('music')) list.push({ id: 'module:music', icon: '🎵', label: 'Music', group: 'FUN' });
  if (admin) list.push({ id: 'logs', icon: '≡', label: 'Logs', group: 'BOT' });
  list.push({ id: 'settings', icon: '⚙', label: 'Settings', group: 'BOT' });
  // Reachable, but not in the sidebar: the other tools, and pages opened from Settings or Home.
  for (const m of d.modules) if ((admin ? m.enabled : true) && (m.panels ?? []).length && !list.some((x) => x.id === `tool:${m.name}`)) list.push({ id: `tool:${m.name}`, icon: ICON[m.name] ?? '◆', label: TITLE[m.name] ?? cap(m.name), hidden: true });
  for (const [id, label] of [['permissions', 'Permissions'], ['feedback', 'Tester feedback'], ['whatsnew', "What's new"], ['appearance', 'Appearance']]) if (admin || id === 'whatsnew' || id === 'appearance') list.push({ id, label, hidden: true });
  if (state.me?.botOwner) list.push({ id: 'updates', label: 'Updates', hidden: true });
  if (String(state.page).startsWith('module:') && !list.some((x) => x.id === state.page)) list.push({ id: state.page, icon: '▦', label: 'Modules', hidden: true });
  return list;
}

function go(id) { state.page = id; window.GB ? GB.transition(render) : render(); }

function render() {
  clear();
  const d = state.data, list = pages(), current = list.find((p) => p.id === state.page) ?? list[0];
  const side = h('aside', { class: 'side glass', 'aria-label': 'Dashboard navigation' });
  let group = null;
  side.append(h('div', { class: 'side-brand' }, h('img', { src: '/good-boy-logo.png', alt: '' }), h('strong', {}, 'Good Boy'), h('span', { class: 'muted' }, state.me?.version ?? '')));
  side.append(serverSwitcher());
  for (const p of list) {
    if (p.hidden) continue;
    if (p.group !== group) { group = p.group; if (group) side.append(h('div', { class: 'side-label' }, group)); }
    const on = p.id === current.id || (p.id === 'modules' && current.id.startsWith('module:'));
    side.append(h('button', { class: 'nav-item' + (on ? ' active' : ''), title: p.label, 'aria-current': on ? 'page' : null, onclick: () => go(p.id) },
      h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, p.icon), h('span', { class: 'nav-name' }, p.label)));
  }
  side.append(h('div', { class: 'side-foot' }, h('span', { id: 'live-chip', class: 'live-chip off' }, '○ Connecting…'), h('span', { class: 'grow' }), h('a', { href: '/logout', class: 'muted', title: `Signed in as ${state.me?.user?.username ?? ''}` }, 'Log out')));

  const workspace = h('section', { class: 'workspace' });
  if (current.id === 'tickets') workspace.classList.add('bleed');
  else workspace.append(h('div', { class: 'pagehead' }, h('div', {}, h('h1', {}, current.id === 'overview' ? greeting() : current.label), h('p', { class: 'muted' }, current.id === 'overview' ? homeSub() : d.guild.name)),
    h('div', { class: 'row-end' }, d.access === 'panel' ? h('span', { class: 'badge' }, 'limited access') : null)));
  workspace.append(h('div', { id: 'changed-banner', class: 'banner', hidden: true }, 'Something changed in this server while you were editing. ',
    h('button', { class: 'ghost', onclick: () => loadGuild() }, 'Show the latest')));
  app.append(h('div', { class: 'shell' }, side, workspace), feedbackButton());
  state.panels = new Map();

  if (current.id === 'overview') renderHome(workspace);
  else if (current.id === 'modules') renderModules(workspace);
  else if (current.id.startsWith('module:')) renderModulePage(workspace, current.id.slice(7));
  else if (current.id === 'automod') renderModeration(workspace);
  else if (current.id === 'permissions') renderPermissions(workspace);
  else if (current.id === 'logs') renderLogs(workspace);
  else if (current.id === 'updates') renderUpdates(workspace);
  else if (current.id === 'appearance') renderAppearance(workspace);
  else if (current.id === 'whatsnew') renderWhatsNew(workspace);
  else if (current.id === 'tickets') workspace.append(ticketArchive(state.data.modules.find((m) => m.name === 'support')));
  else if (current.id === 'settings') renderSettingsHub(workspace);
  else if (current.id === 'arcade') renderGames(workspace, false);
  else if (current.id === 'fishing') renderGames(workspace, true);
  else if (current.id === 'feedback') renderFeedback(workspace);
  else if (current.id.startsWith('tool:')) renderTool(workspace, current.id.slice(5));
  if (state.live) { liveChip('on'); paintPulse(); paintFeed(); }
}

function duration(sec) {
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`;
}

function renderOverview(ws) {
  const d = state.data;
  ws.append(h('div', { class: 'card hero glass' }, h('img', { src: '/good-boy-logo.png', alt: 'Good Boy logo' }),
    h('div', {}, h('h2', {}, d.guild.name), h('p', { class: 'muted' }, d.access === 'admin' ? 'Manage this server, configure features and keep your community safe.' : 'You can use the panels below. Ask an admin if you need more.'))));
  if (d.access === 'admin') {
    const on = d.modules.filter((m) => m.enabled);
    const stats = [['Members', d.stats.members ?? '—', 'members'], ['In voice now', '—', 'inVoice'], ['Active modules', `${on.length} / ${d.modules.length}`, null], ['Bot uptime', duration(d.stats.uptimeSeconds), 'uptime']];
    ws.append(h('div', { class: 'stats' }, stats.map(([label, value, key]) => h('div', { class: 'card stat' }, h('div', { class: 'muted' }, label), h('strong', key ? { 'data-stat': key } : {}, value)))));
  }
  ws.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Live activity'), h('span', { class: 'hint' }, 'updates by itself')), h('ul', { id: 'feed', class: 'feed' })));
  if (d.access === 'admin') ws.append(testersCard());
  if (state.me?.botOwner) ws.append(signedInCard());
  const tools = pages().filter((p) => p.id.startsWith('tool:'));
  if (tools.length) {
    ws.append(h('h3', { class: 'section-title' }, 'Quick access'));
    ws.append(h('div', { class: 'quick-grid' }, tools.map((p) => {
      const m = d.modules.find((x) => x.name === p.id.slice(5));
      return h('button', { class: 'card quick glass', onclick: () => go(p.id) }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, p.icon),
        h('span', {}, h('strong', {}, p.label), h('small', {}, (m.panels ?? []).map((x) => x.title).join(' · '))));
    })));
  }
  if (d.access === 'admin') {
    ws.append(h('div', { class: 'card' }, h('h3', {}, 'Module status'), h('p', { class: 'muted' }, 'Live from this server'),
      h('div', { class: 'checks' }, d.modules.map((m) => h('span', { class: 'badge ' + (m.enabled ? m.status : '') }, (m.enabled ? '● ' : '○ ') + m.name)))));
  }
}

// ---------------------------------------------------------------- updates (bot owner only)
function renderUpdates(ws) {
  const box = h('div', { class: 'card' }, h('h3', {}, 'Updates'), h('p', { class: 'muted' }, 'Loading...'));
  ws.append(box);
  let armed = false, polling = null;
  const when = (t) => (t ? new Date(t).toLocaleString() : 'never');
  async function load(path = '/api/updates', body) {
    let r;
    try { r = await api(path, body); } catch (e) { put(box, h('h3', {}, 'Updates'), h('p', { class: e.status === 403 ? 'muted' : 'err' }, e.message)); return null; }
    paint(r); return r;
  }
  function paint(r) {
    if (!r.supervised) { put(box, h('h3', {}, 'Updates'), h('p', { class: 'muted' }, r.message)); return; }
    if (!r.ok) { put(box, h('h3', {}, 'Updates'), h('p', { class: 'err' }, r.error || 'The supervisor did not answer.')); return; }
    const st = r.status, u = st.update, found = u.lastCheck?.release;
    const rows = [['Running', `${st.version}${st.trial ? ' (on trial, not yet confirmed)' : ''}`], ['State', st.state], ['Channel', u.channel ?? 'updates not set up'], ['Last checked', when(u.lastCheck?.at)]];
    if (u.lastError) rows.push(['Problem', u.lastError]);
    if (u.lastResult) rows.push(['Last update', u.lastResult.ok ? `installed ${u.lastResult.version}` : `failed (${u.lastResult.reason || 'unknown'}); went back to the previous version`]);
    if (u.failed?.length) rows.push(['Rolled back before', u.failed.join(', ')]);
    put(box, h('h3', {}, 'Updates'),
      h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))),
      found ? h('div', { class: 'card inset' }, h('strong', {}, `Version ${found.version} is available`), h('span', { class: 'badge' }, found.channel),
        found.blocked ? h('p', { class: 'err' }, `Cannot install: ${found.blocked}.`) : null,
        found.previouslyFailed ? h('p', { class: 'err' }, 'This version was rolled back on this computer before.') : null,
        h('pre', { class: 'notes' }, found.notes || 'No release notes.'),
        found.blocked ? null : h('button', { onclick: apply }, armed ? 'Click again to install and restart' : `Install ${found.version}`),
        h('p', { class: 'muted' }, 'The bot restarts for a minute or so. Your data is copied first, and if the new version does not start it goes back by itself.'))
        : h('p', { class: 'muted' }, u.lastCheck ? 'You are up to date.' : 'No check has been made yet.'),
      h('p', {}, h('button', { class: 'ghost', onclick: check }, 'Check now')));
  }
  async function check() { toast('Checking...'); const r = await load('/api/updates/check', {}); if (r && !r.ok) toast(r.error, true); }
  async function apply() {
    if (!armed) { armed = true; const r = await load(); setTimeout(() => { armed = false; }, 6000); return r; }
    armed = false;
    try { const r = await api('/api/updates/apply', { confirm: true }); if (!r.ok) { toast(r.error, true); return; } } catch (e) { toast(e.message, true); return; }
    put(box, h('h3', {}, 'Updating...'), h('p', { class: 'muted' }, 'The bot is restarting. This page reconnects by itself.'));
    clearInterval(polling);
    polling = setInterval(async () => { try { const r = await api('/api/updates'); if (r.ok && r.status.state === 'running') { clearInterval(polling); paint(r); toast('Update finished.'); } } catch { /* still restarting */ } }, 4000);
  }
  load();
}

function renderAppearance(ws) {
  ws.append(h('div', { class: 'card' }, h('h3', {}, 'Appearance'), h('p', { class: 'muted' }, 'Personal browser preferences. These do not change any server setting.'),
    h('div', { class: 'appearance' }, ['dark', 'light', 'blue'].map((t) => h('button', { class: state.theme === t ? '' : 'ghost', onclick: () => { state.theme = t; pref.set('gb-theme', t); applyAppearance(); render(); } }, cap(t) + ' glass'))),
    h('p', {}, h('button', { class: 'ghost', onclick: () => { state.motion = !state.motion; pref.set('gb-motion', state.motion ? 'on' : 'off'); applyAppearance(); render(); } }, state.motion ? 'Pause background animation' : 'Resume background animation'))));
}

async function act(fn, ok) {
  try { await fn(); toast(ok); await loadGuild(); } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- AutoMod page (2.3.2)
const AM_ACTIONS = [['default', 'Server default'], ['delete', 'Delete it'], ['delete-warn', 'Delete + warn'], ['delete-timeout', 'Delete + time out']];
async function renderAutomod(ws) {
  const base = `/api/guilds/${state.gid}/modules/moderation`;
  const box = h('div', {}, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading AutoMod…')));
  const testState = { text: '', results: null }; // survives the page repainting itself when something changes
  ws.append(box);
  const run = async (action, body, ok) => { try { const r = await api(`${base}/actions/${action}`, body); if (ok) toast(ok); return r.result ?? r; } catch (e) { toast(e.message, true); throw e; } };
  const reload = async () => { try { paint(await api(`${base}/views/automodpage`)); } catch (e) { put(box, h('div', { class: 'card' }, h('p', { class: 'muted' }, e.message))); } };
  const select = (options, value, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const num = (value, min, max, onchange) => h('input', { type: 'number', class: 'num', value, min, max, onchange: (e) => onchange(Number(e.target.value)) });
  const sw = (checked, label, onchange) => h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label, checked, onchange: (e) => onchange(e.target.checked) });
  function chips(list, kind, placeholder) {
    const wrap = h('div', { class: 'chipbox' });
    const input = h('input', { placeholder, 'aria-label': placeholder, onkeydown: async (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      e.preventDefault(); await run('automod-list', { list: kind, op: 'add', value: input.value }, `Added "${input.value.trim()}"`); reload();
    } });
    for (const w of list) wrap.append(h('span', { class: 'chipx' }, w, h('button', { type: 'button', 'aria-label': `Remove ${w}`, onclick: async () => { await run('automod-list', { list: kind, op: 'remove', value: w }, `Removed "${w}"`); reload(); } }, '✕')));
    wrap.append(input);
    return wrap;
  }
  function paint(d) {
    const presets = h('div', { class: 'segbar', role: 'group', 'aria-label': 'Preset' }, ['off', 'relaxed', 'balanced', 'strict'].map((p) =>
      h('button', { type: 'button', class: d.preset === p ? 'on' : '', 'aria-pressed': String(d.preset === p), onclick: async () => { await run('automod-preset', { preset: p }, `AutoMod set to ${cap(p)}`); reload(); } }, cap(p))));
    const head = h('div', { class: 'card glass' },
      h('div', { class: 'row' }, h('div', {}, h('h2', { class: 'am-title' }, 'AutoMod'), h('p', { class: 'muted' }, 'Checks every message and removes the bad ones. Pick a starting point, then fine-tune any rule.')),
        h('div', { class: 'row-end' }, presets)),
      h('div', { class: 'row am-sub' }, h('span', { class: 'muted' }, d.preset === 'custom' ? 'Custom settings (changed from a preset).' : `Using the ${cap(d.preset)} preset.`),
        h('label', { class: 'inline' }, 'When a rule is broken: ', select(AM_ACTIONS.slice(1), d.defaultAction, async (v) => { await run('automod-set', { key: 'automodAction', value: v }, 'Saved'); }))));

    const out = h('div', { class: 'am-results' });
    const ta = h('textarea', { placeholder: 'Type or paste a message to see what AutoMod would do. Nothing is posted or deleted.', 'aria-label': 'Message to test', oninput: (e) => { testState.text = e.target.value; } });
    ta.value = testState.text;
    const showResults = (results) => {
      const hits = results.filter((x) => x.hit && x.on);
      put(out, h('p', {}, hits.length ? h('strong', { class: 'bad' }, `⛔ This message would be caught by ${hits.map((x) => x.label.toLowerCase()).join(', ')}.`) : h('strong', { class: 'good' }, '✅ This message would be allowed.')),
        h('ul', { class: 'am-list' }, results.map((x) => h('li', { class: x.hit ? (x.on ? 'bad' : 'warn') : '' }, `${x.hit ? (x.on ? '⛔' : '⚠️') : '✓'} ${x.label}: ${x.why}${x.hit && !x.on ? ' (but this rule is off)' : ''}`))));
    };
    if (testState.results) showResults(testState.results);
    const test = h('div', { class: 'card' }, h('h3', {}, 'Test a message'), ta,
      h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Spam and repeats depend on timing, so they are not part of the test.'),
        h('button', { type: 'button', onclick: async () => {
          testState.text = ta.value;
          const r = await run('automod-test', { text: ta.value });
          testState.results = r.results; showResults(r.results);
        } }, 'Test')), out);

    const rules = h('div', { class: 'am-grid' }, d.rules.map((r) => {
      const card = h('div', { class: 'card am-rule' + (r.on ? ' is-on' : '') },
        h('div', { class: 'am-head' }, h('div', {}, h('strong', {}, r.label), h('div', { class: 'muted' }, r.desc)),
          sw(r.on, r.label, async (on) => { await run('automod-rule', { rule: r.id, enabled: on }, `${r.label} ${on ? 'on' : 'off'}`); reload(); })),
        r.on && r.limit !== null ? h('div', { class: 'am-field' }, h('span', { class: 'am-label' }, 'Limit'), h('span', { class: 'inline nowrap' }, num(r.limit, r.min, r.max, async (v) => { await run('automod-rule', { rule: r.id, limit: v }, 'Saved'); }), ` ${r.unit}`,
          r.id === 'spam' ? [' in ', num(d.spamWindow, 2, 60, async (v) => { await run('automod-set', { key: 'spamWindowSeconds', value: v }, 'Saved'); }), ' seconds'] : null,
          r.id === 'repeat' ? [' in ', num(d.repeatWindow, 5, 600, async (v) => { await run('automod-set', { key: 'repeatWindowSeconds', value: v }, 'Saved'); }), ' seconds'] : null)) : null,
        r.on ? h('div', { class: 'am-field' }, h('span', { class: 'am-label' }, 'When it happens'), select(AM_ACTIONS, r.action, async (v) => { await run('automod-rule', { rule: r.id, action: v }, 'Saved'); })) : null,
        r.on && r.id === 'words' ? chips(d.words, 'words', 'Add a word and press Enter') : null,
        r.on && r.id === 'links' ? [h('div', { class: 'hint' }, 'Allowed sites:'), chips(d.domains, 'domains', 'Add a site (like youtube.com) and press Enter')] : null,
        h('div', { class: 'hint' }, r.caught ? `Caught ${r.caught} message${r.caught === 1 ? '' : 's'} in the last 7 days` : 'Nothing caught in the last 7 days'));
      return card;
    }));

    const P = d.protect;
    const protect = h('div', { class: 'card' }, h('h3', {}, 'Server protection'),
      h('div', { class: 'row' }, h('div', {}, h('strong', {}, 'Raid protection'), h('div', { class: 'muted' }, 'Lots of people joining at once.')), sw(P.raidProtection, 'Raid protection', async (on) => { await run('automod-set', { key: 'raidProtection', value: on }, 'Saved'); reload(); })),
      P.raidProtection ? h('div', { class: 'row' }, h('span', { class: 'inline' }, num(P.raidJoinThreshold, 3, 100, async (v) => { await run('automod-set', { key: 'raidJoinThreshold', value: v }, 'Saved'); }), ' joins within ', num(P.raidWindowSeconds, 3, 120, async (v) => { await run('automod-set', { key: 'raidWindowSeconds', value: v }, 'Saved'); }), ' seconds'),
        select([['alert', 'Alert staff'], ['timeout', 'Time out new joins'], ['kick', 'Kick new joins']], P.raidAction, async (v) => { await run('automod-set', { key: 'raidAction', value: v }, 'Saved'); })) : null,
      h('div', { class: 'row' }, h('div', {}, h('strong', {}, 'New accounts'), h('div', { class: 'muted' }, 'Accounts made very recently (often alts or spammers).')),
        h('span', { class: 'inline' }, 'Younger than ', num(P.minAccountAgeDays, 0, 365, async (v) => { await run('automod-set', { key: 'minAccountAgeDays', value: v }, 'Saved'); }), ' days (0 = off) ',
          select([['alert', 'Alert staff'], ['kick', 'Kick']], P.newAccountAction, async (v) => { await run('automod-set', { key: 'newAccountAction', value: v }, 'Saved'); }))),
      h('div', { class: 'row' }, h('div', {}, h('strong', {}, 'Anti-nuke'), h('div', { class: 'muted' }, 'Stops someone deleting channels or banning lots of people at once.')), sw(P.antiNuke, 'Anti-nuke', async (on) => { await run('automod-set', { key: 'antiNuke', value: on }, 'Saved'); reload(); })));

    const recent = h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Recently caught'), h('span', { class: 'hint' }, 'updates live')),
      d.recent.length ? h('table', {}, h('tr', {}, ['When', 'Member', 'Channel', 'Rule', 'What happened', 'Message'].map((x) => h('th', {}, x))),
        d.recent.map((e) => h('tr', {}, [e.when, e.member, e.channel, e.rule, e.action, e.preview].map((x) => h('td', {}, x || '—'))))) : h('p', { class: 'empty-note' }, 'Nothing caught yet. That is a good sign.'),
      d.exemptions.length ? h('p', { class: 'hint' }, `Not checked: ${d.exemptions.join(' · ')}. Change with /automod exempt in Discord.`) : null);

    put(box, head, test, h('h3', { class: 'section-title' }, 'Rules'), rules, protect, recent);
  }
  // refresh in place when AutoMod catches something or a setting changes
  if (!state.panels.has('moderation')) state.panels.set('moderation', new Set());
  const refresher = () => { if (!box.isConnected) { state.panels.get('moderation')?.delete(refresher); return; } reload(); };
  state.panels.get('moderation').add(refresher);
  reload();
}

// ---------------------------------------------------------------- tools (panels)
function renderTool(ws, name) {
  const m = state.data.modules.find((x) => x.name === name);
  if (!m) { ws.append(h('div', { class: 'card empty' }, h('p', { class: 'muted' }, 'That tool is not available.'))); return; }
  ws.append(h('div', { class: 'card' }, h('h3', {}, TITLE[name] ?? cap(name)), h('p', { class: 'muted' }, m.description || '')));
  for (const panel of m.panels ?? []) ws.append(panel.kind === 'ticket-archive' ? h('div', {}, h('h3', { class: 'ta-title' }, panel.title), ticketArchive(m)) : panelBox(m, panel));
}

/**
 * Generic management panel: a table from a module's view, row actions, and confirmed global actions.
 * Panel fields modules can use: description, empty (text when there are no rows), recentTitle, recentEmpty,
 * columns[].hint (explains a column), columns[].kind 'member' (picture + name) or 'rank'.
 * Row actions: prompt 'number' | 'text' | 'select' (with options [{ value, label }]), hint, confirm (text), danger.
 */
function cell(c, r) {
  const v = r[c.key];
  if (c.kind === 'member') return h('td', {}, h('span', { class: 'member' }, r.avatar ? h('img', { src: r.avatar, alt: '', loading: 'lazy' }) : h('span', { class: 'ph' }, String(v ?? '?').slice(0, 1)), h('span', {}, v ?? '')));
  if (c.kind === 'rank') return h('td', { class: 'rank' }, ['🥇', '🥈', '🥉'][Number(v) - 1] ?? `#${v}`);
  return h('td', {}, v ?? '—');
}
function legend(columns) {
  const hints = columns.filter((c) => c.hint);
  return hints.length ? h('dl', { class: 'legend' }, hints.flatMap((c) => [h('dt', {}, c.label), h('dd', {}, c.hint)])) : null;
}

function panelBox(m, panel) {
  const box = h('div', { class: 'card' }, h('h3', {}, panel.title), h('p', { class: 'muted' }, 'Loading…'));
  const base = `/api/guilds/${state.gid}/modules/${m.name}`;
  let seen = null; // id -> row as JSON, to light up what changed since the last paint
  const load = () => api(`${base}/views/${panel.view}`).then(paint).catch((e) => put(box, h('h3', {}, panel.title), h('p', { class: 'muted' }, e.message)));
  // Live: when this module reports a change, read the panel again and paint it in place.
  if (!state.panels.has(m.name)) state.panels.set(m.name, new Set());
  const refresher = () => { if (!box.isConnected) { state.panels.get(m.name)?.delete(refresher); return; } load(); };
  state.panels.get(m.name).add(refresher);
  load();
  return box;

  function paint(data) {
    const before = seen;
    seen = new Map((data.rows ?? []).map((r) => [String(r.id ?? JSON.stringify(r)), JSON.stringify(r)]));
    const run = async (action, body, ok) => { try { await api(`${base}/actions/${action}`, body); toast(ok); load(); } catch (e) { toast(e.message, true); } };
    const rowAction = (a, r) => async () => {
      // Send the row's id under both names: modules read `id` or `userId`, whichever suits what the row is.
      const body = { id: r.id, userId: r.id };
      const who = r.name ?? r.id;
      if (a.prompt) {
        const field = a.prompt === 'select' ? { type: 'select', options: a.options ?? [], value: r[a.current] ?? a.options?.[0]?.value } : { type: a.prompt, placeholder: a.placeholder ?? '', value: a.current ? r[a.current] : '' };
        const v = await ask({ title: `${a.label} · ${who}`, text: a.hint ?? null, field, okLabel: a.okLabel ?? 'Save', danger: !!a.danger });
        if (v === null) return;
        body[a.field] = v;
      } else if (!(await ask({ title: `${a.label} · ${who}`, text: a.confirm ?? 'Are you sure?', okLabel: a.label, danger: a.danger !== false }))) return;
      run(a.action, body, a.done ?? 'Done');
    };
    const actions = panel.rowActions ?? [];
    const changeClass = (r) => { if (!before) return ''; const k = String(r.id ?? JSON.stringify(r)); return !before.has(k) ? 'enter' : before.get(k) !== JSON.stringify(r) ? 'flash' : ''; };
    const rows = (data.rows ?? []).map((r) => h('tr', { class: changeClass(r) }, panel.columns.map((c) => cell(c, r)),
      actions.length ? h('td', { class: 'actions' }, actions.map((a) => h('button', { class: a.danger ? 'ghost danger-text' : 'ghost', onclick: rowAction(a, r) }, a.label))) : null));
    const recent = panel.recentColumns?.length ? h('div', { class: 'recent' }, h('h4', {}, panel.recentTitle ?? 'Recent activity'),
      (data.recent ?? []).length ? h('table', {}, h('tr', {}, panel.recentColumns.map((c) => h('th', { title: c.hint ?? null }, c.label))),
        data.recent.map((r) => h('tr', {}, panel.recentColumns.map((c) => h('td', {}, r[c.key] ?? '—')))))
        : h('p', { class: 'empty-note' }, panel.recentEmpty ?? 'Nothing has happened here yet.')) : null;
    put(box, h('div', { class: 'row' }, h('h3', {}, panel.title),
      h('div', {}, (panel.globalActions ?? []).map((a) => h('button', { class: 'danger', onclick: async () => {
        const w = await ask({ title: a.label, text: a.confirm ?? 'This changes everyone at once and cannot be undone from here. A backup is made first.', confirmWord: a.confirmWord, okLabel: a.label, danger: true });
        if (w === null) return;
        run(a.action, { confirm: a.confirmWord }, 'Done');
      } }, a.label)))),
      panel.description ? h('p', { class: 'muted' }, panel.description) : null,
      (data.charts ?? []).map(barChart),
      !panel.columns?.length ? null : rows.length ? h('table', {}, h('tr', {}, panel.columns.map((c) => h('th', { title: c.hint ?? null }, c.label, c.hint ? h('span', { class: 'q', 'aria-hidden': 'true' }, ' ⓘ') : null)), actions.length ? h('th', {}, '') : null), rows)
        : h('p', { class: 'empty-note' }, panel.empty ?? 'Nothing here yet.'),
      rows.length && panel.columns?.length ? legend(panel.columns) : null,
      recent);
  }
}

/** A simple bar chart: { title, bars: [{ label, value }] }. Heights are set through the style object, never HTML. */
function barChart(c) {
  const max = Math.max(1, ...c.bars.map((b) => b.value));
  return h('div', { class: 'chart' }, h('h4', {}, c.title),
    h('div', { class: 'bars', role: 'img', 'aria-label': c.title }, c.bars.map((b) => {
      const bar = h('div', { class: 'bar', title: `${b.label}: ${b.value.toLocaleString()}` });
      bar.style.height = `${Math.max(2, Math.round((b.value / max) * 100))}%`;
      return h('div', { class: 'barcol' }, bar, h('span', {}, b.short ?? b.label));
    })));
}

// ---------------------------------------------------------------- testers and feedback (2.3)
/** For admins: how to let other people test the dashboard. */
function testersCard() {
  const d = state.data;
  const access = (d.corePermissions ?? []).find((p) => p.key === 'dashboard.access');
  const roles = d.roles.filter((r) => !isDivider(r.name));
  const holders = (access?.roles ?? []).map((id) => d.roles.find((r) => r.id === id)).filter(Boolean);
  const link = state.me?.dashboardUrl ?? location.origin;
  const isLocal = /\/\/(localhost|127\.0\.0\.1)/.test(link);
  const pick = h('select', { class: 'add-role', 'aria-label': 'Role for testers' }, h('option', { value: '' }, 'Choose the testers\' role…'), roles.map((r) => h('option', { value: r.id }, '@' + r.name)));
  const grant = async (everything) => {
    if (!pick.value) return toast('Choose a role first.', true);
    try {
      const r = await api(`/api/guilds/${state.gid}/testers`, { roleId: pick.value, everything });
      toast(r.message ?? 'Done'); await loadGuild();
    } catch (e) { toast(e.message, true); }
  };
  return h('div', { class: 'card' }, h('h3', {}, '🧪 Testers'),
    h('p', { class: 'muted' }, 'Testers sign in with their own Discord account. Give their role access here, then share the link.'),
    h('div', { class: 'row' }, h('code', { class: 'link' }, link), h('button', { class: 'ghost', onclick: () => navigator.clipboard?.writeText(link).then(() => toast('Link copied')) }, 'Copy link')),
    isLocal ? h('p', { class: 'hint warn' }, 'This link only works on this computer. In the Good Boy app, turn on Settings > Dashboard link to get one testers can open.') : null,
    h('p', { class: 'hint' }, holders.length ? `Can open the dashboard now: ${holders.map((r) => '@' + r.name).join(', ')}` : 'No tester roles yet.'),
    h('div', { class: 'row' }, pick,
      h('button', { onclick: () => grant(false) }, 'Let them open the dashboard'),
      h('button', { class: 'ghost', title: 'Also every box that only shows information. Boxes with buttons (kick, reset, AutoMod) or private information (tickets, watch log) are given out on the Permissions page.', onclick: () => grant(true) }, '…and see every read-only box')),
    h('p', { class: 'hint' }, 'Everyone has a 💬 Feedback button at the bottom of the page. What they send shows up live under Tester feedback.'));
}

function feedbackButton() {
  if (!state.gid) return null;
  return h('button', { class: 'fab', onclick: async () => {
    const kind = await ask({ title: 'Send feedback', text: 'Thanks for testing! What is it about?', field: { type: 'select', value: 'bug', options: [{ value: 'bug', label: '🐞 Something is broken' }, { value: 'confusing', label: '🤔 Something is confusing' }, { value: 'idea', label: '💡 I have an idea' }, { value: 'praise', label: '💚 I like this' }] }, okLabel: 'Next' });
    if (kind === null) return;
    const text = await ask({ title: 'Send feedback', text: 'Tell us what happened or what you would like. The page you are on is sent with it.', field: { type: 'paragraph', placeholder: 'For example: the Levels box did not update after I gave XP', max: 1000 }, okLabel: 'Send' });
    if (text === null) return;
    try { await api(`/api/guilds/${state.gid}/feedback`, { kind, text, page: state.page }); toast('Thanks! Your feedback was sent.'); }
    catch (e) { toast(e.message, true); }
  }, 'aria-label': 'Send feedback' }, h('span', { class: 'fab-i', 'aria-hidden': 'true' }, '💬'), h('span', { class: 'fab-t' }, ' Feedback'));
}

async function renderFeedback(ws) {
  const box = h('div', { class: 'card' }, h('h3', {}, 'Tester feedback'), h('p', { class: 'muted' }, 'Loading…'));
  ws.append(box);
  try {
    const { rows } = await api(`/api/guilds/${state.gid}/feedback`);
    const label = { bug: '🐞 Broken', confusing: '🤔 Confusing', idea: '💡 Idea', praise: '💚 Likes' };
    put(box, h('div', { class: 'row' }, h('h3', {}, 'Tester feedback'), h('span', { class: 'hint' }, 'new reports appear here live')),
      rows.length ? h('ul', { class: 'feed feedback' }, rows.map((r) => h('li', {}, h('span', { class: 'feed-icon' }, (label[r.kind] ?? '💬').split(' ')[0]),
        h('span', { class: 'feed-text' }, h('strong', {}, r.username), ` · ${label[r.kind] ?? r.kind}${r.page ? ` · on ${r.page}` : ''}`, h('br'), r.text), h('time', {}, ago(r.at)))))
        : h('p', { class: 'empty-note' }, 'No feedback yet. Testers send it with the 💬 Feedback button.'));
  } catch (e) { put(box, h('h3', {}, 'Tester feedback'), h('p', { class: 'muted' }, e.message)); }
}

// ---------------------------------------------------------------- modules and their settings (admins)
// ---------------------------------------------------------------- Modules (3.0): a grid of tiles, each opens its own page
const MOD_CAT = { moderation: 0, support: 0, 'support-html-transcripts': 0, community: 1, stats: 1, achievements: 1, 'member-management': 1, eclipseid: 1,
  economy: 2, games: 2, clips: 2, quotes: 2, deadchat: 2, partyfinder: 2, engagement: 3, tags: 3, messages: 3, botnews: 3, roles: 3, voice: 4, tempvoice: 4, reminders: 5, integrations: 5 };
const MOD_CATS = ['Safety & moderation', 'Community & levels', 'Fun & games', 'Messages & roles', 'Voice', 'Tools'];
const MOD_ICON = { moderation: '🛡️', support: '🎫', 'support-html-transcripts': '📄', community: '⭐', stats: '📊', achievements: '🏅', 'member-management': '👋', eclipseid: '🪪', economy: '🪙', games: '🎰',
  clips: '🎬', quotes: '❝', deadchat: '💤', partyfinder: '🎮', engagement: '📣', tags: '📝', messages: '📌', botnews: '📰', roles: '🏷️', voice: '🔊', tempvoice: '🎧', reminders: '⏰', integrations: '📡' };
const MOD_NAME = { moderation: 'Moderation', support: 'Tickets', 'support-html-transcripts': 'Ticket transcripts', community: 'Levels', stats: 'Stats', achievements: 'Achievements', 'member-management': 'Welcome & members',
  eclipseid: 'Member IDs', economy: 'Economy', games: 'Games', clips: 'Clips', quotes: 'Quotes', deadchat: 'Dead chat ping', partyfinder: 'Party finder', engagement: 'Announcements & polls', tags: 'Custom commands',
  messages: 'Messages', botnews: 'Bot news', roles: 'Roles', voice: 'Text to speech', tempvoice: 'Voice rooms', reminders: 'Reminders', integrations: 'Feeds' };
const modName = (m) => MOD_NAME[m.name] ?? TITLE[m.name] ?? cap(m.name);
/** The settings a module can't work without. A module that is on with any of these empty needs setting up. */
const ESSENTIAL = { clips: ['clipsChannel'], botnews: ['adminChannel'], moderation: ['logChannel'], support: ['logChannel'], deadchat: ['channel'] };
const essentials = (m) => (ESSENTIAL[m.name] ?? []).map((k) => m.settings.find((x) => x.key === k)).filter(Boolean);
const needsSetup = (m) => m.enabled && essentials(m).some((x) => !m.values[x.key]);
const modState = { q: '', filter: 'all' };

function modStatus(m) {
  if (needsSetup(m)) return h('span', { class: 'mstatus warn' }, h('i'), 'Needs setup');
  if (m.enabled && (m.status === 'warning' || m.status === 'failing')) return h('span', { class: 'mstatus warn' }, h('i'), m.status === 'failing' ? 'Having problems' : 'Some errors');
  return h('span', { class: 'mstatus' + (m.enabled ? ' is-on' : '') }, h('i'), m.enabled ? 'On' : 'Off');
}
async function setModuleOn(m, on, { undo = true } = {}) {
  try {
    await api(`/api/guilds/${state.gid}/modules/${m.name}/${on ? 'enable' : 'disable'}`, {});
    toast(`${modName(m)} turned ${on ? 'on' : 'off'}`, false, undo ? () => setModuleOn(m, !on, { undo: false }) : null);
    await loadGuild();
    const fresh = state.data.modules.find((x) => x.name === m.name);
    if (on && fresh && needsSetup(fresh)) setupSheet(fresh);
  } catch (e) { toast(e.message, true); render(); }
}

function renderModules(ws) {
  const mods = state.data.modules;
  const search = h('input', { type: 'search', placeholder: 'Search modules', 'aria-label': 'Search modules', value: modState.q });
  const seg = h('div', { class: 'gb-seg', 'data-key': 'modfilter', role: 'group', 'aria-label': 'Show' },
    [['all', 'All'], ['on', 'On'], ['off', 'Off'], ['setup', 'Needs setup']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(modState.filter === k), onclick: (e) => {
      modState.filter = k; for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === e.currentTarget)); draw(true);
    } }, l)));
  search.addEventListener('input', () => { modState.q = search.value.toLowerCase(); draw(true); });
  const list = h('div', { class: 'modlist' });
  ws.append(h('div', { class: 'card glass modhead' }, h('div', {}, h('h2', {}, 'Modules'), h('p', { class: 'muted' }, 'Turn features on or off. Click one to set it up.')),
    h('div', { class: 'modtools' }, h('label', { class: 'msearch' }, h('span', { 'aria-hidden': 'true' }, '🔍'), search), seg)), list);
  function draw(soft) {
    const shown = mods.filter((m) => (!modState.q || `${modName(m)} ${m.name} ${m.description}`.toLowerCase().includes(modState.q))
      && (modState.filter === 'all' || (modState.filter === 'on' && m.enabled) || (modState.filter === 'off' && !m.enabled) || (modState.filter === 'setup' && needsSetup(m))));
    const groups = MOD_CATS.map((c, ci) => [c, shown.filter((m) => (MOD_CAT[m.name] ?? 5) === ci)]).filter(([, ms]) => ms.length);
    put(list, groups.length ? groups.map(([c, ms]) => [h('h3', { class: 'section-title' }, c), h('div', { class: 'tiles' + (soft ? '' : ' gb-stagger') }, ms.map((m) => {
      const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `${modName(m)} on`, checked: m.enabled, onclick: (e) => e.stopPropagation(), onchange: (e) => setModuleOn(m, e.target.checked) });
      return h('div', { class: 'gb-tile glass', role: 'button', tabindex: '0', onclick: () => go(`module:${m.name}`), onkeydown: (e) => { if (e.key === 'Enter') go(`module:${m.name}`); } },
        h('div', { class: 'ttop' }, h('span', { class: 'ticon', 'data-cat': String(MOD_CAT[m.name] ?? 5), 'aria-hidden': 'true' }, MOD_ICON[m.name] ?? '◆'), h('strong', {}, modName(m))),
        h('p', { class: 'tdesc' }, m.description || ''),
        h('div', { class: 'tfoot' }, modStatus(m), sw));
    }))]).flat() : h('div', { class: 'card empty' }, h('p', { class: 'muted' }, 'No modules match. Try another word.')));
  }
  draw(false);
}

/* ---------- one module's own page ---------- */
// AutoMod settings live on the AutoMod page, so the Moderation page doesn't repeat them.
const AUTOMOD_KEY = /^(automod|spam|repeat|caps|emoji|raid|nuke|antiNuke|minAccount|newAccount|maxMentions|bannedWords|allowedDomains|wordsAction|linksAction|mentionsAction)/;
const hiddenHere = (m, s) => m.name === 'moderation' && AUTOMOD_KEY.test(s.key);
const OPTION_WORDS = { default: 'Server default', delete: 'Delete it', 'delete-warn': 'Delete + warn', 'delete-timeout': 'Delete + time out', alert: 'Alert staff', timeout: 'Time out', kick: 'Kick', ban: 'Ban', 'strip-roles': 'Remove their roles', jackpots: 'Slots jackpots only', mythical: 'Jackpots and Mythical fish', rare: 'All rare wins' };
const optionWord = (o) => OPTION_WORDS[o] ?? cap(String(o).replace(/[-_]/g, ' '));
const TAB_OF = (s) => (s.type === 'channel' || s.type === 'role' ? 'setup' : s.type === 'toggle' || s.type === 'select' ? 'settings' : 'advanced');
function renderModulePage(ws, name) {
  const m = state.data.modules.find((x) => x.name === name);
  if (!m) { ws.append(h('div', { class: 'card empty' }, h('p', { class: 'muted' }, 'That module is not available.'))); return; }
  const tabs = [['setup', 'Setup'], ['settings', 'Settings'], ['advanced', 'Advanced'], ['where', 'Where it works'], ['who', 'Who can use it'], ['commands', 'Commands'], ['history', 'History']]
    .filter(([k]) => k === 'commands' ? m.commandInfo?.length : k === 'where' || k === 'history' ? true : k === 'who' ? m.permissions?.length : m.settings.some((s) => TAB_OF(s) === k && !hiddenHere(m, s)));
  if (!tabs.length) tabs.push(['commands', 'About']);
  state.modTab = tabs.some(([k]) => k === state.modTab) ? state.modTab : tabs[0][0];
  const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `${modName(m)} on`, checked: m.enabled, onchange: (e) => setModuleOn(m, e.target.checked) });
  const body = h('div', { class: 'gb-enter' });
  const bar = h('div', { class: 'gb-seg modtabs', 'data-key': 'modtabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(state.modTab === k), onclick: (e) => {
    state.modTab = k; for (const b of bar.querySelectorAll('button')) b.setAttribute('aria-selected', String(b === e.currentTarget)); drawTab();
  } }, l)));
  ws.append(...[h('button', { type: 'button', class: 'back ghost', onclick: () => go('modules') }, '‹ All modules'),
    h('div', { class: 'card glass mhead' }, h('span', { class: 'ticon big', 'data-cat': String(MOD_CAT[m.name] ?? 5), 'aria-hidden': 'true' }, MOD_ICON[m.name] ?? '◆'),
      h('div', { class: 'grow' }, h('h2', {}, modName(m)), h('p', { class: 'muted' }, m.description || '')), modStatus(m), sw),
    (m.panels ?? []).length && m.enabled ? h('div', { class: 'card toolslink' }, h('span', {}, `${modName(m)} has tools: ${m.panels.map((p) => p.title).join(' · ')}`),
      h('button', { type: 'button', class: 'ghost', onclick: () => go(m.panels.some((p) => p.page === 'automod') ? 'automod' : `tool:${m.name}`) }, 'Open tools')) : null,
    m.enabled ? null : h('div', { class: 'card note' }, `${modName(m)} is off. You can change its settings now; they apply when you turn it on.`),
    bar, body].filter(Boolean));
  function drawTab() {
    if (state.modTab === 'where') { put(body, whereTab(m)); return; }
    if (state.modTab === 'who') { put(body, whoTab(m)); return; }
    if (state.modTab === 'history') { put(body, historyTab(m)); return; }
    if (state.modTab === 'commands') {
      put(body, h('div', { class: 'card' }, (m.commandInfo ?? []).length ? m.commandInfo.map((c) => h('div', { class: 'cmdrow' }, h('code', {}, `/${c.name}`), h('div', {}, h('div', {}, c.description),
        c.subs.length ? h('div', { class: 'hint' }, c.subs.map((x) => x.name).join(' · ')) : null))) : h('p', { class: 'muted' }, 'This module has no commands of its own.')));
      return;
    }
    const fields = m.settings.filter((s) => TAB_OF(s) === state.modTab && !hiddenHere(m, s));
    const intro = { setup: 'The channels and roles this module uses.', settings: 'Switches and choices.', advanced: 'Numbers, lists and text you can fine-tune.' }[state.modTab];
    put(body, h('div', { class: 'card' }, h('p', { class: 'muted' }, intro), fields.map((s) => settingRow(m, s)),
      m.name === 'moderation' ? h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('strong', {}, 'AutoMod'), h('div', { class: 'hint' }, 'Spam, bad words, links, raids and the rest have their own page.')), h('button', { type: 'button', class: 'ghost', onclick: () => go('automod') }, 'Open AutoMod')) : null));
    body.classList.remove('gb-enter'); void body.offsetWidth; body.classList.add('gb-enter');
  }
  drawTab();
}

/** One setting that saves itself, with Undo. */
function settingRow(m, s) {
  const cur = m.values[s.key];
  const save = async (value, label) => {
    const before = m.values[s.key];
    try {
      await api(`/api/guilds/${state.gid}/modules/${m.name}/settings`, { key: s.key, value, op: 'set' });
      m.values[s.key] = value;
      toast(`Saved · ${label ?? s.label}`, false, async () => { try { await api(`/api/guilds/${state.gid}/modules/${m.name}/settings`, { key: s.key, value: before ?? null, op: before == null ? 'reset' : 'set' }); m.values[s.key] = before; toast('Changed back'); softReload(); } catch (e) { toast(e.message, true); } });
    } catch (e) { toast(e.message, true); softReload(); }
  };
  const label = h('div', { class: 'srow-l' }, h('strong', {}, s.label), s.description ? h('div', { class: 'hint' }, s.description) : null);
  let control;
  if (s.type === 'toggle') control = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': s.label, checked: cur === true, onchange: (e) => save(e.target.checked) });
  else if (s.type === 'select') control = h('select', { 'aria-label': s.label, onchange: (e) => save(e.target.value, `${s.label}: ${optionWord(e.target.value)}`) }, s.options.map((o) => h('option', { value: o, selected: o === cur }, optionWord(o))));
  else if (s.type === 'channel') control = channelPicker({ value: cur ?? null, types: s.channelTypes ?? (/voice/i.test(s.key + s.label) ? [2, 13] : /categor/i.test(s.key + s.label) ? [4] : [0, 5, 15]), label: s.label, onPick: (id) => save(id) });
  else if (s.type === 'role') control = rolePicker({ value: cur ?? null, label: s.label, onPick: (id) => save(id) });
  else if (s.type === 'number') {
    let v = Number(cur ?? s.default ?? 0); let t;
    const out = h('output', {}, String(v));
    const step = (d) => { v = Math.max(s.min ?? -Infinity, Math.min(s.max ?? Infinity, v + d)); out.textContent = String(v); clearTimeout(t); t = setTimeout(() => save(v, `${s.label}: ${v}`), 600); };
    control = h('div', { class: 'stepper' }, h('button', { type: 'button', class: 'ghost', 'aria-label': 'Less', onclick: () => step(-1) }, '−'), out, h('button', { type: 'button', class: 'ghost', 'aria-label': 'More', onclick: () => step(1) }, '+'));
  } else if (s.type === 'list') {
    const items = [...(cur ?? [])];
    const wrap = h('div', { class: 'chipbox' });
    const input = h('input', { placeholder: 'Add and press Enter', 'aria-label': `Add to ${s.label}` });
    const paint = () => put(wrap, items.map((x, i) => h('span', { class: 'chipx' }, x, h('button', { type: 'button', class: 'plain', 'aria-label': `Remove ${x}`, onclick: () => { items.splice(i, 1); paint(); save([...items]); } }, '✕'))), input);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); items.push(input.value.trim()); input.value = ''; paint(); save([...items]); input.focus(); } });
    paint(); control = wrap;
    return h('div', { class: 'srow stack' }, label, control);
  } else {
    const ta = h('textarea', { 'aria-label': s.label, maxlength: s.maxLength ?? 2000, rows: 2 }, cur ?? '');
    ta.addEventListener('change', () => save(ta.value));
    return h('div', { class: 'srow stack' }, label, ta);
  }
  return h('div', { class: 'srow' }, label, control);
}

/* ---------- first-time setup: a short sheet for the channels and roles a module needs ---------- */
function setupSheet(m) {
  const needs = essentials(m).filter((s) => !m.values[s.key]);
  if (!needs.length) return;
  let i = 0;
  const scrim = h('div', { class: 'scrim' });
  const close = () => { scrim.classList.add('out'); setTimeout(() => scrim.remove(), 220); softReload(); };
  const draw = () => {
    const s = needs[i];
    const card = h('div', { class: 'card glass sheet-gb', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Set up ${modName(m)}` },
      h('div', { class: 'steps' }, needs.map((_, j) => h('i', { class: j <= i ? 'done' : '' }))),
      h('div', { class: 'muted' }, `Set up ${modName(m)} · ${i + 1} of ${needs.length}`), h('h2', {}, s.label), s.description ? h('p', { class: 'muted' }, s.description) : null,
      settingRow(m, s),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost', onclick: () => { if (i) { i--; draw(); } else close(); } }, i ? 'Back' : 'Later'),
        h('button', { type: 'button', onclick: () => { if (i < needs.length - 1) { i++; draw(); } else { close(); toast(`${modName(m)} is ready`); } } }, i < needs.length - 1 ? 'Next' : 'Done')));
    put(scrim, card);
  };
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim); draw();
}

function settingsForm(m) {
  const form = h('div', {});
  const getters = {};
  for (const s of m.settings) {
    const cur = m.values[s.key];
    let input, get;
    if (s.type === 'toggle') { input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: cur === true }); get = () => input.checked; }
    else if (s.type === 'number') { input = h('input', { type: 'number', value: cur ?? '', min: s.min, max: s.max }); get = () => input.value; }
    else if (s.type === 'select') {
      input = h('select', {}, s.options.map((o) => h('option', { value: o, selected: o === cur }, o))); get = () => input.value;
    } else if (s.type === 'channel') {
      input = h('select', {}, h('option', { value: '' }, '— none —'), state.data.channels.map((c) =>
        h('option', { value: c.id, selected: c.id === cur }, ({ 0: '#', 2: '🔊 ', 4: '📁 ', 5: '📢 ' })[c.type] + c.name))); get = () => input.value || null;
    } else if (s.type === 'role') {
      input = h('select', {}, h('option', { value: '' }, '— none —'), state.data.roles.map((r) => h('option', { value: r.id, selected: r.id === cur }, '@' + r.name))); get = () => input.value || null;
    } else if (s.type === 'list') { input = h('textarea', {}, (cur ?? []).join(', ')); get = () => input.value.split(',').map((x) => x.trim()).filter(Boolean); }
    else { input = h('textarea', { maxlength: s.maxLength ?? 2000 }, cur ?? ''); get = () => input.value; }
    getters[s.key] = { get, original: JSON.stringify(cur ?? (s.type === 'list' ? [] : null)), type: s.type };
    if (s.type === 'toggle') form.append(h('label', { class: 'switch-row' }, h('span', {}, s.label), input));
    else form.append(h('label', {}, s.label, s.description ? h('span', { class: 'hint' }, ' — ' + s.description) : null), input);
  }
  form.append(h('p', {}, h('button', {
    class: 'on', onclick: async () => {
      try {
        let n = 0;
        for (const [key, g] of Object.entries(getters)) {
          const v = g.get();
          if (JSON.stringify(v ?? (g.type === 'list' ? [] : null)) === g.original) continue;
          await api(`/api/guilds/${state.gid}/modules/${m.name}/settings`, { key, value: v, op: 'set' }); n++;
        }
        toast(n ? `Saved ${n} setting(s)` : 'Nothing changed'); await loadGuild();
      } catch (e) { toast(e.message, true); }
    },
  }, 'Save settings')));
  return form;
}

// Divider roles ("--- bots under -", "━━ Staff ━━") are only labels in the member list, never real permissions.
const isDivider = (name) => /^[\s\-–—_=~*•·.|+#━─═▬■□▪▫<>[\](){}]{3,}/.test(name) || /^[^\p{L}\p{N}]+$/u.test(name);
const LEVEL_WORDS = { everyone: 'Everyone', moderator: 'Moderators', admin: 'Admins (Manage Server)', owner: 'Only the server owner' };

function renderPermissions(ws) {
  const roles = state.data.roles.filter((r) => !isDivider(r.name));
  const hidden = state.data.roles.length - roles.length;
  const groups = [{ name: 'core', title: 'Dashboard and bot', perms: state.data.corePermissions ?? [] },
    ...state.data.modules.filter((m) => m.enabled && m.permissions.length).map((m) => ({ name: m.name, title: TITLE[m.name] ?? cap(m.name), perms: m.permissions }))];
  ws.append(h('div', { class: 'card' }, h('h3', {}, 'Who can do what'),
    h('p', { class: 'muted' }, 'Each line starts with its default. Add roles to a line to choose exactly who can do it instead. The server owner and Administrators can always do everything.'),
    hidden ? h('p', { class: 'hint' }, `${hidden} divider role${hidden === 1 ? ' is' : 's are'} hidden. Bot roles are never shown.`) : null));
  for (const g of groups) {
    const list = h('div', { class: 'group' });
    for (const p of g.perms) {
      let chosen = [...p.roles];
      const chips = h('div', { class: 'chips' });
      const save = async () => { try { await api(`/api/guilds/${state.gid}/permissions`, { key: p.key, roles: chosen }); toast('Saved'); p.roles = [...chosen]; } catch (e) { toast(e.message, true); } };
      const picker = h('select', { class: 'add-role', 'aria-label': `Add a role to: ${p.label}` });
      const paint = () => {
        put(chips, chosen.length ? chosen.map((id) => {
          const r = state.data.roles.find((x) => x.id === id);
          return h('span', { class: 'chip' }, '@' + (r?.name ?? 'deleted role'), h('button', { class: 'chip-x', title: 'Remove', 'aria-label': `Remove @${r?.name ?? id}`, onclick: () => { chosen = chosen.filter((x) => x !== id); paint(); save(); } }, '×'));
        }) : h('span', { class: 'chip default' }, LEVEL_WORDS[p.default] ?? p.default));
        put(picker, h('option', { value: '' }, chosen.length ? '+ Add another role' : '+ Choose roles instead'), roles.filter((r) => !chosen.includes(r.id)).map((r) => h('option', { value: r.id }, '@' + r.name)));
      };
      picker.addEventListener('change', () => { if (!picker.value) return; chosen.push(picker.value); paint(); save(); });
      paint();
      list.append(h('div', { class: 'perm' }, h('div', { class: 'perm-text' }, h('strong', {}, p.label), h('small', { class: 'hint', title: p.key }, chosen.length ? `Default would be: ${LEVEL_WORDS[p.default] ?? p.default}` : 'Using the default')),
        h('div', { class: 'perm-roles' }, chips, picker)));
    }
    ws.append(h('div', { class: 'card' }, h('h3', {}, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, ICON[g.name] ?? '⚙'), ' ', g.title), list));
  }
}

async function renderLogs(ws) {
  const loading = h('p', { class: 'muted' }, 'Loading…');
  ws.append(loading);
  try {
    const { logs, health } = await api(`/api/guilds/${state.gid}/logs`);
    loading.remove();
    ws.append(h('div', { class: 'card' }, h('h3', {}, 'Module health'), h('table', {},
      h('tr', {}, h('th', {}, 'Module'), h('th', {}, 'Status'), h('th', {}, 'Errors (10 min)'), h('th', {}, 'Last error')),
      health.map((x) => h('tr', {}, h('td', {}, x.name), h('td', { class: x.status }, x.status), h('td', {}, x.errorsLast10Min), h('td', {}, x.lastError?.message ?? '—'))))));
    ws.append(h('div', { class: 'card' }, h('h3', {}, 'Recent log'), logs.length ? h('table', {},
      h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Module'), h('th', {}, 'Level'), h('th', {}, 'Message')),
      logs.map((l) => h('tr', {}, h('td', {}, new Date(l.ts).toLocaleString()), h('td', {}, l.module ?? ''), h('td', {}, l.level), h('td', {}, l.message)))) : h('p', { class: 'muted' }, 'Nothing logged yet.')));
  } catch (e) { loading.remove(); toast(e.message, true); }
}

boot();
