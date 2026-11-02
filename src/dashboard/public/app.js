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

function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (bad ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 3500);
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
  state.gid ? await loadGuild() : showGuilds();
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
function startLive() {
  if (state.live?.gid === state.gid || typeof EventSource === 'undefined') return;
  stopLive();
  const es = new EventSource(`/api/guilds/${state.gid}/live`);
  state.live = { es, gid: state.gid };
  const on = (type, fn) => es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch { /* ignore a bad event */ } });
  on('hello', (d) => { state.activity = d.activity ?? []; paintFeed(); liveChip('on'); });
  on('pulse', (d) => { state.pulse = d; paintPulse(); liveChip('on'); });
  on('activity', (d) => { state.activity.unshift(d); state.activity.length = Math.min(state.activity.length, 30); paintFeed(true); });
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

/** Every page this person can open. Panel-only people get just the tools they hold permission for. */
function pages() {
  const d = state.data, admin = d.access === 'admin';
  const list = [{ id: 'overview', icon: '⌂', label: 'Overview', group: 'SERVER' }];
  if (admin) list.push({ id: 'modules', icon: '▦', label: 'Modules', group: 'SERVER' });
  for (const m of d.modules) if ((admin ? m.enabled : true) && (m.panels ?? []).length) list.push({ id: `tool:${m.name}`, icon: ICON[m.name] ?? '◆', label: TITLE[m.name] ?? cap(m.name), group: 'TOOLS' });
  if (admin) list.push({ id: 'permissions', icon: '♙', label: 'Permissions', group: 'ADMIN' }, { id: 'feedback', icon: '💬', label: 'Tester feedback', group: 'ADMIN' }, { id: 'logs', icon: '≡', label: 'Logs', group: 'ADMIN' });
  if (state.me?.botOwner) list.push({ id: 'updates', icon: '⬆', label: 'Updates', group: 'ADMIN' });
  list.push({ id: 'appearance', icon: '✦', label: 'Appearance', group: 'YOU' });
  return list;
}

function go(id) { state.page = id; render(); }

function render() {
  clear();
  const d = state.data, list = pages(), current = list.find((p) => p.id === state.page) ?? list[0];
  const side = h('aside', { class: 'side glass', 'aria-label': 'Dashboard navigation' });
  let group = null;
  for (const p of list) {
    if (p.group !== group) { group = p.group; side.append(h('div', { class: 'side-label' }, group)); }
    side.append(h('button', { class: 'nav-item' + (p.id === current.id ? ' active' : ''), title: p.label, 'aria-current': p.id === current.id ? 'page' : null, onclick: () => go(p.id) },
      h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, p.icon), h('span', { class: 'nav-name' }, p.label)));
  }
  side.append(h('button', { class: 'nav-item', onclick: showGuilds }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, '↩'), h('span', { class: 'nav-name' }, 'All servers')));

  const workspace = h('section', { class: 'workspace' });
  workspace.append(h('div', { class: 'card row' }, h('div', {}, h('strong', {}, current.label), h('div', { class: 'muted' }, d.guild.name)),
    h('div', { class: 'row-end' }, d.access === 'panel' ? h('span', { class: 'badge' }, 'limited access') : null, h('span', { id: 'live-chip', class: 'live-chip off' }, '○ Connecting…'))));
  workspace.append(h('div', { id: 'changed-banner', class: 'banner', hidden: true }, 'Something changed in this server while you were editing. ',
    h('button', { class: 'ghost', onclick: () => loadGuild() }, 'Show the latest')));
  app.append(h('div', { class: 'shell' }, side, workspace), feedbackButton());
  state.panels = new Map();

  if (current.id === 'overview') renderOverview(workspace);
  else if (current.id === 'modules') renderModules(workspace);
  else if (current.id === 'permissions') renderPermissions(workspace);
  else if (current.id === 'logs') renderLogs(workspace);
  else if (current.id === 'updates') renderUpdates(workspace);
  else if (current.id === 'appearance') renderAppearance(workspace);
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

// ---------------------------------------------------------------- tools (panels)
function renderTool(ws, name) {
  const m = state.data.modules.find((x) => x.name === name);
  if (!m) { ws.append(h('div', { class: 'card empty' }, h('p', { class: 'muted' }, 'That tool is not available.'))); return; }
  ws.append(h('div', { class: 'card' }, h('h3', {}, TITLE[name] ?? cap(name)), h('p', { class: 'muted' }, m.description || '')));
  for (const panel of m.panels ?? []) ws.append(panelBox(m, panel));
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
  } }, '💬 Feedback');
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
function renderModules(ws) {
  for (const m of state.data.modules) {
    const card = h('div', { class: 'card' });
    card.append(h('div', { class: 'row' },
      h('div', {}, h('h3', {}, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, ICON[m.name] ?? '◆'), ' ', TITLE[m.name] ?? cap(m.name), h('span', { class: 'badge' }, 'v' + m.version),
        m.type === 'addon' ? h('span', { class: 'badge' }, 'add-on for ' + m.requires.module) : null,
        m.enabled ? h('span', { class: 'badge ' + m.status }, m.status) : null),
        h('div', { class: 'muted' }, m.description)),
      m.enabled
        ? h('button', { class: 'ghost', onclick: () => act(() => api(`/api/guilds/${state.gid}/modules/${m.name}/disable`, {}), `${m.name} turned off`) }, 'Turn off')
        : h('button', { onclick: () => act(() => api(`/api/guilds/${state.gid}/modules/${m.name}/enable`, {}), `${m.name} turned on`) }, 'Turn on')));
    if (m.commands.length) card.append(h('div', { class: 'hint' }, 'Commands: ' + m.commands.map((c) => '/' + c).join('  ')));
    if (m.enabled && m.settings.length) card.append(settingsForm(m));
    ws.append(card);
  }
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
