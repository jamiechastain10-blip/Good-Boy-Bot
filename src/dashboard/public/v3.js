// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// 3.0 dashboard pieces: the server switcher, searchable channel and role pickers, the right-click menu, the
// "where it works" and "who can use it" tabs, and the ticket archive viewer. Loaded before app.js; everything here
// is called later, so it can use app.js's helpers (h, api, state, toast, put). DOM nodes and text only, no HTML strings.
'use strict';
/** Sets styles through the style object (allowed by the page's security policy), never as style text. */
const sty = (node, props) => { Object.assign(node.style, props); return node; };

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
  const paint = () => { const r = (state.data.roles ?? []).find((x) => x.id === value); put(btn, r ? sty(h('span', {}, `@${r.name}`), { color: r.color && r.color !== '#000000' ? r.color : 'inherit' }) : h('span', { class: 'muted' }, value ? 'Deleted role' : 'Pick a role'), h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾')); };
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
          sty(h('span', { class: 'dot' }), { background: r.color && r.color !== '#000000' ? r.color : 'var(--muted)' }), h('span', { class: 'grow' }, `@${r.name}`))),
        l.length ? null : h('p', { class: 'muted pad' }, 'No role matches.'));
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = list.querySelector('.pickitem[data-id]'); if (first) { e.preventDefault(); choose(first.dataset.id); } } });
    openPop(btn, [h('div', { class: 'picksearch' }, input), list]);
    draw(); input.focus();
  });
  return btn;
}

