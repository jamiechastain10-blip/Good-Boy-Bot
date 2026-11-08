// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// 3.0 dashboard pieces: the server switcher, searchable channel and role pickers, the right-click menu, the
// "where it works" and "who can use it" tabs, and the ticket archive viewer. Loaded before app.js; everything here
// is called later, so it can use app.js's helpers (h, api, state, toast, put). DOM nodes and text only, no HTML strings.
'use strict';

const CH_ICON = { 0: '#', 2: '🔊', 4: '📁', 5: '📢', 13: '🎙️', 15: '💬' };
const recentKey = () => `gb-recent-ch-${state.gid}`;
const recentChannels = () => { try { return JSON.parse(localStorage.getItem(recentKey()) ?? '[]'); } catch { return []; } };
const rememberChannel = (id) => { try { localStorage.setItem(recentKey(), JSON.stringify([id, ...recentChannels().filter((x) => x !== id)].slice(0, 5))); } catch { /* storage blocked */ } };

/** Closes any open popover. */
function closePop() { document.querySelector('.gbpop')?.remove(); document.removeEventListener('mousedown', popOutside, true); }
function popOutside(e) { const p = document.querySelector('.gbpop'); if (p && !p.contains(e.target) && !p._anchor?.contains(e.target)) closePop(); }
/** Opens a floating panel under `anchor`. */
function openPop(anchor, content, { width = 320 } = {}) {
  closePop();
  const r = anchor.getBoundingClientRect();
  const pop = h('div', { class: 'gbpop', role: 'dialog' }, content);
  pop._anchor = anchor;
  pop.style.width = `${Math.min(width, window.innerWidth - 24)}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - width - 12))}px`;
  const below = r.bottom + 6, room = window.innerHeight - below;
  if (room < 260 && r.top > room) { pop.style.bottom = `${window.innerHeight - r.top + 6}px`; } else pop.style.top = `${below}px`;
  document.body.append(pop);
  setTimeout(() => document.addEventListener('mousedown', popOutside, true), 0);
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); anchor.focus(); } });
  return pop;
}

/**
 * A channel picker: a button showing the choice; it opens a search box with channels grouped by category, recent picks
 * on top, only the kinds of channel that make sense (types), and a warning on channels the bot cannot post in.
 */
function channelPicker({ value, types = [0, 5], allowNone = true, label = 'Channel', onPick }) {
  const chans = () => state.data.channels ?? [];
  const nameOf = (id) => chans().find((c) => c.id === id);
  const btn = h('button', { type: 'button', class: 'pickbtn plain', 'aria-haspopup': 'dialog', 'aria-label': label });
  const paint = () => { const c = nameOf(value); put(btn, c ? h('span', {}, `${CH_ICON[c.type] ?? '#'} ${c.name}`) : h('span', { class: 'muted' }, value ? 'Deleted channel' : 'Pick a channel'), h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾')); };
  paint();
  btn.addEventListener('click', () => {
    const input = h('input', { type: 'search', placeholder: 'Search channels', 'aria-label': 'Search channels' });
    const list = h('div', { class: 'picklist', role: 'listbox' });
    let items = [], cursor = 0;
    const choose = (id) => { value = id; if (id) rememberChannel(id); paint(); closePop(); btn.focus(); onPick(id); };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const usable = chans().filter((c) => types.includes(c.type) && (!q || c.name.toLowerCase().includes(q)));
      const cats = new Map(chans().filter((c) => c.type === 4).map((c) => [c.id, c.name]));
      const groups = [];
      const recent = q ? [] : recentChannels().map((id) => usable.find((c) => c.id === id)).filter(Boolean);
      if (recent.length) groups.push(['Recent', recent]);
      const byCat = new Map();
      for (const c of usable) { const k = c.parent && cats.has(c.parent) ? c.parent : ''; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(c); }
      for (const [k, l] of byCat) groups.push([k ? cats.get(k) : 'No category', l]);
      items = [];
      const nodes = [];
      if (allowNone && !q) { items.push(null); nodes.push(h('div', { class: 'pickitem', role: 'option', 'data-i': '0', onclick: () => choose(null) }, h('span', { class: 'muted' }, 'None'))); }
      for (const [title, l] of groups) {
        nodes.push(h('div', { class: 'pickgroup' }, title));
        for (const c of l) {
          const n = items.length; items.push(c.id);
          nodes.push(h('div', { class: 'pickitem' + (c.id === value ? ' on' : '') + (c.canSend === false ? ' warn' : ''), role: 'option', 'aria-selected': String(c.id === value), 'data-i': String(n), 'data-ctx': 'channel', 'data-id': c.id, 'data-name': c.name, onclick: () => choose(c.id) },
            h('span', { class: 'ci', 'aria-hidden': 'true' }, CH_ICON[c.type] ?? '#'), h('span', { class: 'grow' }, c.name),
            c.canSend === false ? h('small', { class: 'warn-text' }, "Good Boy can't post here") : c.id === value ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓') : null));
        }
      }
      if (!items.length) nodes.push(h('p', { class: 'muted pad' }, 'No channel matches.'));
      cursor = Math.min(cursor, Math.max(0, items.length - 1));
      put(list, nodes);
      list.querySelector(`[data-i="${cursor}"]`)?.classList.add('cursor');
    };
    input.addEventListener('input', () => { cursor = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, Math.min(items.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1))); draw(); list.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'Enter' && items.length) { e.preventDefault(); choose(items[cursor]); }
    });
    openPop(btn, [h('div', { class: 'picksearch' }, input), list, h('div', { class: 'pickfoot muted' }, '↑↓ to move · Enter to pick · Esc to close')]);
    draw(); input.focus();
  });
  return btn;
}

