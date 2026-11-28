// Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The Access page (the owner, on the web dashboard): who else may come in, Basic Ghost Labs support on a hosted bot, and
// the access log. And the Support page that Basic Ghost Labs staff see on a support visit. app.js hands over its helpers.
'use strict';
(function () {
  const WHAT = {
    sign_in: 'Signed in', support_sign_in: 'Support visit started', access_add: 'Let someone in', access_remove: 'Removed someone',
    access_support_set: 'Changed support access', bot_start: 'Started the bot', bot_stop: 'Stopped the bot', bot_restart: 'Restarted the bot',
    announce_restart: 'Announced a restart', update_check: 'Checked for updates', health: 'Ran the check-up', support_view: 'Opened the support page',
    module_set: 'Turned a module on or off', setting_set: 'Changed a setting', staff_action: 'Moderation action', ticket_action: 'Ticket action',
    treasury_give: 'Gave money from the treasury', treasury_add: 'Added to the treasury', economy_reset: 'Reset the economy', inactive_kick: 'Kicked inactive members',
    post_panel: 'Posted a panel', permission_set: 'Changed a permission', shop_save: 'Changed the shop', shop_remove: 'Removed a shop item', command_run: 'Ran a command',
    music_api: 'Music control',
  };
  const when = (ms) => { try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(ms); } };
  const ROLE = { owner: 'Owner', support: 'Basic Ghost Labs support', 'let in': 'Let in', 'server manager': 'Server manager', 'ticket staff': 'Ticket staff' };

  function logList(h, lines, names) {
    if (!lines.length) return h('p', { class: 'muted' }, 'Nothing yet.');
    return h('div', { class: 'list' }, lines.map((l) => h('div', { class: 'case' },
      h('span', { class: `dot ${l.ok ? 'on' : 'off'}`, style: { flex: '0 0 auto' } }),
      h('div', { class: 'text' },
        h('b', {}, `${WHAT[l.what] || l.what.replace(/_/g, ' ')}${l.ok ? '' : ' (refused)'}`),
        h('p', { class: 'muted small' }, [l.name || l.who, ROLE[l.role] || l.role, l.guild ? (names[l.guild] || l.guild) : null, when(l.at)].filter(Boolean).join(' · '),
          l.role === 'support' && l.detail ? ` · Reason: ${l.detail}` : '')))));
  }

  /** The owner's page. */
  function page(x) {
    const { h, call, toast, busy } = x;
    const box = h('div', { class: 'stack big' }, h('p', { class: 'muted' }, 'Loading…'));
    async function load() {
      let v, servers = [];
      try { [v, servers] = await Promise.all([call('access_view'), call('servers').catch(() => [])]); } catch (e) { box.replaceChildren(h('div', { class: 'card note warn' }, e.message)); return; }
      const names = Object.fromEntries((servers || []).map((s) => [s.id, s.name]));
      // people
      const rows = v.people.map((p) => h('div', { class: 'case' },
        h('div', { class: 'text' }, h('b', {}, p.name), h('p', { class: 'muted small' }, `${p.user} · ${p.guilds.length ? p.guilds.map((g) => names[g] || g).join(', ') : 'Every server'}`)),
        h('button', { class: 'btn quiet', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await call('access_remove', { user: p.user }); toast(`${p.name} can no longer come in.`); load(); }) }, 'Remove')));
      const id = h('input', { id: 'acc-id', inputmode: 'numeric', autocomplete: 'off', placeholder: '123456789012345678' });
      const nm = h('input', { id: 'acc-name', autocomplete: 'off', placeholder: 'Their name (only for you)' });
      const picks = (servers || []).map((s) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: s.id }), ` ${s.name}`));
      const add = h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
        const guilds = picks.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        await call('access_add', { user: id.value.trim(), name: nm.value.trim(), guilds });
        toast('Done. They can sign in with Discord now.'); load();
      }) }, 'Let them in');
      const people = h('div', { class: 'card' }, h('h2', {}, 'People you let in'),
        h('p', { class: 'muted' }, 'They sign in with Discord and can manage the servers you pick, even without Manage Server. They cannot start or stop the bot, see its token or change this list.'),
        rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted small' }, 'Nobody yet. People with Manage Server in a server can already manage that server.'),
        h('div', { class: 'field' }, h('label', { for: 'acc-id' }, 'Their Discord user ID'), id, h('span', { class: 'hint' }, 'In Discord: Settings, Advanced, turn on Developer Mode. Then right-click them and press Copy User ID.')),
        h('div', { class: 'field' }, h('label', { for: 'acc-name' }, 'Name'), nm),
        picks.length ? h('div', { class: 'field' }, h('span', { class: 'label' }, 'Servers (none ticked means every server)'), h('div', { class: 'stack' }, picks)) : null,
        h('div', { class: 'btns' }, add));
      // support
      const support = v.hosted ? h('div', { class: 'card' }, h('h2', {}, 'Basic Ghost Labs support'),
        h('p', { class: 'muted' }, 'We host this bot for you. When something needs fixing, our support team can come in for up to an hour with a pass made for this bot only.'),
        h('ul', { class: 'small' }, h('li', {}, 'They can see the bot\'s health and check-up, start, stop and restart it, and check for updates.'),
          h('li', {}, 'They cannot see or change your servers, members, messages, tickets or settings, and nobody can see the bot token, client secret or licence key over the web.'),
          h('li', {}, 'Every visit and everything they do is in the access log below.')),
        h('div', { class: 'btns' }, h('span', { class: 'small' }, v.support_on ? 'Support access is on.' : 'Support access is off. We can still start and stop the server itself, but cannot look inside the bot.'),
          h('button', { class: v.support_on ? 'btn quiet' : 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await call('access_support_set', { on: !v.support_on }); toast(v.support_on ? 'Support access is off.' : 'Support access is on.'); load(); }) }, v.support_on ? 'Turn it off' : 'Turn it on'))) : null;
      const log = h('div', { class: 'card' }, h('h2', {}, 'Access log'), h('p', { class: 'muted small' }, 'Sign-ins and every change made on the web dashboard, newest first. It records what kind of thing was done, never what was typed.'), logList(h, v.log, names));
      box.replaceChildren(...[people, support, log].filter(Boolean));
    }
    load();
    return [h('div', { class: 'head' }, h('h1', {}, 'Access'), h('p', { class: 'muted' }, 'Who else can use this dashboard, and what they did.')), box];
  }

  /** What Basic Ghost Labs support sees on a visit. */
  function supportPage(x) {
    const { h, call, toast, busy, bot } = x;
    const box = h('div', { class: 'stack big' }, h('p', { class: 'muted' }, 'Loading…'));
    (async () => {
      let v; try { v = await call('support_view'); } catch (e) { box.replaceChildren(h('div', { class: 'card note warn' }, e.message)); return; }
      const act = (what, label) => h('button', { class: what === 'stop' ? 'btn quiet' : 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, () => bot(what)) }, label);
      box.replaceChildren(
        h('div', { class: 'card note' }, `Signed in as ${v.name} for Basic Ghost Labs support, until ${when(v.until)}. The owner sees everything you do here in their access log.`),
        h('div', { class: 'card' }, h('h2', {}, 'The bot'), h('div', { class: 'btns' }, act('start', 'Start'), act('restart', 'Restart'), act('stop', 'Stop')),
          h('p', { class: 'muted small' }, 'Check-up and Updates are in the menu.')),
        h('div', { class: 'card' }, h('h2', {}, 'What this visit allows'), h('ul', {}, v.can.map((c) => h('li', {}, c))), h('h2', {}, 'What it does not'), h('ul', {}, v.cannot.map((c) => h('li', {}, c)))),
        h('div', { class: 'card' }, h('h2', {}, 'Support visits'), logList(h, v.log, {})));
      void toast;
    })();
    return [h('div', { class: 'head' }, h('h1', {}, 'Support'), h('p', { class: 'muted' }, 'Looking after a bot Basic Ghost Labs hosts, without seeing what is in it.')), box];
  }

  window.GBAccess = { page, supportPage };
})();