// ---------------------------------------------------------------- moderation from the dashboard (3.0.1)
const MOD_ACTIONS = { warn: ['Warn', 'warned'], timeout: ['Time out', 'timed out'], untimeout: ['Remove timeout', 'no longer timed out'], kick: ['Kick', 'kicked'], ban: ['Ban', 'banned'] };
const TIMEOUTS = [[5, '5 minutes'], [10, '10 minutes'], [60, '1 hour'], [360, '6 hours'], [1440, '1 day'], [4320, '3 days'], [10080, '1 week'], [40320, '28 days']];
/** Moderation is on here and this person can see the history (the bot still checks each action's own permission). */
function canModerate() {
  const m = state.data?.modules?.find((x) => x.name === 'moderation' && x.enabled !== false);
  return !!m && (state.data.access === 'admin' || (m.panels ?? []).some((p) => p.id === 'cases'));
}
/** The dialog for warn / time out / kick / ban. Resolves to the result, or null when cancelled. */
function modDialog({ userId, name, action = 'warn', onDone = null }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const pick = h('select', { class: 'field', 'aria-label': 'Action' }, Object.entries(MOD_ACTIONS).map(([v, [l]]) => h('option', { value: v, selected: v === action }, l)));
    const reason = h('textarea', { class: 'field', placeholder: 'Reason (the member sees this, and it goes in the mod log)', maxlength: 500 });
    const mins = h('select', { class: 'field', 'aria-label': 'How long' }, TIMEOUTS.map(([v, l]) => h('option', { value: String(v), selected: v === 60 }, l)));
    const days = h('select', { class: 'field', 'aria-label': 'Delete their messages from' }, [[0, "Don't delete messages"], [1, 'Delete the last day'], [7, 'Delete the last 7 days']].map(([v, l]) => h('option', { value: String(v) }, l)));
    const who = userId ? null : h('input', { class: 'field', type: 'text', inputmode: 'numeric', placeholder: 'User ID (right-click them in Discord, Copy User ID)' });
    const minsRow = h('label', { class: 'small' }, 'How long', mins);
    const daysRow = h('label', { class: 'small' }, 'Their messages', days);
    const err = h('p', { class: 'err small', hidden: true });
    const ok = h('button', { type: 'button' }, 'Do it');
    const cancel = h('button', { type: 'button', class: 'ghost' }, 'Cancel');
    const sync = () => {
      const a = pick.value;
      minsRow.hidden = a !== 'timeout'; daysRow.hidden = a !== 'ban';
      reason.placeholder = a === 'untimeout' ? 'Reason (optional)' : 'Reason (the member sees this, and it goes in the mod log)';
      ok.textContent = MOD_ACTIONS[a][0]; ok.className = ['kick', 'ban'].includes(a) ? 'danger' : '';
      const id = userId ?? who?.value.trim();
      ok.disabled = !/^\d{17,20}$/.test(id ?? '') || (a !== 'untimeout' && !reason.value.trim());
    };
    const done = (v) => { back.remove(); document.removeEventListener('keydown', key); prev?.focus?.(); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') done(null); };
    ok.addEventListener('click', async () => {
      if (ok.disabled) return;
      ok.disabled = true; err.hidden = true;
      const body = { userId: userId ?? who.value.trim(), action: pick.value, reason: reason.value.trim(), minutes: Number(mins.value), deleteDays: Number(days.value) };
      try {
        const r = await api(`/api/guilds/${state.gid}/modules/moderation/actions/member-action`, body);
        const res = r.result ?? r;
        toast(`${res.user?.name ?? name ?? 'Member'} ${MOD_ACTIONS[body.action][1]}${res.case ? ` (case #${res.case})` : ''}`);
        done(res); onDone?.(res);
      } catch (e) { err.textContent = e.message; err.hidden = false; sync(); }
    });
    cancel.addEventListener('click', () => done(null));
    for (const x of [pick, reason, who]) x?.addEventListener('input', sync);
    pick.addEventListener('change', sync);
    const back = h('div', { class: 'dialog-back', role: 'presentation' },
      h('div', { class: 'dialog mod-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Moderate ${name ?? 'a member'}` },
        h('h3', {}, name ? `Moderate ${name}` : 'Moderate a member'), userId ? h('p', { class: 'muted small' }, `ID ${userId}`) : who,
        pick, reason, minsRow, daysRow, err, h('div', { class: 'dialog-buttons' }, cancel, ok)));
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    document.addEventListener('keydown', key);
    document.body.append(back);
    sync();
    (who ?? reason).focus();
  });
}
/** Warn / Time out / Kick / Ban buttons for one member (ticket side panel, member lists). */
function modButtons(userId, name, onDone) {
  if (!userId || !canModerate()) return null;
  const b = (a, cls = 'ghost') => h('button', { type: 'button', class: cls, onclick: () => modDialog({ userId, name, action: a, onDone }) }, MOD_ACTIONS[a][0]);
  return h('div', { class: 'mod-btns' }, b('warn'), b('timeout'), b('kick', 'ghost danger-text'), b('ban', 'ghost danger-text'));
}
/** The Moderation page: act on anyone, the case history, then AutoMod underneath. */
async function renderModeration(ws) {
  const base = `/api/guilds/${state.gid}/modules/moderation`;
  if (canModerate()) {
    const list = h('div', { class: 'mod-cases' }, h('p', { class: 'muted' }, 'Loading…'));
    const filter = h('input', { type: 'search', class: 'field', placeholder: 'Search member, reason or moderator', 'aria-label': 'Search the history' });
    let rows = [];
    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = rows.filter((r) => !q || [r.member, r.reason, r.by, r.type, r.userId].some((x) => String(x ?? '').toLowerCase().includes(q)));
      put(list, shown.length ? h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['When', 'Member', 'What', 'Reason', 'By', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, shown.map((r) => h('tr', {}, h('td', {}, h('small', {}, r.when)), h('td', {}, h('strong', { 'data-ctx': 'member', 'data-id': r.userId, 'data-name': r.member }, r.member)),
          h('td', {}, h('span', { class: `tag mod-${r.type.split(' ')[0].toLowerCase()}` }, r.type)), h('td', {}, r.reason), h('td', {}, h('small', {}, r.by)),
          h('td', {}, h('button', { type: 'button', class: 'ghost small', onclick: () => modDialog({ userId: r.userId, name: r.member, onDone: load }) }, 'Act'))))))
        : h('p', { class: 'muted' }, rows.length ? 'Nothing matches that search.' : 'No warnings, timeouts, kicks or bans yet.'));
    };
    const load = async () => { try { rows = (await api(`${base}/views/cases`)).rows ?? []; paint(); } catch (e) { put(list, h('p', { class: 'muted' }, e.message)); } };
    filter.addEventListener('input', paint);
    ws.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Moderation history'), h('span', { class: 'grow' }),
      h('button', { type: 'button', onclick: () => modDialog({ onDone: load }) }, 'Act on a member')),
      h('p', { class: 'hint' }, 'Every warning, timeout, kick and ban, from Discord, the dashboard and AutoMod. Right-click a name for more.'), filter, list));
    load();
  }
  await renderAutomod(ws);
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
  if (ctx === 'member') {
    items.push(['Copy username', () => copyText(name)], ['Copy user ID', () => copyText(id)], ['Show their tickets', () => archiveSearch({ opener: id })]);
    if (id && canModerate()) items.push(...['warn', 'timeout', 'kick', 'ban'].map((a) => [`${MOD_ACTIONS[a][0]}…`, () => modDialog({ userId: id, name, action: a })]));
  }
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