/** A role picker with search (divider roles are left out). */
function rolePicker({ value, allowNone = true, label = 'Role', onPick, exclude = [] }) {
  const roles = () => (state.data.roles ?? []).filter((r) => !isDivider(r.name) && !exclude.includes(r.id));
  const btn = h('button', { type: 'button', class: 'pickbtn plain', 'aria-haspopup': 'dialog', 'aria-label': label });
  const paint = () => { const r = (state.data.roles ?? []).find((x) => x.id === value); put(btn, r ? h('span', { style: `color:${r.color && r.color !== '#000000' ? r.color : 'inherit'}` }, `@${r.name}`) : h('span', { class: 'muted' }, value ? 'Deleted role' : 'Pick a role'), h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾')); };
  paint();
  btn.addEventListener('click', () => {
    const input = h('input', { type: 'search', placeholder: 'Search roles', 'aria-label': 'Search roles' });
    const list = h('div', { class: 'picklist', role: 'listbox' });
    const choose = (id) => { value = id; paint(); closePop(); btn.focus(); onPick(id); };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const l = roles().filter((r) => !q || r.name.toLowerCase().includes(q));
      put(list, allowNone && !q ? h('div', { class: 'pickitem', onclick: () => choose(null) }, h('span', { class: 'muted' }, 'None')) : null,
        l.map((r) => h('div', { class: 'pickitem' + (r.id === value ? ' on' : ''), role: 'option', 'data-ctx': 'role', 'data-id': r.id, 'data-name': r.name, onclick: () => choose(r.id) },
          h('span', { class: 'dot', style: `background:${r.color && r.color !== '#000000' ? r.color : 'var(--muted)'}` }), h('span', { class: 'grow' }, `@${r.name}`))),
        l.length ? null : h('p', { class: 'muted pad' }, 'No role matches.'));
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = list.querySelector('.pickitem[data-id]'); if (first) { e.preventDefault(); choose(first.dataset.id); } } });
    openPop(btn, [h('div', { class: 'picksearch' }, input), list]);
    draw(); input.focus();
  });
  return btn;
}

