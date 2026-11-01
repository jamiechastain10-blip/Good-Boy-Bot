// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Every page is built from DOM nodes and text only (no HTML strings), so names can't inject script.
const app = document.getElementById('app');

// Browser-only preferences. Storage can be blocked, so every read and write is guarded.
const pref = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked: the choice just won't be remembered */ } },
};
const state = { me: null, gid: null, data: null, page: 'overview', theme: pref.get('gb-theme', 'dark'), motion: pref.get('gb-motion', 'on') !== 'off' };

function applyAppearance() {
  document.body.classList.toggle('theme-light', state.theme === 'light');
  document.body.classList.toggle('theme-blue', state.theme === 'blue');
  document.body.classList.toggle('motion-off', !state.motion);
}
applyAppearance();

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
  state.gid = null; clear();
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
  render();
}

// ---------------------------------------------------------------- pages and navigation
const ICON = { moderation: '🛡', support: '🎫', community: '🏆', engagement: '💬', voice: '🔊', quotes: '❝', reminders: '⏰', roles: '🏷', integrations: '🔌', 'member-management': '👥', stats: '📊', achievements: '🏆', eclipseid: '🪪', partyfinder: '🎮', tempvoice: '🎙' };
const TITLE = { moderation: 'Moderation', support: 'Support', community: 'Community', engagement: 'Engagement', voice: 'Voice', quotes: 'Quotes', reminders: 'Reminders', roles: 'Roles', integrations: 'Integrations', 'member-management': 'Members', stats: 'Statistics', achievements: 'Achievements', eclipseid: 'Member ID', partyfinder: 'Party Finder', tempvoice: 'Temporary voice' };