// ---------------------------------------------------------------- ticket archive (the 3.0 design)
let archiveSearch = () => {};
const fmtDay = (t) => (t ? new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const fmtWhen = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtShort = (t) => { if (!t) return ''; const d = new Date(t), today = new Date(); return d.toDateString() === today.toDateString() ? `Today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const ago2 = (t) => { const days = Math.floor((Date.now() - t) / 86400000); return days >= 365 ? `${Math.floor(days / 365)} year${days >= 730 ? 's' : ''} ago` : days >= 30 ? `${Math.floor(days / 30)} month${days >= 60 ? 's' : ''} ago` : days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : 'Today'; };
const slugOf = (r) => `${String(r.category ?? r.type ?? 'ticket').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '').slice(0, 12) || 'ticket'}-${String(r.number).padStart(4, '0')}`;
const typeTag = (r) => { const c = String(r.category ?? ''); return h('span', { class: `tag ${/report|scam|safety/.test(c) ? 'crit' : /appeal/.test(c) ? '' : 'acc'}` }, String(r.type ?? 'Ticket').replace(/^(Report a member|Ban, mute or warning appeal|Question or other)$/, (x) => ({ 'Report a member': 'Report', 'Ban, mute or warning appeal': 'Appeal', 'Question or other': 'Help' }[x])).slice(0, 18)); };
/** Tickets: the list on the left (search and filters), the chat in the middle, who it is about on the right. */
function ticketArchive(m) {
  const base = `/api/guilds/${state.gid}/modules/support/views`;
  const q = { search: '', status: '', type: '', opener: '', page: 0 };
  const search = h('input', { type: 'search', placeholder: 'Search every ticket', 'aria-label': 'Search tickets' });
  const chips = h('div', { class: 'ta-chips', role: 'group', 'aria-label': 'Show' });
  const listEl = h('div', { class: 'ta-list' });
  const chat = h('div', { class: 'ta-chat' }, h('div', { class: 'ta-empty muted' }, 'Pick a ticket to read it.'));
  const side = h('div', { class: 'ta-side' });
  const root = h('div', { class: 'ta' }, h('div', { class: 'ta-left' }, h('div', { class: 'ta-top' }, h('h2', {}, 'Tickets'), search), chips, listEl), chat, side);
  let counts = {};
  const drawChips = () => put(chips, [['', 'All', ''], ['open', 'Open', 'status'], ['closed', 'Closed', 'status'], ['report', 'Reports', 'type']].map(([v, label, key]) => {
    const onNow = key === 'type' ? q.type === v : key === 'status' ? q.status === v && !q.type : !q.status && !q.type;
    return h('button', { type: 'button', class: 'chipf plain' + (onNow ? ' on' : ''), onclick: () => { if (key === 'type') { q.type = q.type === v ? '' : v; q.status = ''; } else { q.status = v; q.type = ''; } drawChips(); load(); } }, label, v === 'open' && counts.open ? ` · ${counts.open}` : '');
  }));
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q.search = search.value.trim(); load(); }, 250); });
  archiveSearch = (extra) => { Object.assign(q, { search: '', status: '', type: '', opener: '' }, extra); search.value = ''; drawChips(); load(); };
  const mark = (snip) => { const out = []; let on = false; for (const p of String(snip).split(/(\[\[|\]\])/)) { if (p === '[[') on = true; else if (p === ']]') on = false; else if (p) out.push(on ? h('mark', {}, p) : p); } return out; };
  let openNum = null;
  async function load() {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null));
    let data; try { data = await api(`${base}/archive?${params}`); } catch (e) { put(listEl, h('p', { class: 'muted pad' }, e.message)); return; }
    if (!q.status && !q.type && !q.search) { counts = { open: data.rows.filter((r) => r.status === 'open').length }; drawChips(); }
    put(listEl, data.rows.length ? data.rows.map((r) => h('button', { type: 'button', class: 'ta-item plain' + (r.number === openNum ? ' on' : ''), 'data-ctx': 'ticket', 'data-id': String(r.number), onclick: (e) => { openNum = r.number; for (const x of listEl.querySelectorAll('.ta-item')) x.classList.toggle('on', x === e.currentTarget); open(r.number); } },
      h('div', { class: 'ta-r1' }, h('span', { class: `dot ${r.status === 'open' ? (/report|scam|safety/.test(r.category) ? 'crit' : 'warn') : 'off'}` }), h('strong', {}, `#${slugOf(r)}`), h('time', {}, fmtShort(r.openedAt))),
      h('div', { class: 'ta-r2' }, r.match ? mark(r.match) : r.last ? `${r.last.author_name}: ${r.last.content}` : `${r.opener.name ?? 'Someone'}${r.about?.name ? ` about @${r.about.name}` : ''}`),
      h('div', { class: 'ta-r3' }, typeTag(r), h('span', { class: 'tag' }, r.status === 'open' ? 'Open' : r.closedBy ? 'Closed' : 'Closed'), r.files ? h('span', { class: 'tag' }, `${r.files} file${r.files === 1 ? '' : 's'}`) : null)))
      : h('p', { class: 'muted pad' }, q.search ? 'No ticket has those words.' : 'No tickets yet.'));
  }
  async function open(number) {
    put(chat, h('div', { class: 'ta-empty muted' }, 'Loading…')); put(side);
    let tk; try { tk = await api(`${base}/archiveTicket?number=${number}`); } catch (e) { put(chat, h('div', { class: 'ta-empty muted' }, e.message)); return; }
    const files = (list) => (list.length ? h('div', { class: 'ta-files' }, list.map((a) => (a.url && /\.(png|jpe?g|gif|webp)$/i.test(a.name)
      ? h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'ta-shot' }, h('img', { src: a.url, alt: a.name, loading: 'lazy' }), h('span', {}, `🖼 ${a.name} · saved`))
      : a.url ? h('a', { href: a.url, class: 'ta-file', download: a.name }, `📎 ${a.name}`) : h('span', { class: 'ta-file muted' }, `📎 ${a.name} (${a.error ?? 'not kept'})`)))) : null);
    const av = (name, url, cls = 'ta-av') => (url ? h('img', { class: cls, src: url, alt: '' }) : sty(h('span', { class: `${cls} ph` }, String(name ?? '?').slice(0, 2).toUpperCase()), { background: `hsl(${[...String(name ?? '?')].reduce((n, c) => n + c.charCodeAt(0), 0) % 360} 60% 72%)` }));
    const msgs = tk.messages.map((x) => h('div', { class: 'ta-msg' + (x.deleted ? ' deleted' : ''), 'data-ctx': 'message', 'data-id': x.id, 'data-text': x.content ?? '', 'data-link': tk.channelId ? `https://discord.com/channels/${state.gid}/${tk.channelId}/${x.id}` : '' },
      av(x.author.name, x.author.avatar),
      h('div', { class: 'grow' }, h('div', { class: 'ta-who' }, h('strong', { class: x.author.bot ? 'botname' : '', 'data-ctx': 'member', 'data-id': x.author.id ?? '', 'data-name': x.author.name ?? '' }, x.author.name), x.author.bot ? h('span', { class: 'botbadge' }, 'APP') : null, h('small', {}, fmtWhen(x.at)), x.editedAt ? h('small', {}, '(edited)') : null, x.deleted ? h('small', { class: 'bad' }, '(deleted)') : null),
        x.content ? h('p', {}, x.content) : null,
        x.embeds.map((e) => sty(h('div', { class: 'ta-embed' }, e.title ? h('strong', {}, e.title) : null, e.description ? h('p', {}, e.description) : null,
          e.fields.length ? h('div', { class: 'ta-fields' }, e.fields.map((f) => h('div', {}, h('small', {}, f.name), h('div', {}, f.value)))) : null), e.color ? { borderLeftColor: `#${e.color.toString(16).padStart(6, '0')}` } : {})),
        files(x.attachments))));
    const fileCount = tk.files.length + tk.messages.reduce((n, x) => n + x.attachments.length, 0);
    put(chat, h('div', { class: 'ta-head' }, h('span', { class: 'hash' }, '#'), h('strong', {}, slugOf(tk)), typeTag(tk), h('span', { class: 'grow' }),
        tk.channelId && !tk.closedAt ? h('a', { class: 'btn-s pri', href: `https://discord.com/channels/${state.gid}/${tk.channelId}`, target: '_blank', rel: 'noopener' }, 'Open in Discord') : h('span', { class: 'tag' }, tk.closedAt ? `Closed ${fmtShort(tk.closedAt)}` : 'Open')),
      h('div', { class: 'ta-msgs' }, tk.answers.length ? h('div', { class: 'ta-msg' }, av('Good Boy', '/good-boy-logo.png'), h('div', { class: 'grow' }, h('div', { class: 'ta-who' }, h('strong', { class: 'botname' }, 'Good Boy'), h('span', { class: 'botbadge' }, 'APP'), h('small', {}, fmtWhen(tk.openedAt))),
        h('div', { class: 'ta-embed form' }, h('strong', {}, `${tk.type} from ${tk.opener.name ?? 'someone'}`), tk.answers.map((a) => h('p', {}, a.a)),
          tk.about ? h('div', { class: 'ta-fields' }, h('div', {}, h('small', {}, 'About'), h('div', {}, `@${tk.about.name ?? tk.about.id}`)), tk.about.created ? h('div', {}, h('small', {}, 'Account age'), h('div', {}, ago2(tk.about.created).replace(' ago', ''))) : null, tk.background.about ? h('div', {}, h('small', {}, 'Past reports'), h('div', {}, String(tk.background.about.reports))) : null) : null),
        files(tk.files))) : null,
        msgs.length ? msgs : h('p', { class: 'muted pad' }, 'No messages were kept for this ticket.')),
      h('div', { class: 'ta-foot' }, `📎 Archive copy · ${tk.messages.length} message${tk.messages.length === 1 ? '' : 's'}, ${fileCount} file${fileCount === 1 ? '' : 's'} kept on this PC`));
    const p = tk.about ?? tk.opener, facts = tk.about ? tk.background.about : tk.background.opener;
    put(side, h('small', { class: 'autofill' }, '✦ Filled in when the ticket opened'),
      h('div', { class: 'ta-person' }, av(p.name, null, 'ta-big'), h('strong', { class: 'ta-name', 'data-ctx': 'member', 'data-id': p.id ?? '', 'data-name': p.name ?? '' }, p.name ?? 'Unknown'), p.id ? h('code', {}, `ID ${p.id}`) : null),
      p.inServer === false ? null : modButtons(p.id, p.name),
      h('dl', { class: 'ta-kv' }, p.created ? [h('dt', {}, 'Account created'), h('dd', {}, ago2(p.created))] : null, [h('dt', {}, 'Joined server'), h('dd', {}, p.joined ? ago2(p.joined) : p.inServer === false ? 'Not in the server' : '—')],
        facts ? [h('dt', {}, 'Warnings'), h('dd', {}, String(facts.warnings)), h('dt', {}, 'Tickets opened'), h('dd', {}, String(facts.tickets))] : null),
      facts?.items?.length ? [h('div', { class: 'ta-label' }, 'History'), h('div', { class: 'ta-hist' }, facts.items.map((x) => h('div', {}, h('b', {}, x.title), h('small', {}, [x.by ? `by ${x.by}` : null, x.at ? fmtShort(x.at) : null].filter(Boolean).join(' · ')))))] : h('p', { class: 'muted' }, 'No warnings or earlier reports.'),
      tk.about && tk.opener ? h('div', { class: 'ta-person mini' }, h('small', { class: 'muted' }, 'Opened by'), h('strong', {}, tk.opener.name ?? tk.opener.id), h('button', { type: 'button', class: 'ghost', onclick: () => archiveSearch({ opener: tk.opener.id }) }, 'Their tickets')) : null,
      tk.closedAt && (tk.resolution || tk.reason) ? h('div', { class: 'ta-person mini' }, h('small', { class: 'muted' }, 'How it ended'), tk.resolution ? h('div', {}, tk.resolution) : null, tk.reason ? h('small', { class: 'muted' }, tk.reason) : null) : null);
  }
  drawChips(); load();
  return root;
}