// ---------------------------------------------------------------- right-click menu
async function copyText(text, what = 'Copied') { try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Could not copy. Select the text and press Ctrl+C.', true); } }
/** Right-click on anything with data-ctx (channels, roles, members, tickets, messages) gives the actions for that thing. */
document.addEventListener('contextmenu', (e) => {
  const el = e.target.closest?.('[data-ctx]');
  if (!el || e.target.closest('input, textarea')) return;
  e.preventDefault();
  const { ctx, id, name, text, link } = el.dataset;
  const items = [];
  const guild = state.gid;
  if (ctx === 'channel') items.push(['Open in Discord', () => window.open(`https://discord.com/channels/${guild}/${id}`, '_blank', 'noopener')], ['Copy channel name', () => copyText(`#${name}`)], ['Copy channel ID', () => copyText(id)]);
  if (ctx === 'role') items.push(['Copy role name', () => copyText(`@${name}`)], ['Copy role ID', () => copyText(id)]);
  if (ctx === 'member') items.push(['Copy username', () => copyText(name)], ['Copy user ID', () => copyText(id)], ['Show their tickets', () => archiveSearch({ opener: id })]);
  if (ctx === 'ticket') items.push(['Open', () => el.click()], ['Copy ticket number', () => copyText(`#${id}`)]);
  if (ctx === 'message') items.push(['Copy text', () => copyText(text ?? '')], ['Copy message ID', () => copyText(id)], ...(link ? [['Open in Discord', () => window.open(link, '_blank', 'noopener')]] : []));
  if (ctx === 'module') items.push(['Open', () => el.click()], ['Copy name', () => copyText(name)]);
  if (!items.length) return;
  closePop();
  const menu = h('div', { class: 'gbpop gbmenu', role: 'menu' }, items.map(([label, fn]) => h('button', { type: 'button', class: 'plain', role: 'menuitem', onclick: () => { closePop(); fn(); } }, label)));
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 220)}px`; menu.style.top = `${Math.min(e.clientY, window.innerHeight - items.length * 36 - 16)}px`;
  document.body.append(menu); menu.querySelector('button')?.focus();
  setTimeout(() => document.addEventListener('mousedown', popOutside, true), 0);
  menu.addEventListener('keydown', (k) => { if (k.key === 'Escape') closePop(); });
});

// ---------------------------------------------------------------- server switcher
/** The current server at the top of the sidebar; click to see every server you can open here. */
function serverSwitcher() {
  const g = state.data.guild;
  const icon = (x) => (x.icon ? h('img', { src: `https://cdn.discordapp.com/icons/${x.id}/${x.icon}.png?size=64`, alt: '' }) : h('span', { class: 'ph' }, String(x.name ?? '?').slice(0, 1)));
  const btn = h('button', { type: 'button', class: 'switcher plain', 'aria-haspopup': 'dialog', 'aria-label': `Server: ${g.name}. Switch server` },
    icon(g), h('span', { class: 'sw-meta' }, h('strong', {}, g.name), h('small', { class: 'muted' }, state.data.access === 'admin' ? 'Admin' : 'Limited access')), h('span', { class: 'chev', 'aria-hidden': 'true' }, '⇅'));
  btn.addEventListener('click', () => {
    const all = state.me?.guilds ?? [];
    const input = h('input', { type: 'search', placeholder: 'Search servers', 'aria-label': 'Search servers' });
    const list = h('div', { class: 'picklist' });
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const l = all.filter((x) => !q || x.name.toLowerCase().includes(q));
      const row = (x) => h('div', { class: 'pickitem sw-item' + (x.id === state.gid ? ' on' : ''), role: 'option', onclick: () => { closePop(); if (x.id !== state.gid) { state.gid = x.id; state.page = 'overview'; loadGuild(); } } },
        icon(x), h('span', { class: 'grow' }, x.name, h('small', { class: 'muted' }, x.access === 'admin' ? ' · admin' : ' · limited')), x.id === state.gid ? h('span', { class: 'tick' }, '✓') : null);
      const others = (state.me?.others ?? []).filter((x) => !q || x.name.toLowerCase().includes(q));
      put(list, h('div', { class: 'pickgroup' }, 'Your servers'), l.filter((x) => x.access === 'admin').map(row),
        l.some((x) => x.access !== 'admin') ? h('div', { class: 'pickgroup' }, 'Where you have tools') : null, l.filter((x) => x.access !== 'admin').map(row),
        others.length ? h('div', { class: 'pickgroup' }, 'Other Good Boy bots') : null,
        others.map((x) => h('a', { class: 'pickitem sw-item', href: `${x.url}/?guild=${x.id}`, target: '_blank', rel: 'noopener', title: `Opens ${x.bot}'s dashboard. You sign in there with Discord, and that bot checks your roles.` },
          icon(x), h('span', { class: 'grow' }, x.name, h('small', { class: 'muted' }, ` · run by ${x.bot}`)), h('span', { class: 'muted' }, '↗'))),
        l.length || others.length ? null : h('p', { class: 'muted pad' }, 'No server matches.'));
    };
    input.addEventListener('input', draw);
    openPop(btn, [all.length > 6 ? h('div', { class: 'picksearch' }, input) : null, list, h('div', { class: 'pickfoot muted' }, 'Every server where you are an admin, or where your role gives you dashboard tools.')], { width: 300 });
    draw(); if (all.length > 6) input.focus();
  });
  return btn;
}