/** Every page this person can open. Panel-only people get just the tools they hold permission for. */
function pages() {
  const d = state.data, admin = d.access === 'admin';
  const list = [{ id: 'overview', icon: '⌂', label: 'Overview', group: 'SERVER' }];
  if (admin) list.push({ id: 'modules', icon: '▦', label: 'Modules', group: 'SERVER' });
  for (const m of d.modules) if ((admin ? m.enabled : true) && (m.panels ?? []).length) list.push({ id: `tool:${m.name}`, icon: ICON[m.name] ?? '◆', label: TITLE[m.name] ?? cap(m.name), group: 'TOOLS' });
  if (admin) list.push({ id: 'permissions', icon: '♙', label: 'Permissions', group: 'ADMIN' }, { id: 'logs', icon: '≡', label: 'Logs', group: 'ADMIN' });
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
    d.access === 'panel' ? h('span', { class: 'badge' }, 'limited access') : h('span', { class: 'badge healthy' }, '● Connected')));
  app.append(h('div', { class: 'shell' }, side, workspace));

  if (current.id === 'overview') renderOverview(workspace);
  else if (current.id === 'modules') renderModules(workspace);
  else if (current.id === 'permissions') renderPermissions(workspace);
  else if (current.id === 'logs') renderLogs(workspace);
  else if (current.id === 'updates') renderUpdates(workspace);
  else if (current.id === 'appearance') renderAppearance(workspace);
  else if (current.id.startsWith('tool:')) renderTool(workspace, current.id.slice(5));
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
    const stats = [['Members', d.stats.members ?? '—'], ['Channels', d.stats.channels], ['Active modules', `${on.length} / ${d.modules.length}`], ['Bot uptime', duration(d.stats.uptimeSeconds)]];
    ws.append(h('div', { class: 'stats' }, stats.map(([label, value]) => h('div', { class: 'card stat' }, h('div', { class: 'muted' }, label), h('strong', {}, value)))));
  }
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
    try { r = await api(path, body); } catch (e) { box.replaceChildren(h('h3', {}, 'Updates'), h('p', { class: e.status === 403 ? 'muted' : 'err' }, e.message)); return null; }
    paint(r); return r;
  }
  function paint(r) {
    if (!r.supervised) { box.replaceChildren(h('h3', {}, 'Updates'), h('p', { class: 'muted' }, r.message)); return; }
    if (!r.ok) { box.replaceChildren(h('h3', {}, 'Updates'), h('p', { class: 'err' }, r.error || 'The supervisor did not answer.')); return; }
    const st = r.status, u = st.update, found = u.lastCheck?.release;
    const rows = [['Running', `${st.version}${st.trial ? ' (on trial, not yet confirmed)' : ''}`], ['State', st.state], ['Channel', u.channel ?? 'updates not set up'], ['Last checked', when(u.lastCheck?.at)]];
    if (u.lastError) rows.push(['Problem', u.lastError]);
    if (u.lastResult) rows.push(['Last update', u.lastResult.ok ? `installed ${u.lastResult.version}` : `failed (${u.lastResult.reason || 'unknown'}); went back to the previous version`]);
    if (u.failed?.length) rows.push(['Rolled back before', u.failed.join(', ')]);
    box.replaceChildren(h('h3', {}, 'Updates'),
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
    box.replaceChildren(h('h3', {}, 'Updating...'), h('p', { class: 'muted' }, 'The bot is restarting. This page reconnects by itself.'));
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

/** Generic management panel: a table from a module's view, row actions, and confirmed global actions. */
function panelBox(m, panel) {
  const box = h('div', { class: 'card' }, h('h3', {}, panel.title), h('p', { class: 'muted' }, 'Loading…'));
  const base = `/api/guilds/${state.gid}/modules/${m.name}`;
  api(`${base}/views/${panel.view}`).then((data) => {
    const run = async (action, body, ok) => { try { await api(`${base}/actions/${action}`, body); toast(ok); box.replaceWith(panelBox(m, panel)); } catch (e) { toast(e.message, true); } };
    const rows = (data.rows ?? []).map((r) => h('tr', {}, panel.columns.map((c) => h('td', {}, r[c.key] ?? '')),
      (panel.rowActions ?? []).length ? h('td', {}, panel.rowActions.map((a) => h('button', { class: 'ghost', onclick: () => {
        // Send the row's id under both names: modules read `id` or `userId`, whichever suits what the row is.
        const body = { id: r.id, userId: r.id };
        const who = r.name ?? r.id;
        if (a.prompt) {
          const v = window.prompt(`${a.label}: ${who}${a.hint ? ` (${a.hint})` : ` - enter a ${a.prompt}`}`);
          if (v === null) return;
          body[a.field] = a.prompt === 'number' ? Number(v) : v;
        } else if (!window.confirm(`${a.label}: ${who}?`)) return;
        run(a.action, body, 'Done');
      } }, a.label))) : null));
    box.replaceChildren(h('div', { class: 'row' }, h('h3', {}, panel.title),
      h('div', {}, (panel.globalActions ?? []).map((a) => h('button', { class: 'danger', onclick: () => {
        const w = window.prompt(`Type ${a.confirmWord} to confirm: ${a.label}`);
        if (w !== a.confirmWord) { if (w !== null) toast('Confirmation did not match - nothing changed', true); return; }
        run(a.action, { confirm: w }, 'Done');
      } }, a.label)))),
      rows.length ? h('table', {}, h('tr', {}, panel.columns.map((c) => h('th', {}, c.label)), (panel.rowActions ?? []).length ? h('th', {}, '') : null), rows) : h('p', { class: 'muted' }, 'Nothing to show yet.'),
      (data.recent ?? []).length && panel.recentColumns ? h('div', {}, h('h3', { class: 'section-title' }, 'Recent activity'), h('table', {}, h('tr', {}, panel.recentColumns.map((c) => h('th', {}, c.label))),
        data.recent.map((r) => h('tr', {}, panel.recentColumns.map((c) => h('td', {}, r[c.key] ?? '')))))) : null);
  }).catch((e) => box.replaceChildren(h('h3', {}, panel.title), h('p', { class: 'muted' }, e.message)));
  return box;
}

// ---------------------------------------------------------------- modules and their settings (admins)
function renderModules(ws) {
  for (const m of state.data.modules) {
    const card = h('div', { class: 'card' });
    card.append(h('div', { class: 'row' },
      h('div', {}, h('h3', {}, m.name, h('span', { class: 'badge' }, 'v' + m.version),
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
    if (s.type === 'toggle') { input = h('input', { type: 'checkbox', checked: cur === true }); get = () => input.checked; }
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
    if (s.type === 'toggle') form.append(h('label', {}, input, ' ' + s.label));
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

function renderPermissions(ws) {
  const perms = [...(state.data.corePermissions ?? []).map((p) => ({ ...p, module: 'core' })), ...state.data.modules.filter((m) => m.enabled).flatMap((m) => m.permissions.map((p) => ({ ...p, module: m.name })))];
  ws.append(h('p', { class: 'muted' }, "Pick roles to REPLACE a permission's default. Leave all unticked to use the default. The server owner and Administrators can always do everything."));
  ws.append(h('p', { class: 'muted access-note' }, 'dashboard.access lets a role open this dashboard with limited access: only the tools whose own permission they also hold. Settings, permissions and logs always need Manage Server.'));
  for (const p of perms) {
    const boxes = state.data.roles.map((r) => {
      const cb = h('input', { type: 'checkbox', value: r.id, checked: p.roles.includes(r.id) });
      return h('label', {}, cb, ' @' + r.name);
    });
    ws.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', {}, h('h3', {}, p.key), h('div', { class: 'muted' }, p.label + ' · default: ' + p.default)),
        h('button', { onclick: () => act(() => api(`/api/guilds/${state.gid}/permissions`, { key: p.key, roles: boxes.map((b) => b.firstChild).filter((c) => c.checked).map((c) => c.value) }), 'Permissions saved') }, 'Save')),
      h('div', { class: 'checks' }, boxes)));
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
