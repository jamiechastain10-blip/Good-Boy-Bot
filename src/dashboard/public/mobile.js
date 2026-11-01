// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The phone app: a remote control that uses the same Discord login and the same checks as the dashboard.
// Built from DOM nodes and text only (no HTML strings), so names from Discord cannot inject anything.
'use strict';
const view = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const S = { me: null, gid: null, guild: null, tab: 'home', cache: {} };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const SVG = 'http://www.w3.org/2000/svg';
const ICON = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  levels: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  announce: 'M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 8a5 5 0 0 1 0 8',
  events: 'M7 4h10v4a5 5 0 0 1-10 0zM5 5H3a3 3 0 0 0 4 4M19 5h2a3 3 0 0 1-4 4M12 13v4M8 21h8',
  modules: 'M9 3h6v3a2 2 0 1 0 4 0V3h2v6h-3a2 2 0 1 0 0 4h3v8h-6v-3a2 2 0 1 0-4 0v3H3v-8h3a2 2 0 1 0 0-4H3V3z',
};
function icon(name) { const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', ICON[name]); s.append(p); return s; }
function toast(msg, bad = false) { const t = document.getElementById('toast'); t.textContent = msg; t.className = `show${bad ? ' bad' : ''}`; clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 3200); }
const num = (n) => Number(n ?? 0).toLocaleString();
const pretty = (n) => n.split('-').map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const initials = (s) => String(s ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const ago = (sec) => { const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`; };

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GoodBoy': '1' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
const moduleUrl = (mod, kind, name) => `/api/guilds/${S.gid}/modules/${mod}/${kind}/${name}`;
const viewOf = (mod, name) => api(moduleUrl(mod, 'views', name));
const act = async (mod, name, body) => (await api(moduleUrl(mod, 'actions', name), body)).result;
const isOn = (mod) => !!S.guild?.modules?.find((m) => m.name === mod)?.enabled;

// ---------------------------------------------------------------- sign in
function signIn(loginReady) {
  tabsEl.hidden = true;
  view.replaceChildren(h('div', { class: 'hero' }, h('img', { src: '/good-boy-logo.png', alt: '' }), h('h1', {}, 'Good Boy'),
    h('p', { class: 'sub' }, loginReady === false ? 'Login is not set up yet. In the Good Boy app on your computer, add your Client Secret (Settings).' : 'Your bot, in your pocket. Log in with the Discord account that manages your server.'),
    loginReady === false ? null : h('button', { class: 'btn', onclick: () => { store.set('gb-return', '/app'); location.href = '/login'; } }, 'Log in with Discord')));
}
function offline() {
  tabsEl.hidden = true;
  view.replaceChildren(h('div', { class: 'hero' }, h('img', { src: '/good-boy-logo.png', alt: '' }), h('h1', {}, 'Bot is offline'),
    h('p', { class: 'sub' }, 'The computer running Good Boy may be off or asleep, or the bot is stopped. Turn it on and open the Good Boy app.'),
    h('button', { class: 'btn quiet', onclick: boot }, 'Try again')));
}
// In the Android app: a way back to the screen where the dashboard link is entered.
function changeLink() { return window.GoodBoyAndroid ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.GoodBoyAndroid.changeLink(); } }, 'Change dashboard link') : null; }

// ---------------------------------------------------------------- pairing (the QR code in the Good Boy app on the computer)
// The code opens this page with ?pair=1. Android: offer to open the Good Boy app, which then remembers this link.
// iPhone: show how to add the page to the Home Screen. Nothing is sent anywhere; only this site's own address is used.
function pairBanner() {
  const q = new URLSearchParams(location.search);
  if (!q.has('pair')) return;
  history.replaceState(null, '', location.pathname);
  if (window.GoodBoyAndroid) return;
  const ua = navigator.userAgent || '';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  let box = null;
  if (/Android/i.test(ua)) {
    const intent = `intent://pair?url=${encodeURIComponent(location.origin)}#Intent;scheme=goodboy;package=com.basicghostlabs.goodboy;S.browser_fallback_url=${encodeURIComponent(`${location.origin}/app`)};end`;
    box = h('div', { class: 'pair' }, h('b', {}, 'Have the Good Boy app?'), h('p', {}, 'Open this bot in it. The app remembers the link, so you never type it.'), h('a', { class: 'btn', href: intent }, 'Open in the Good Boy app'));
  } else if (/iPhone|iPad|iPod/i.test(ua) && !standalone) {
    box = h('div', { class: 'pair' }, h('b', {}, 'Make it an app'), h('p', {}, 'Tap Share, then Add to Home Screen. Good Boy then opens like an app.'));
  }
  if (box) { box.append(h('button', { class: 'pair-x', type: 'button', 'aria-label': 'Close', onclick: () => box.remove() }, '×')); document.body.insertBefore(box, view); }
}