// ---------------------------------------------------------------- module page tabs
/** "Where it works": the module is on everywhere except the channels and categories listed. */
function whereTab(m) {
  if (m.canSwitchOffHere === false) return h('div', { class: 'card' }, h('p', { class: 'muted' }, `${modName(m)} always works in every channel, so nothing can slip past it.`));
  let list = [...(m.offChannels ?? [])];
  const chips = h('div', { class: 'chips' });
  const save = async () => { try { const r = await api(`/api/guilds/${state.gid}/modules/${m.name}/off-channels`, { channels: list }); m.offChannels = r.channels; toast('Saved'); } catch (e) { toast(e.message, true); } };
  const paint = () => put(chips, list.length ? list.map((id) => { const c = (state.data.channels ?? []).find((x) => x.id === id);
    return h('span', { class: 'chip', 'data-ctx': 'channel', 'data-id': id, 'data-name': c?.name ?? id }, `${CH_ICON[c?.type] ?? '#'} ${c?.name ?? 'deleted channel'}`, h('button', { class: 'chip-x', 'aria-label': `Turn back on in ${c?.name ?? id}`, onclick: () => { list = list.filter((x) => x !== id); paint(); save(); } }, '×')); })
    : h('span', { class: 'chip default' }, 'Works everywhere'));
  paint();
  const add = channelPicker({ value: null, types: [0, 2, 4, 5, 13, 15], allowNone: false, label: 'Add a channel or category', onPick: (id) => { if (id && !list.includes(id)) { list.push(id); paint(); save(); } } });
  return h('div', { class: 'card' }, h('h3', {}, 'Where it works'),
    h('p', { class: 'muted' }, `${modName(m)} works in every channel except the ones below. Pick a category to switch it off in every channel inside it. Admins can still use its commands anywhere.`),
    chips, h('div', { class: 'row-start' }, h('span', { class: 'muted' }, 'Switch it off in:'), add));
}
/** "Who can use it": this module's permission lines, with role pickers. */
function whoTab(m) {
  const box = h('div', { class: 'card' }, h('h3', {}, 'Who can use it'));
  if (!m.permissions?.length) { box.append(h('p', { class: 'muted' }, 'Everyone can use this module. It has no separate permissions.')); return box; }
  box.append(h('p', { class: 'muted' }, 'Each line starts with its default. Add roles to choose exactly who can do it instead. The owner and Administrators can always do everything.'));
  for (const p of m.permissions) {
    let chosen = [...(p.roles ?? [])];
    const chips = h('div', { class: 'chips' });
    const save = async () => { try { await api(`/api/guilds/${state.gid}/permissions`, { key: p.key, roles: chosen }); p.roles = [...chosen]; toast('Saved'); } catch (e) { toast(e.message, true); } };
    const paint = () => put(chips, chosen.length ? chosen.map((id) => { const r = state.data.roles.find((x) => x.id === id);
      return h('span', { class: 'chip', 'data-ctx': 'role', 'data-id': id, 'data-name': r?.name ?? id }, `@${r?.name ?? 'deleted role'}`, h('button', { class: 'chip-x', 'aria-label': `Remove @${r?.name ?? id}`, onclick: () => { chosen = chosen.filter((x) => x !== id); paint(); save(); } }, '×')); })
      : h('span', { class: 'chip default' }, LEVEL_WORDS[p.default] ?? p.default));
    paint();
    box.append(h('div', { class: 'perm' }, h('div', { class: 'perm-text' }, h('strong', {}, p.label)),
      h('div', { class: 'perm-roles' }, chips, rolePicker({ value: null, allowNone: false, label: `Add a role to: ${p.label}`, exclude: chosen, onPick: (id) => { if (id && !chosen.includes(id)) { chosen.push(id); paint(); save(); } } }))));
  }
  return box;
}
/** "History": what changed and what went wrong for this module. */
function historyTab(m) {
  const box = h('div', { class: 'card' }, h('h3', {}, 'History'), h('p', { class: 'muted' }, 'Loading…'));
  api(`/api/guilds/${state.gid}/logs`).then(({ logs }) => {
    const mine = logs.filter((l) => l.module === m.name || (l.module === 'dashboard' && new RegExp(`\\b${m.name}\\b`).test(l.message)));
    put(box, h('h3', {}, 'History'), mine.length ? h('table', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'What')),
      mine.slice(0, 60).map((l) => h('tr', {}, h('td', {}, new Date(l.ts).toLocaleString()), h('td', { class: l.level === 'error' ? 'bad' : '' }, l.message))))
      : h('p', { class: 'muted' }, 'Nothing recorded for this module yet.'));
  }).catch((e) => put(box, h('h3', {}, 'History'), h('p', { class: 'muted' }, e.message)));
  return box;
}