// ---------------------------------------------------------------- settings hub and the fun pages
/** Inside the Windows app only: the critical controls, which never appear in a browser or on the phone. */
function botControlsCard() {
  const link = (to, label, cls = 'ghost') => h('a', { class: `btn-app ${cls}`, href: `goodboy-app://${to}` }, label);
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Bot controls'), h('span', { class: 'hint' }, 'Windows app only')),
    h('div', { class: 'app-ctrls' }, link('restart', 'Restart'), link('stop', 'Stop', 'ghost danger-text'), link('page/updates', 'Updates'), link('page/settings', 'Token, licence and backups')),
    h('p', { class: 'hint' }, 'The app\'s own pages (overview, logs, levels) are in ', h('a', { href: 'goodboy-app://page/overview' }, 'the app view'), '.'));
}
function renderSettingsHub(ws) {
  const d = state.data, admin = d.access === 'admin';
  const tile = (id, icon, title, text) => h('button', { type: 'button', class: 'quick plain', onclick: () => go(id) }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon), h('span', {}, h('strong', {}, title), h('small', {}, text)));
  ws.append(h('div', { class: 'card' }, h('h3', {}, 'Settings'), h('div', { class: 'quick-grid' },
    admin ? tile('permissions', '♙', 'Permissions', 'Who can do what') : null,
    admin ? tile('feedback', '💬', 'Tester feedback', 'What testers sent') : null,
    tile('whatsnew', '★', "What's new", 'What changed in each update'),
    tile('appearance', '✦', 'Appearance', 'Theme and motion'),
    state.me?.botOwner ? tile('updates', '⬆', 'Updates', 'Check for a new version') : null,
    state.me?.local ? h('a', { class: 'quick plain', href: 'goodboy-app://page/settings' }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, '🖥'), h('span', {}, h('strong', {}, 'Windows app settings'), h('small', {}, 'Bot token, licence, backups, start with Windows'))) : null,
    h('a', { class: 'quick plain', href: '/logout' }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, '↩'), h('span', {}, h('strong', {}, 'Log out'), h('small', {}, `Signed in as ${state.me?.user?.username ?? ''}`))))));
  if (admin) ws.append(testersCard());
  if (state.me?.botOwner) ws.append(signedInCard());
}
/** Arcade and Fishing: the games module's settings, split in two. */
function renderGames(ws, fishing) {
  const m = state.data.modules.find((x) => x.name === 'games');
  if (!m) { ws.append(h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Games are not available.'))); return; }
  const mine = m.settings.filter((s) => /fish/i.test(`${s.key} ${s.label}`) === fishing);
  ws.append(h('div', { class: 'card' }, h('p', { class: 'muted' }, fishing ? 'Fishing: /fish in Discord. 24 places, 2,000 fish, levels up to 4,000.' : 'Blackjack, slots, coin flip and Pong. Members play with the economy coins.'),
    mine.map((s) => settingRow(m, s)),
    h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('strong', {}, 'Everything else'), h('div', { class: 'hint' }, 'Who can use games, where they work, and history.')), h('button', { type: 'button', class: 'ghost', onclick: () => go('module:games') }, 'Open Games'))));
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

// ---------------------------------------------------------------- what's new (3.0.1)
/** A small Markdown reader for release notes: headings in bold, bullet lists, **bold**, `code` and links. Text only, no HTML. */
function mdBlock(text) {
  const inline = (line) => {
    const out = [];
    const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:[^)]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      out.push(m[1] ? h('strong', {}, m[1]) : m[2] ? h('code', {}, m[2]) : h('a', { href: m[4], target: '_blank', rel: 'noopener' }, m[3]));
      last = re.lastIndex;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  const nodes = [];
  let list = null, para = [];
  const flush = () => { if (para.length) { nodes.push(h('p', {}, inline(para.join(' ')))); para = []; } };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*- /.test(line)) { flush(); if (!list) { list = h('ul', {}); nodes.push(list); } list.append(h('li', {}, inline(line.replace(/^\s*- /, '')))); continue; }
    list = null;
    if (!line.trim()) { flush(); continue; }
    const head = /^\*\*(.+)\*\*(?:\s*\((.+)\))?$/.exec(line.trim());
    if (head) { flush(); nodes.push(h('h4', { class: 'wn-h' }, head[1], head[2] ? h('span', { class: 'muted' }, ` (${head[2]})`) : null)); continue; }
    para.push(line.trim());
  }
  flush();
  return nodes;
}
/** The What's new page: pick a version; the note for members first, then everything that changed. */
async function renderWhatsNew(ws) {
  const box = h('div', {}, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading…')));
  ws.append(box);
  let d; try { d = await api('/api/whatsnew'); } catch (e) { put(box, h('div', { class: 'card' }, h('p', { class: 'muted' }, e.message))); return; }
  if (!d.sections.length) { put(box, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'There are no release notes in this copy.'))); return; }
  let pick = d.sections[0].version;
  const draw = () => {
    const s = d.sections.find((x) => x.version === pick);
    put(box,
      h('div', { class: 'gb-seg', role: 'tablist', 'aria-label': 'Version' }, d.sections.map((x) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(x.version === pick), onclick: () => { pick = x.version; draw(); } }, x.version === d.version ? `${x.version} (this one)` : x.version))),
      h('div', { class: 'card glass wn-hero' }, h('div', { class: 'muted' }, `Good Boy ${s.version}`), s.headline ? h('h2', {}, s.headline) : null, s.members ? h('div', { class: 'wn-members' }, mdBlock(s.members)) : null),
      h('div', { class: 'card wn-notes' }, h('h3', {}, 'Everything that changed'), mdBlock(s.notes)));
  };
  draw();
  try { localStorage.setItem('gb-seen-version', d.version); } catch { /* storage blocked */ }
}
/** After an update, a short "What's new" card once, with a button to the full page. */
async function whatsNewOnce() {
  let seen = null; try { seen = localStorage.getItem('gb-seen-version'); } catch { return; }
  let d; try { d = await api('/api/whatsnew'); } catch { return; }
  const s = d.sections.find((x) => x.version === d.version) ?? d.sections[0];
  if (!s || seen === d.version) return;
  try { localStorage.setItem('gb-seen-version', d.version); } catch { /* storage blocked */ }
  if (!seen) return; // first visit ever: nothing is "new" yet
  const scrim = h('div', { class: 'scrim' });
  const close = () => { scrim.classList.add('out'); setTimeout(() => scrim.remove(), 220); };
  scrim.append(h('div', { class: 'card glass sheet-gb wn-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `What's new in ${s.version}` },
    h('div', { class: 'muted' }, `Good Boy updated to ${s.version}`), h('h2', {}, "What's new"), s.headline ? h('p', {}, h('strong', {}, s.headline)) : null,
    s.members ? h('div', { class: 'wn-members' }, mdBlock(s.members)) : null,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost', onclick: close }, 'Close'), h('button', { type: 'button', onclick: () => { close(); if (state.gid) go('whatsnew'); } }, 'See everything'))));
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
}

// ---------------------------------------------------------------- home (the 3.0 design)
function greeting() {
  const hr = new Date().getHours();
  return `${hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'}, ${state.me?.user?.username ?? 'there'}`;
}
function homeSub() {
  const d = state.data, n = state.me?.guilds?.length ?? 1;
  if (d.access !== 'admin') return `${d.guild.name} · your role gives you the tools below.`;
  return `Good Boy is running in ${n} server${n === 1 ? '' : 's'}. Up for ${duration(d.stats.uptimeSeconds)}.`;
}
/** What needs you: modules that still need setting up, tickets waiting, and useful next steps. */
async function attention() {
  const d = state.data, out = [];
  if (d.access !== 'admin') return out;
  for (const m of d.modules) if (needsSetup(m)) out.push({ level: 'warn', title: `${modName(m)} needs setting up`, text: `${essentials(m).filter((x) => !m.values[x.key]).map((x) => x.label).join(', ')}`, action: 'Set up', run: () => setupSheet(m) });
  const sup = d.modules.find((m) => m.name === 'support' && m.enabled);
  if (sup) {
    const t = await api(`/api/guilds/${state.gid}/modules/support/views/tickets`).catch(() => null);
    const open = (t?.rows ?? []).filter((r) => r.status === 'open');
    const waiting = open.filter((r) => r.claimed === '—');
    if (waiting.length) out.push({ level: 'crit', title: `${waiting.length} ticket${waiting.length === 1 ? '' : 's'} nobody has claimed`, text: `${open.length} open in total`, action: 'Open tickets', run: () => go('tool:support') });
  }
  const mm = d.modules.find((m) => m.name === 'member-management' && m.enabled);
  if (mm?.values?.welcomeEnabled && !mm.values.welcomeImage) out.push({ level: 'info', title: 'Welcome messages have no picture', text: 'Add one with /greeting in Discord', action: 'Open', run: () => go('module:member-management') });
  return out;
}
// ---- sparklines under the Home numbers (3.0.1): the bot keeps 14 days of hourly counts
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; }
/** points: numbers (null = no data). Draws a line with a soft fill and a dot at the newest point. */
function sparkline(points, { label = '' } = {}) {
  const W = 200, H = 40, P = 3;
  const vals = points.map((v, i) => [i, v]).filter(([, v]) => v != null);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', role: 'img', 'aria-label': label });
  if (vals.length < 2) { svg.classList.add('empty'); return svg; }
  const ys = vals.map(([, v]) => v); let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  const n = Math.max(1, points.length - 1);
  const xy = vals.map(([i, v]) => [P + (i / n) * (W - 2 * P), H - P - ((v - lo) / (hi - lo)) * (H - 2 * P)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  svg.append(svgEl('path', { d: `${line}L${xy.at(-1)[0].toFixed(1)},${H}L${xy[0][0].toFixed(1)},${H}Z`, class: 'spark-fill' }), svgEl('path', { d: line, class: 'spark-line' }));
  const [ex, ey] = xy.at(-1);
  svg.append(svgEl('circle', { cx: ex.toFixed(1), cy: ey.toFixed(1), r: 2.6, class: 'spark-dot' }));
  return svg;
}
/** Hourly points become one per day so the line is readable: messages add up, voice takes the day's peak, members the day's last count. */
function daily(points, hourMs, from, how = 'sum') {
  const out = new Map();
  points.forEach((v, i) => {
    const day = new Date(from + i * hourMs).toDateString(); const was = out.get(day);
    if (v == null) { if (!out.has(day)) out.set(day, null); return; }
    out.set(day, how === 'sum' ? (was ?? 0) + v : how === 'max' ? Math.max(was ?? 0, v) : v);
  });
  return [...out.values()];
}
async function fillSparklines(cards) {
  let hs;
  try { hs = await api(`/api/guilds/${state.gid}/history`); } catch { return; }
  const days = Math.max(1, Math.round((hs.members.length || 1) / 24));
  for (const card of cards) {
    const key = card.dataset?.series; const slot = card.querySelector('.spark-slot');
    if (!key || !slot) continue;
    const pts = daily(hs[key] ?? [], hs.hourMs, hs.from, key === 'messages' ? 'sum' : key === 'voice' ? 'max' : 'last');
    if (key === 'messages') { const today = pts.at(-1); const strong = card.querySelector('strong'); if (strong && today != null) strong.textContent = String(today); }
    const has = (pts ?? []).filter((v) => v != null).length >= 2;
    slot.replaceChildren(sparkline(pts ?? [], { label: `${card.querySelector('.muted')?.textContent ?? ''}, last ${days} day${days === 1 ? '' : 's'}` }),
      h('small', { class: 'hint' }, has ? `last ${days >= 14 ? '14 days' : `${days} day${days === 1 ? '' : 's'}`}` : 'collecting, check back in a few hours'));
  }
}
function renderHome(ws) {
  const d = state.data;
  if (d.access === 'admin') {
    const on = d.modules.filter((m) => m.enabled);
    const stats = [['Members', d.stats.members ?? '—', 'members', 'members'], ['In voice now', '—', 'inVoice', 'voice'], ['Messages today', '—', null, 'messages'], ['Modules on', `${on.length} / ${d.modules.length}`, null, null]];
    const cards = stats.map(([label, value, key, series]) => h('div', { class: 'card stat', ...(series ? { 'data-series': series } : {}) }, h('div', { class: 'muted' }, label), h('strong', key ? { 'data-stat': key } : {}, value),
      series ? h('div', { class: 'spark-slot' }) : h('small', { class: 'hint' }, `Good Boy v${d.stats.version ?? state.me?.version ?? ''}`)));
    ws.append(h('div', { class: 'stats' }, cards));
    fillSparklines(cards);
  }
  const attnList = h('ul', { class: 'attn' }, h('li', {}, h('i', { class: 'bar info' }), h('div', {}, h('span', {}, 'Checking…'))));
  const left = h('div', { class: 'home-col' });
  const right = h('div', { class: 'home-col' });
  if (d.access === 'admin') left.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Needs attention')), attnList));
  const tools = pages().filter((p) => p.id.startsWith('tool:'));
  if (tools.length) left.append(h('div', { class: 'card' }, h('h3', {}, 'Your tools'), h('div', { class: 'quick-grid' }, tools.map((p) => {
    const m = d.modules.find((x) => x.name === p.id.slice(5));
    return h('button', { class: 'quick plain', 'data-ctx': 'module', 'data-name': p.label, onclick: () => go(p.id) }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, p.icon),
      h('span', {}, h('strong', {}, p.label), h('small', {}, (m.panels ?? []).map((x) => x.title).join(' · '))));
  }))));
  right.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Recent activity'), h('span', { class: 'hint' }, 'updates by itself')), h('ul', { id: 'feed', class: 'feed' })));
  if (state.me?.local) left.append(botControlsCard());
  if (state.me?.botOwner) right.append(signedInCard());
  ws.append(h('div', { class: 'home-grid' }, left, right));
  if (d.access === 'admin') attention().then((items) => put(attnList, items.length ? items.map((x) => h('li', {}, h('i', { class: `bar ${x.level === 'crit' ? 'crit' : x.level === 'info' ? 'info' : ''}` }), h('div', {}, h('b', {}, x.title), h('span', {}, x.text)), h('button', { type: 'button', class: x.level === 'crit' ? '' : 'ghost', onclick: x.run }, x.action)))
    : h('li', {}, h('i', { class: 'bar ok' }), h('div', {}, h('b', {}, 'All good'), h('span', {}, 'Nothing needs you right now.')), h('span')))).catch(() => {});
}