// ---------------------------------------------------------------- boot and server choice
async function boot() {
  pairBanner();
  try { S.me = await api('/api/me'); }
  catch (e) { if (e.status === 401) return signIn(e.data?.loginReady); return offline(); }
  const usable = S.me.guilds.filter((g) => g.access === 'admin');
  if (!usable.length) {
    tabsEl.hidden = true;
    return view.replaceChildren(h('div', { class: 'hero' }, h('h1', {}, 'No servers to manage'), h('p', { class: 'sub' }, 'You need Manage Server (or a role the bot owner gave dashboard access) in a server where Good Boy is.'), h('a', { class: 'btn quiet', href: '/logout' }, 'Log out')));
  }
  const saved = store.get('gb-guild');
  await pick(usable.find((g) => g.id === saved)?.id ?? usable[0].id);
}
async function pick(id) {
  S.gid = id; store.set('gb-guild', id); S.cache = {};
  const g = S.me.guilds.find((x) => x.id === id);
  document.getElementById('server-name').textContent = g?.name ?? 'Good Boy';
  try { S.guild = await api(`/api/guilds/${id}`); } catch (e) { return e.status === 401 ? signIn() : offline(); }
  renderTabs(); show(S.tab);
}
document.getElementById('server').addEventListener('click', () => {
  const list = S.me?.guilds?.filter((g) => g.access === 'admin') ?? [];
  if (list.length < 2) return;
  const close = () => sheet.remove();
  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } }, h('div', { class: 'panel' }, h('div', { class: 'section' }, 'Choose a server'),
    h('div', { class: 'group' }, list.map((g) => h('button', { class: 'row', style: { width: '100%', border: '0', background: 'none', textAlign: 'left' }, onclick: () => { close(); pick(g.id); } },
      g.icon ? h('img', { class: 'av', src: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`, alt: '' }) : h('span', { class: 'av' }, initials(g.name)),
      h('div', { class: 'two' }, h('b', {}, g.name)), g.id === S.gid ? h('span', { class: 'tag' }, 'Open') : null)))));
  document.body.append(sheet);
});

const TABS = [['home', 'Home'], ['levels', 'Levels'], ['announce', 'Announce'], ['events', 'Events'], ['modules', 'Modules']];
function renderTabs() {
  tabsEl.hidden = false;
  tabsEl.replaceChildren(...TABS.map(([id, label]) => h('button', { 'aria-current': S.tab === id ? 'page' : null, onclick: () => show(id) }, icon(id), label)));
}
async function show(tab) {
  S.tab = tab; renderTabs(); window.scrollTo(0, 0);
  view.replaceChildren(h('p', { class: 'center muted' }, 'Loading…'));
  try { view.replaceChildren(...[].concat(await PAGES[tab]())); }
  catch (e) { if (e.status === 401) return signIn(); view.replaceChildren(h('p', { class: 'center muted' }, e.message)); }
}

// ---------------------------------------------------------------- pages
const needs = (mod, what) => [h('div', { class: 'group' }, h('div', { class: 'row' }, h('div', { class: 'two' }, h('b', {}, `${pretty(mod)} is off`), h('small', {}, `Turn it on to use ${what}.`)),
  h('button', { class: 'tag', style: { border: 0 }, onclick: async () => { await toggle(mod, true); show(S.tab); } }, 'Turn on')))];

const PAGES = {
  async home() {
    const st = S.guild.stats ?? {};
    const on = S.guild.modules.filter((m) => m.enabled).length;
    return [h('h1', {}, 'Home'), h('p', { class: 'sub' }, 'Your bot at a glance.'),
      h('div', { class: 'group' }, h('div', { class: 'status' }, h('span', { class: 'dot' }), h('div', { class: 'two' }, h('b', {}, 'Online'), h('small', { class: 'muted' }, `Up ${ago(st.uptimeSeconds ?? 0)} · version ${st.version ?? S.me.version}`))),
        h('div', { class: 'figs' }, [[st.members, 'members'], [on, 'modules on'], [st.channels, 'channels']].map(([v, l]) => h('div', {}, h('b', {}, num(v)), h('small', {}, l))))),
      h('div', { class: 'section' }, 'Quick actions'),
      h('div', { class: 'group' },
        [['announce', 'Send an announcement', 'Post to any channel, with or without a ping'], ['events', 'Start an event hub', 'Teams get their own voice rooms'], ['levels', 'See the leaderboard', 'Who has the most XP']]
          .map(([tab, title, small]) => h('button', { class: 'row', style: { width: '100%', border: 0, background: 'none', textAlign: 'left' }, onclick: () => show(tab) }, h('div', { class: 'two' }, h('b', {}, title), h('small', {}, small)), h('span', { class: 'end muted' }, '›')))),
      h('p', { class: 'note' }, `Signed in as ${S.me.user.username}. `, h('a', { href: '/logout' }, 'Log out'), changeLink() ? ' · ' : null, changeLink())];
  },

  async levels() {
    if (!isOn('community')) return [h('h1', {}, 'Levels'), ...needs('community', 'levels')];
    const d = await viewOf('community', 'levels');
    if (!d.rows.length) return [h('h1', {}, 'Levels'), h('p', { class: 'sub' }, 'Nobody has earned XP yet. Members earn it by chatting.')];
    return [h('h1', {}, 'Levels'), h('p', { class: 'sub' }, `${num(d.total)} members have earned XP.`),
      h('div', { class: 'group' }, d.rows.map((m) => h('div', { class: 'row' }, h('span', { class: 'rank' }, m.rank),
        m.avatar ? h('img', { class: 'av', src: m.avatar, alt: '' }) : h('span', { class: 'av' }, initials(m.name)),
        h('div', { class: 'two' }, h('b', {}, m.name), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round((m.into / m.needed) * 100)}%` } }))),
        h('div', { class: 'end' }, h('b', {}, `Lv ${m.level}`), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${num(m.xp)} XP`)))))];
  },

  async announce() {
    if (!isOn('engagement')) return [h('h1', {}, 'Announce'), ...needs('engagement', 'announcements')];
    const t = S.cache.targets ??= await viewOf('engagement', 'announce-targets');
    const f = { ping: 'none', roleIds: [] };
    const channel = h('select', { id: 'a-ch' }, t.channels.map((c) => h('option', { value: c.id }, `# ${c.name}`)));
    const title = h('input', { id: 'a-title', maxlength: 250, placeholder: 'Optional' });
    const text = h('textarea', { id: 'a-text', maxlength: 3800, placeholder: 'What do you want to say?' });
    const role = h('select', { id: 'a-role' }, t.roles.map((r) => h('option', { value: r.id }, `@ ${r.name}`)));
    const roleField = h('div', { class: 'field', hidden: true }, h('label', { for: 'a-role' }, 'Role to ping'), role);
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Ping' }, [['none', 'No ping'], ['here', '@here'], ['everyone', '@everyone'], ['role', 'A role']].map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(v === f.ping), onclick: (e) => { f.ping = v; for (const b of seg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); roleField.hidden = v !== 'role'; } }, l)));
    const send = h('button', { class: 'btn', onclick: async () => {
      if (!text.value.trim()) return toast('Write the announcement first.', true);
      send.disabled = true;
      try {
        const r = await act('engagement', 'announce', { channelId: channel.value, title: title.value, message: text.value, ping: f.ping, roleIds: f.ping === 'role' ? [role.value] : [] });
        toast(r.warning ?? `Posted in #${r.channel}.`, !!r.warning); text.value = ''; title.value = '';
      } catch (e) { toast(e.message, true); }
      send.disabled = false;
    } }, 'Send');
    return [h('h1', {}, 'Announce'), h('p', { class: 'sub' }, 'Posts right away as the bot.'),
      h('div', { class: 'group' }, h('div', { class: 'field' }, h('label', { for: 'a-ch' }, 'Channel'), channel), h('div', { class: 'field' }, h('label', { for: 'a-title' }, 'Title'), title),
        h('div', { class: 'field' }, h('label', { for: 'a-text' }, 'Message'), text), h('div', { class: 'field' }, h('label', {}, 'Ping'), seg), roleField), send];
  },

  async events() {
    if (!isOn('tempvoice')) return [h('h1', {}, 'Events'), ...needs('tempvoice', 'event hubs')];
    const d = await viewOf('tempvoice', 'events');
    const list = d.events.length ? h('div', { class: 'group' }, d.events.map((e) => h('div', {},
      h('div', { class: 'row' }, h('div', { class: 'two' }, h('b', {}, e.name), h('small', {}, `Teams of ${e.size} · ${e.teams.length}/${e.maxTeams} teams${e.waiting.length ? ` · ${e.waiting.length} waiting` : ''}${e.channel ? ` · #${e.channel}` : ''}`)), h('span', { class: e.locked ? 'tag warn' : 'tag' }, e.locked ? 'Locked' : 'Open')),
      e.teams.length ? h('div', { class: 'row' }, h('small', { class: 'muted' }, e.teams.map((t) => `Team ${t.n}: ${t.members.join(', ')}`).join(' · '))) : null,
      h('div', { class: 'row' }, h('div', { class: 'small-btns', style: { flex: 1 } },
        h('button', { onclick: async () => { try { const r = await act('tempvoice', 'event-lock', { id: e.id }); toast(r.locked ? 'Sign-ups locked.' : 'Sign-ups open again.'); show('events'); } catch (x) { toast(x.message, true); } } }, e.locked ? 'Unlock' : 'Lock'),
        h('button', { style: { color: 'var(--red)' }, onclick: async () => { if (!confirm(`End ${e.name}? Empty team rooms are removed.`)) return; try { await act('tempvoice', 'event-end', { id: e.id }); toast('Event ended.'); show('events'); } catch (x) { toast(x.message, true); } } }, 'End'))))))
      : h('div', { class: 'group' }, h('div', { class: 'row' }, h('small', { class: 'muted' }, 'No events running.')));
    const f = { size: 2 };
    const name = h('input', { id: 'e-name', maxlength: 60, placeholder: 'Fortnite Battle Duos' });
    const sizeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Players per team' }, d.sizes.slice(0, 5).map((n) => h('button', { type: 'button', 'aria-pressed': String(n === f.size), onclick: (ev) => { f.size = n; for (const b of sizeSeg.children) b.setAttribute('aria-pressed', String(b === ev.currentTarget)); } }, n === 2 ? 'Duos' : n === 3 ? 'Trios' : n === 4 ? 'Squads' : String(n))));
    const teams = h('input', { id: 'e-teams', type: 'number', inputmode: 'numeric', min: 1, max: 50, value: 10 });
    const channel = h('select', { id: 'e-ch' }, d.channels.map((c) => h('option', { value: c.id }, `# ${c.name}`)));
    const cat = h('select', { id: 'e-cat' }, h('option', { value: '' }, 'Same as the panel channel'), d.categories.map((c) => h('option', { value: c.id }, c.name)));
    const go = h('button', { class: 'btn', onclick: async () => {
      if (!name.value.trim()) return toast('Give the event a name.', true);
      go.disabled = true;
      try { await act('tempvoice', 'event-create', { name: name.value, size: f.size, maxTeams: Number(teams.value) || 10, channelId: channel.value, categoryId: cat.value || null }); toast('Event posted. Players join from the panel in Discord.'); show('events'); }
      catch (e) { toast(e.message, true); go.disabled = false; }
    } }, 'Post the sign-up panel');
    return [h('h1', {}, 'Events'), h('p', { class: 'sub' }, 'Players join solo, with friends, or make a team room. Each team gets its own voice room.'),
      h('div', { class: 'section' }, 'Running'), list,
      h('div', { class: 'section' }, 'New event'),
      h('div', { class: 'group' }, h('div', { class: 'field' }, h('label', { for: 'e-name' }, 'Event name'), name), h('div', { class: 'field' }, h('label', {}, 'Players per team'), sizeSeg),
        h('div', { class: 'field' }, h('label', { for: 'e-teams' }, 'Most teams'), teams), h('div', { class: 'field' }, h('label', { for: 'e-ch' }, 'Post the panel in'), channel),
        h('div', { class: 'field' }, h('label', { for: 'e-cat' }, 'Team rooms go in'), cat)), go];
  },

  async modules() {
    const mods = [...S.guild.modules].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    return [h('h1', {}, 'Modules'), h('p', { class: 'sub' }, 'Turn features on or off for this server.'),
      h('div', { class: 'group' }, mods.map((m) => h('div', { class: 'row' }, h('div', { class: 'two' }, h('b', {}, pretty(m.name)), h('small', {}, m.description)),
        h('input', { type: 'checkbox', class: 'switch', checked: m.enabled, 'aria-label': `${pretty(m.name)} ${m.enabled ? 'on' : 'off'}`, onchange: async (e) => { e.target.disabled = true; await toggle(m.name, e.target.checked); show('modules'); } }))))];
  },
};

async function toggle(name, on) {
  try { await api(`/api/guilds/${S.gid}/modules/${name}/${on ? 'enable' : 'disable'}`, {}); toast(`${pretty(name)} is ${on ? 'on' : 'off'}.`); }
  catch (e) { toast(e.message, true); }
  S.guild = await api(`/api/guilds/${S.gid}`).catch(() => S.guild);
}

boot();