// ---------------------------------------------------------------- ticket archive
let archiveSearch = () => {};
const fmtDay = (t) => (t ? new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const fmtWhen = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
/** The archive: tickets on the left (search and filters), the chat in the middle, who is involved on the right. */
function ticketArchive(m) {
  const base = `/api/guilds/${state.gid}/modules/support/views`;
  const q = { search: '', status: '', type: '', opener: '', page: 0 };
  const search = h('input', { type: 'search', placeholder: 'Search every ticket message', 'aria-label': 'Search tickets' });
  const status = h('div', { class: 'gb-seg', role: 'group', 'aria-label': 'Status' });
  const typeSel = h('select', { 'aria-label': 'Ticket type' }, h('option', { value: '' }, 'All types'));
  const listEl = h('div', { class: 'ta-list' });
  const chat = h('div', { class: 'ta-chat' }, h('p', { class: 'muted pad' }, 'Pick a ticket to read it.'));
  const side = h('div', { class: 'ta-side' });
  const root = h('div', { class: 'card ta' }, h('div', { class: 'ta-left' }, h('div', { class: 'ta-tools' }, search, status, typeSel), listEl), chat, side);
  for (const [v, l] of [['', 'All'], ['open', 'Open'], ['closed', 'Closed']]) status.append(h('button', { type: 'button', 'aria-pressed': String(q.status === v), onclick: (e) => { q.status = v; for (const b of status.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); load(); } }, l));
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q.search = search.value.trim(); load(); }, 250); });
  typeSel.addEventListener('change', () => { q.type = typeSel.value; load(); });
  archiveSearch = (extra) => { Object.assign(q, { search: '', status: '', type: '', opener: '' }, extra); search.value = ''; load(); };
  const mark = (snip) => { const out = []; const parts = String(snip).split(/(\[\[|\]\])/); let on = false; for (const p of parts) { if (p === '[[') on = true; else if (p === ']]') on = false; else if (p) out.push(on ? h('mark', {}, p) : p); } return out; };
  async function load() {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null));
    let data; try { data = await api(`${base}/archive?${params}`); } catch (e) { put(listEl, h('p', { class: 'muted pad' }, e.message)); return; }
    if (typeSel.options.length === 1) for (const ty of data.types) typeSel.append(h('option', { value: ty.id }, ty.label));
    put(listEl, data.rows.length ? data.rows.map((r) => h('button', { type: 'button', class: 'ta-item plain', 'data-ctx': 'ticket', 'data-id': String(r.number), onclick: (e) => { for (const x of listEl.querySelectorAll('.ta-item')) x.classList.toggle('on', x === e.currentTarget); open(r.number); } },
      h('div', { class: 'ta-r1' }, h('span', { class: `dot ${r.status === 'open' ? 'ok' : 'off'}` }), h('strong', {}, `#${String(r.number).padStart(3, '0')}`), h('span', { class: 'muted grow' }, r.type), h('small', { class: 'muted' }, fmtWhen(r.openedAt))),
      h('div', { class: 'ta-r2 muted' }, r.match ? mark(r.match) : `${r.opener.name ?? 'Someone'}${r.about?.name ? ` about @${r.about.name}` : ''}`),
      h('div', { class: 'ta-r3' }, h('span', { class: 'tag' }, r.status === 'open' ? 'Open' : 'Closed'), h('span', { class: 'tag' }, `${r.messages} message${r.messages === 1 ? '' : 's'}`))))
      : h('p', { class: 'muted pad' }, q.search ? 'No ticket has those words.' : 'No tickets yet.'));
  }
  async function open(number) {
    put(chat, h('p', { class: 'muted pad' }, 'Loading…')); put(side);
    let tk; try { tk = await api(`${base}/archiveTicket?number=${number}`); } catch (e) { put(chat, h('p', { class: 'muted pad' }, e.message)); return; }
    const file = (a) => (a.url && /\.(png|jpe?g|gif|webp)$/i.test(a.name) ? h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'ta-shot' }, h('img', { src: a.url, alt: a.name, loading: 'lazy' }), h('span', {}, a.name))
      : a.url ? h('a', { href: a.url, class: 'ta-file', download: a.name }, `📎 ${a.name}`) : h('span', { class: 'ta-file muted' }, `📎 ${a.name} (${a.error ?? 'not kept'})`));
    const msgs = tk.messages.map((x) => h('div', { class: 'ta-msg' + (x.deleted ? ' deleted' : ''), 'data-ctx': 'message', 'data-id': x.id, 'data-text': x.content ?? '' },
      x.author.avatar ? h('img', { class: 'ta-av', src: x.author.avatar, alt: '' }) : h('span', { class: 'ta-av ph' }, String(x.author.name ?? '?').slice(0, 1)),
      h('div', { class: 'grow' }, h('div', { class: 'ta-who' }, h('strong', { 'data-ctx': 'member', 'data-id': x.author.id ?? '', 'data-name': x.author.name ?? '' }, x.author.name), x.author.bot ? h('span', { class: 'botbadge' }, 'APP') : null, h('small', { class: 'muted' }, fmtWhen(x.at)), x.editedAt ? h('small', { class: 'muted' }, '(edited)') : null, x.deleted ? h('small', { class: 'bad' }, '(deleted)') : null),
        x.content ? h('p', {}, x.content) : null,
        x.embeds.map((e) => h('div', { class: 'ta-embed', style: e.color ? `border-left-color:#${e.color.toString(16).padStart(6, '0')}` : null }, e.title ? h('strong', {}, e.title) : null, e.description ? h('p', {}, e.description) : null,
          e.fields.length ? h('div', { class: 'ta-fields' }, e.fields.map((f) => h('div', {}, h('small', {}, f.name), h('div', {}, f.value)))) : null)),
        x.attachments.length ? h('div', { class: 'ta-files' }, x.attachments.map(file)) : null)));
    put(chat, h('div', { class: 'ta-head' }, h('strong', {}, `#${String(tk.number).padStart(3, '0')} · ${tk.type}`), h('span', { class: 'tag' }, tk.closedAt ? 'Closed' : 'Open')),
      h('div', { class: 'ta-msgs' }, tk.answers.length ? h('div', { class: 'ta-embed form' }, h('strong', {}, 'What they wrote in the form'), tk.answers.map((a) => h('div', {}, h('small', {}, a.q), h('p', {}, a.a)))) : null,
        tk.files.length ? h('div', { class: 'ta-files' }, tk.files.map(file)) : null,
        msgs.length ? msgs : h('p', { class: 'muted pad' }, 'No messages were kept for this ticket (it is older than the archive, or archiving is off).')));
    const person = (title, p, facts) => p ? h('div', { class: 'ta-person' }, h('small', { class: 'muted' }, title),
      h('strong', { 'data-ctx': 'member', 'data-id': p.id ?? '', 'data-name': p.name ?? '' }, p.name ? `@${p.name}` : 'Unknown'), p.id ? h('code', {}, p.id) : null,
      h('dl', {}, p.created ? [h('dt', {}, 'Account made'), h('dd', {}, fmtDay(p.created))] : null, p.joined ? [h('dt', {}, 'Joined'), h('dd', {}, fmtDay(p.joined))] : p.inServer === false ? [h('dt', {}, 'Joined'), h('dd', {}, 'Not in the server')] : null,
        facts ? [h('dt', {}, 'Warnings'), h('dd', {}, String(facts.warnings)), h('dt', {}, 'Timeouts · bans'), h('dd', {}, `${facts.timeouts} · ${facts.bans}`), h('dt', {}, 'Reported before'), h('dd', {}, `${facts.reports}${facts.confirmed ? ` (${facts.confirmed} confirmed)` : ''}`), h('dt', {}, 'Tickets opened'), h('dd', {}, String(facts.tickets))] : null),
      p.id ? h('button', { type: 'button', class: 'ghost', onclick: () => archiveSearch({ opener: p.id }) }, 'Their tickets') : null) : null;
    put(side, h('small', { class: 'autofill' }, '✦ Filled in when the ticket opened'), person('About', tk.about, tk.background.about), person('Opened by', tk.opener, tk.background.opener),
      tk.closedAt ? h('div', { class: 'ta-person' }, h('small', { class: 'muted' }, 'How it ended'), h('dl', {}, h('dt', {}, 'Closed'), h('dd', {}, fmtWhen(tk.closedAt)), tk.resolution ? [h('dt', {}, 'Resolution'), h('dd', {}, tk.resolution)] : null, tk.reason ? [h('dt', {}, 'Reason'), h('dd', {}, tk.reason)] : null, tk.notes ? [h('dt', {}, 'Notes'), h('dd', {}, tk.notes)] : null)) : null);
  }
  load();
  return root;
}

