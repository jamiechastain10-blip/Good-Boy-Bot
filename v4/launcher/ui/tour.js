// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The guided tour. Part one walks through the app with a spotlight; part two shows every feature the bot has,
// drawn the way members will see it in Discord, with a button to its settings. Built from fixed text only.
'use strict';
(function () {
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
  const when = 'Today at 4:20 PM';
  const msg = (inner, extra = '') => `<div class="dc"><div class="av"></div><div><div class="who">Good Boy <span class="app">APP</span> <span class="when">${when}</span></div>${inner}</div>${extra}</div>`;
  const box = (c, title, body, buttons = '') => `<div class="box" style="--c:${c}">${title ? `<h4>${title}</h4>` : ''}<div>${body}</div>${buttons ? `<div class="bt">${buttons}</div>` : ''}</div>`;
  const said = (name, text) => `<div class="user">💬 <b>${name}</b> ${text}</div>`;
  const FEATURES = [
    { id: 'community', icon: '⭐', name: 'Levels', what: 'Members earn XP for chatting and level up. Level-ups are announced, and you can give a role at each level.', cmds: ['/rank', '/leaderboard'],
      demo: msg(box('#57f287', 'Kai reached level 12', '<span class="mention">@Kai</span> is now level <b>12</b> · rank #4<br><span class="bar">▰▰▰▱▱▱▱▱▱▱</span> 180 of 1,000 XP to level 13', '<span>View rank</span>')) },
    { id: 'economy', icon: '🪙', name: 'Money', what: 'Coins for each server: a daily reward that grows with a streak, jobs, paying each other and a rich list.', cmds: ['/money daily', '/money work', '/money pay', '/money top'],
      demo: msg(box('#f2b33d', 'Daily reward', 'Day 4 streak 🔥<br>You got <b>288</b> 🪙 · wallet <b>2,140</b> 🪙', '<span class="g">Work</span><span>Rich list</span>')) },
    { id: 'moderation', icon: '🛡️', name: 'Moderation', what: 'Warn, time out, kick and ban, for good or for a while. Every action is a numbered case in the member\'s history, and your own strike ladder decides what happens next.', cmds: ['/warn', '/timeout', '/ban', '/strikes', '/unwarn', '/modhistory', '/purge'],
      demo: msg(box('#ed4245', 'Warn · case #41', '<b>User</b> Kai · <b>Moderator</b> <span class="mention">@Mo</span><br><b>Reason</b> Spamming invites<br>2 strike(s) · next: 1 week timeout at 4<br>Reached 2 strikes - timed out for 1 day.')) },
    { id: 'automod', icon: '🤖', name: 'AutoMod', what: 'Removes scam links straight away, and (when you switch them on) spam, banned words, links, mass mentions, repeats, shouting and emoji walls. Moderators are never checked.', cmds: ['/automod status', '/automod rule', '/automod exempt'],
      demo: said('Kai', 'free nitro https://dlscord-gift.ru/claim') + msg(box('#ed4245', '', '<span class="mention">@Kai</span>, that link looks like a scam, so it was removed. If your account was hacked, change your password and turn on two-factor login.', '')) },
    { id: 'logs', icon: '📜', name: 'Server logs', what: 'Deleted and edited messages, joins and leaves, role and nickname changes, and voice, in the log channels you pick.', cmds: ['/logs setup', '/logs off'],
      demo: msg(box('#ed4245', 'Message deleted', 'In <span class="mention">#general</span> by <span class="mention">@Kai</span> · sent 2 minutes ago<br>the original words<br><span class="sub">Author ID 9000… · message ID 7000…</span>')) },
    { id: 'member-management', icon: '👋', name: 'Welcome', what: 'Welcome and goodbye messages with your own wording, and a waiting role for new members until they verify.', cmds: [],
      demo: msg(box('#5865f2', '', 'Welcome <span class="mention">@Rowan</span> to <b>Ghost Town</b>! You are member #1,204.')) },
    { id: 'roles', icon: '🎨', name: 'Role menus', what: 'Members pick their own roles from buttons or a list. Limit how many, who can use it, and how long roles last. Also reaction roles and roles given on join.', cmds: ['/rolemenu create', '/reactionrole add', '/autorole add'],
      demo: msg(box('#4cc3ff', 'Pick your colour', '🔴 <span class="mention">@Red</span><br>🔵 <span class="mention">@Blue</span><br>🟢 <span class="mention">@Green</span><br><span class="sub">Pick one. Choosing another swaps it.</span>', '<span>🔴 Red</span><span>🔵 Blue</span><span>🟢 Green</span>')) },
    { id: 'support', icon: '🎫', name: 'Tickets', what: 'A panel of buttons, a short form, and a private channel for the member and your staff. Claim, close with notes, reopen, and close quiet tickets by themselves.', cmds: ['/ticket setup', '/ticket panel', '/ticket close'],
      demo: msg(box('#5865f2', 'Need help?', 'Press the button that fits your problem. A private channel opens for you and our staff.', '<span class="r">🚨 Scam or hacked</span><span class="p">📣 Report a member</span><span>🛠️ Bot problem</span><span>❓ Question</span>')) },
    { id: 'reminders', icon: '⏰', name: 'Reminders', what: 'Private reminders by DM, and team reminders that notify roles in a channel, once or every day or week.', cmds: ['/remind me', '/remind team', '/remind list'],
      demo: msg(box('#5865f2', '', '⏰ <b>Reminder</b><br><span class="mention">@Raid team</span><br><br>Raid night starts in 30 minutes!')) },
    { id: 'giveaways', icon: '🎉', name: 'Giveaways', what: 'A card with an Enter button, winners drawn fairly when time is up, rerolls, and coin prizes paid by themselves.', cmds: ['/giveaway start', '/giveaway end', '/giveaway reroll'],
      demo: msg(box('#f2b33d', '🎉 5,000 coins', 'Press <b>Enter</b> to join. Ends in 2 hours.<br>Hosted by <span class="mention">@Ada</span> · 1 winner<br>🪙 Coins are paid to the winner automatically.<br><span class="sub">Giveaway #3 · 41 entries</span>', '<span class="g">🎉 Enter</span>')) },
    { id: 'tags', icon: '📝', name: 'Custom commands', what: 'Your own commands like ?rules, and replies when someone says a phrase. Replies can pick at random, use what was typed, and choose between answers.', cmds: ['/tags add', '/tags list'],
      demo: said('Rowan', '?rules') + msg(box('#5865f2', '', 'Be kind, Rowan. Read <span class="mention">#rules</span> before posting.')) },
    { id: 'counting', icon: '🔢', name: 'Counting', what: 'A counting channel and a word chain, with records and top players.', cmds: ['/counting here', '/counting words-here', '/counting stats'],
      demo: said('Kai', '41 <span class="rx">✅ 1</span>') + said('Rowan', '42 <span class="rx">✅ 1</span>') + said('Kai', '43 <span class="rx">❌ 1</span>') + msg(box('#ed4245', '', '💥 <span class="mention">@Kai</span> broke the count at <b>42</b>: you can\'t count twice in a row. Start again from <b>1</b>!')) },
    { id: 'fun', icon: '🎲', name: 'Fun', what: 'The magic 8-ball, dice, shipping two members, and conversation topics for quiet chats.', cmds: ['/fun 8ball', '/fun dice', '/fun ship', '/fun topic'],
      demo: msg(box('#57f287', '💘 Kai × Rowan', 'Ship name: <b>Kawan</b><br><span class="bar">▰▰▰▰▰▰▰▰▰▰▱▱▱▱</span> <b>71%</b><br>Made for each other 💕')) },
    { id: 'music', icon: '🎵', name: 'Music', what: 'A player with buttons in a voice channel: a queue, repeat, shuffle, volume, the server\'s playlists and the words to the song. Links to audio files and your radio stations always work. YouTube and similar sites only work once the bot\'s owner turns on media links, because those sites\' rules forbid it.', cmds: ['/music player', '/music play', '/music queue', '/music lyrics', '/music playlists'],
      demo: msg(box('#eb459e', '🎵 Now playing', '<b>Midnight Drive</b> · Lo-Fi Ghost<br><span class="bar">▰▰▰▰▰▱▱▱▱▱▱▱▱▱</span> 1:12 / 3:07<br>Added by <span class="mention">@Kai</span><br><b>Up next</b><br>1. <b>Rain on Glass</b> · Lo-Fi Ghost<br><span class="sub">🔊 70% · Repeat off · 1 in queue</span>', '<span>⏮️</span><span class="p">⏸️ Pause</span><span>⏭️</span><span class="r">⏹️</span><span class="g">➕ Add</span><span>🎤 Lyrics</span>')) },
    { id: 'soon', icon: '🚧', name: 'Coming next', what: 'Still being rebuilt for the new Good Boy: games in a pixel-art style, the clipper, economy upgrades, battles and more. Their settings and data from Good Boy 3 are kept until they arrive.', cmds: [],
      demo: '<div class="note">Everything you set up in Good Boy 3 is kept, and each part switches on here as it is rebuilt.</div>' },
  ];
  // Escape closes whatever part of the tour is open
  addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.tour-spot,.tour-tip,.show,.tour-offer').forEach((x) => x.remove()); });
  const APP_STEPS = [
    { page: 'home', target: '.nav[aria-current="page"]', title: 'Home', text: 'Everything starts here: whether your bot is online, and the button to start or stop it.' },
    { page: 'home', target: '.main .card', title: 'Your bot at a glance', text: 'The light is green when the bot is online. Restart and Stop are right beside it. If something is wrong, it says what to do here.' },
    { page: 'servers', target: '.main .row', title: 'Modules', text: 'Pick a server. Everything below changes for that server only.' },
    { page: 'servers', target: '.main .card .btns.mid', title: 'Switch a module on or off', text: 'The switch turns a module on or off in this server, straight away. Settings opens everything you can change.' },
    { page: 'bot', target: '.main .card', title: 'Settings', text: 'Your bot\'s token and client secret live here. Replace them when you reset them on Discord; they are kept by Windows and never shown again.' },
    { page: 'help', target: '#find', title: 'Help', text: 'Stuck? Search the guide. Every module has a page, with the exact steps.' },
  ];

  let go = () => {}, openModule = () => {}, onEnd = () => {};
  /** host: { go(page), openModule(id), done() } from the app. */
  function attach(host) { go = host.go; openModule = host.openModule; onEnd = host.done || onEnd; }
  function offer() {
    const card = el(`<div class="tour-offer" role="dialog" aria-label="Tour"><div class="hd"><img src="mascot.png" alt=""><div><h3>New here?</h3><p class="small muted">A two-minute look around, or see everything the bot can do.</p></div></div>
      <div class="btns"><button class="btn" type="button" data-a="app">Show me around</button><button class="btn quiet" type="button" data-a="show">What can Good Boy do?</button><button class="btn quiet" type="button" data-a="no">Not now</button></div></div>`);
    card.addEventListener('click', (e) => { const a = e.target.dataset.a; if (!a) return; card.remove(); onEnd(); if (a === 'app') app(0); if (a === 'show') showcase(0); });
    document.body.append(card);
  }
  function app(k) {
    document.querySelectorAll('.tour-spot,.tour-tip').forEach((x) => x.remove());
    if (k >= APP_STEPS.length) return showcase(0, true);
    const s = APP_STEPS[k];
    go(s.page);
    setTimeout(() => {
      const t = document.querySelector(s.target);
      if (!t) return app(k + 1);
      const r = t.getBoundingClientRect(), pad = 6;
      const spot = el('<div class="tour-spot"></div>');
      Object.assign(spot.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      const tip = el(`<div class="tour-tip" role="dialog"><div class="n">Step ${k + 1} of ${APP_STEPS.length}</div><h3>${s.title}</h3><p class="small muted">${s.text}</p>
        <div class="row"><div class="tour-dots">${APP_STEPS.map((_, i) => `<i class="${i === k ? 'on' : ''}"></i>`).join('')}</div><div class="btns"><button class="btn quiet" type="button" data-a="skip">Skip</button>${k ? '<button class="btn quiet" type="button" data-a="back">Back</button>' : ''}<button class="btn" type="button" data-a="next">${k === APP_STEPS.length - 1 ? 'See what it can do' : 'Next'}</button></div></div></div>`);
      document.body.append(spot, tip);
      const below = r.bottom + 16 + 190 < innerHeight;
      tip.style.top = `${below ? r.bottom + 16 : Math.max(16, r.top - tip.offsetHeight - 16)}px`;
      tip.style.left = `${Math.min(Math.max(16, r.left), innerWidth - tip.offsetWidth - 16)}px`;
      tip.addEventListener('click', (e) => { const a = e.target.dataset.a; if (a === 'skip') { spot.remove(); tip.remove(); } if (a === 'back') app(k - 1); if (a === 'next') app(k + 1); });
    }, 120);
  }
  function showcase(k, fromTour) {
    document.querySelectorAll('.show').forEach((x) => x.remove());
    const f = FEATURES[k];
    const sheet = el(`<div class="show" role="dialog" aria-label="What Good Boy can do"><div class="sheet">
      <nav><h3>What Good Boy can do</h3>${FEATURES.map((x, i) => `<button type="button" data-i="${i}" aria-current="${i === k}"><span>${x.icon}</span>${x.name}</button>`).join('')}</nav>
      <div class="body"><div class="top"><div class="head"><h1>${f.icon} ${f.name}</h1><p class="muted">${f.what}</p></div><button class="btn quiet" type="button" data-a="close">Close</button></div>
        ${f.cmds.length ? `<div class="chips">${f.cmds.map((c) => `<code>${c}</code>`).join('')}</div>` : ''}
        <div class="stack"><span class="small muted">What members see in Discord</span>${f.demo}</div>
        <div class="foot"><span class="count">${k + 1} of ${FEATURES.length}</span><div class="btns">${f.id !== 'soon' ? '<button class="btn quiet" type="button" data-a="open">Open its settings</button>' : ''}${k ? '<button class="btn quiet" type="button" data-a="prev">Back</button>' : ''}<button class="btn" type="button" data-a="${k === FEATURES.length - 1 ? 'close' : 'next'}">${k === FEATURES.length - 1 ? 'Done' : 'Next'}</button></div></div></div></div></div>`);
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) return sheet.remove();
      const i = e.target.closest('[data-i]')?.dataset.i;
      if (i != null) return showcase(Number(i));
      const a = e.target.dataset.a;
      if (a === 'close') sheet.remove();
      if (a === 'next') showcase(k + 1);
      if (a === 'prev') showcase(k - 1);
      if (a === 'open') { sheet.remove(); openModule(f.id === 'automod' || f.id === 'logs' ? 'moderation' : f.id); }
    });
    document.body.append(sheet);
  }
  window.GBTour = { attach, offer, app, showcase };
})();