// ---------------------------------------------------------------- who is signed in (bot owner)
/** Phones and browsers signed in to this bot's dashboard; the owner can sign any of them out. */
function signedInCard() {
  const box = h('div', { class: 'card' }, h('h3', {}, 'Signed in'), h('p', { class: 'muted' }, 'Loading…'));
  const load = async () => {
    let d; try { d = await api('/api/sessions'); } catch (e) { put(box, h('h3', {}, 'Signed in'), h('p', { class: 'muted' }, e.message)); return; }
    put(box, h('div', { class: 'row' }, h('h3', {}, 'Signed in'), h('span', { class: 'hint' }, 'phones and browsers')),
      h('p', { class: 'muted' }, 'Everyone using the dashboard or the phone app right now. Signing someone out ends their session at once; they can sign in again only if they still have access.'),
      h('div', { class: 'group' }, d.sessions.map((x) => h('div', { class: 'perm', 'data-ctx': 'member', 'data-id': x.user.id, 'data-name': x.user.username },
        h('div', { class: 'perm-text' }, h('strong', {}, x.user.username, x.you ? ' (you)' : ''), h('small', { class: 'hint' }, `${x.device}${x.lastSeen ? ` · active ${ago(x.lastSeen)}` : ''}`)),
        x.you ? null : h('button', { type: 'button', class: 'ghost danger-text', onclick: async () => { if (!(await ask({ title: `Sign out ${x.user.username}?`, text: 'They are signed out of the dashboard and the phone app straight away.', okLabel: 'Sign out', danger: true }))) return; try { await api('/api/sessions/signout', { id: x.id }); toast(`${x.user.username} was signed out`); load(); } catch (e) { toast(e.message, true); } } }, 'Sign out')))));
  };
  load();
  return box;
}
