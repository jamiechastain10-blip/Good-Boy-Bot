/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Terms of Service and Privacy Policy pages, suitable as the URLs in the Discord Developer Portal.
 * Good Boy is self-hosted, so the person who runs a bot is the one who holds the data. The text below describes what
 * the software itself stores and sends (checked against the modules); the operator's name and contact come from the
 * environment, and either page can be replaced entirely by a file in data/legal/ (terms.txt, privacy.txt).
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEGAL_REVISION = '2026-10-29';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Operator details from the environment. Nothing is invented: a missing contact is stated as missing. */
export function legalContext(env = process.env) {
  const clean = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
  return { operator: clean(env.LEGAL_OPERATOR, 120) || 'the person who runs this bot', contact: clean(env.LEGAL_CONTACT, 200), revision: clean(env.LEGAL_REVISION, 20) || LEGAL_REVISION };
}

const contactLine = (c) => (c.contact ? `Contact: ${c.contact}.` : 'The operator has not published a contact address yet. Ask in the Discord server where you found this bot.');

function terms(c) {
  return [
    ['Good Boy Terms of Service', [`Good Boy is a Discord bot made by Basic Ghost Labs and run by ${c.operator} (the "operator"). By using it in a Discord server you agree to these terms and to Discord's own Terms of Service and Community Guidelines.`]],
    ['Using the bot', ['Use it lawfully and in line with Discord\'s rules. Do not try to break, overload or probe the bot, get around its permission checks, or use it to harass people.', 'Server staff decide which features are on and who may use them. The operator and server staff may refuse service, remove data they are responsible for, or remove the bot from a server.']],
    ['Moderation and records', ['Moderation tools keep records (warnings, timeouts, tickets, notes) so staff can do their job. Staff-only records, such as the ticket watch log, are not shown to the members they concern. A report in that log is an accusation, not proof, and entries are removed after the retention periods set by the server.']],
    ['No warranty', ['The bot is provided as is. Features can be unavailable, delayed or wrong, and the operator\'s computer must be on and online for the bot to work. To the extent the law allows, neither Basic Ghost Labs nor the operator is liable for losses from using it.']],
    ['Changes and contact', ['These terms may change; the revision date below shows the current version.', contactLine(c), `Revision: ${c.revision}.`]],
  ];
}

function privacy(c) {
  return [
    ['Good Boy Privacy Policy', [`Good Boy is self-hosted. The data described here is stored on the computer of ${c.operator}, who decides what happens to it. Basic Ghost Labs, which makes the software, does not receive this data. This page describes what the software itself does.`]],
    ['What is stored', [
      'Server settings: which features are on, their options and which roles may use them.',
      'Member activity, only for features a server turns on: message counts and experience points, reputation and its history, birthdays you set yourself, AFK notes, reminders you create, suggestion and poll votes, notification choices, and voice preferences.',
      'Support: ticket details you typed, the staff who handled it, how it was closed, and a transcript of the ticket channel. Staff also keep private notes, and a staff-only watch log of reports about members.',
      'Moderation: warnings, timeouts, kicks and bans with the reason and moderator. AutoMod keeps up to 200 recent actions, each with a preview of at most 80 characters of the removed message (a server can turn the preview off).',
      'Message logs, if a server keeps them on: a copy of each message (its text and attachment names) for up to 7 days, only so the log can show what a message said after it is edited or deleted. Turning message logging off keeps nothing new.',
      'Eclipse ID and statistics, if a server enables them: the profile details you choose to share, achievements, and activity totals. These are counts; message text is not kept for statistics.',
      'Technical logs: errors, and changes to settings and permissions, without passwords or tokens.',
    ]],
    ['What is not stored', ['Message text in general is not stored. It is read to run features (commands, AutoMod, XP) and discarded, except where a feature exists to keep it: tickets, suggestions, announcements and reminders you write, the AutoMod preview, and the 7-day message log copy above.', 'The dashboard never stores your Discord login token: it is used once to learn who you are and which servers you can manage, and revoked straight away.']],
    ['Who else receives data', [
      'Discord, which delivers everything the bot sends and receives.',
      'Text-to-speech: when the voice feature reads text aloud, that text can be sent to Google\'s text-to-speech service to produce audio, unless the operator uses offline voices.',
      'Feeds and links: features that follow RSS, YouTube, GitHub, Reddit or Minecraft servers request those public addresses, which see the operator\'s IP address.',
      'Game accounts: if you link a game account, the name you give may be looked up with that game\'s public service.',
    ]],
    ['How long it is kept', ['Server data is kept until staff or the operator delete it. If the bot is removed from a server, its data is kept in case it is re-added, and can be deleted on request. The ticket watch log expires after 365 days, and entries found unfounded after 30 days, unless the server changes those periods.']],
    ['Your choices', ['You can turn off optional notifications with /notifications, remove your birthday, AFK note, custom profile role, reminders and Eclipse ID details yourself, and ask the operator to delete or export what is stored about you. Staff-only moderation records may be kept where needed to keep a server safe.']],
    ['Children', ['Discord requires users to be at least 13 (or the minimum age in their country). The bot does not knowingly collect data from anyone under that age.']],
    ['Contact and changes', [contactLine(c), `Revision: ${c.revision}. The current version of this page is always the one shown at this address.`]],
  ];
}

/** Plain-text override: first line is the title, blank lines separate paragraphs, lines starting with "## " are headings. */
function fromText(text) {
  const out = []; let cur = null;
  for (const block of String(text).replace(/\r/g, '').split(/\n{2,}/)) {
    const t = block.trim(); if (!t) continue;
    if (t.startsWith('## ')) { cur = [t.slice(3).split('\n')[0], t.split('\n').slice(1).join(' ').trim() ? [t.split('\n').slice(1).join(' ').trim()] : []]; out.push(cur); }
    else if (!cur) { cur = [t.split('\n')[0], t.split('\n').slice(1).join(' ').trim() ? [t.split('\n').slice(1).join(' ').trim()] : []]; out.push(cur); }
    else cur[1].push(t.replace(/\n/g, ' '));
  }
  return out;
}

export function legalSections(kind, { dataDir, env = process.env } = {}) {
  const c = legalContext(env);
  const file = dataDir ? path.join(dataDir, 'legal', `${kind}.txt`) : null;
  if (file) { try { const t = fs.readFileSync(file, 'utf8'); if (t.trim()) return { custom: true, sections: fromText(t.slice(0, 60000)) }; } catch { /* no override file */ } }
  return { custom: false, sections: kind === 'terms' ? terms(c) : privacy(c) };
}

export function renderLegal(kind, opts = {}) {
  const { sections, custom } = legalSections(kind, opts);
  const [title, ...rest] = sections;
  const body = [`<h1>${esc(title[0])}</h1>`, ...title[1].map((p) => `<p>${esc(p)}</p>`),
    ...rest.flatMap(([h, ps]) => [`<h2>${esc(h)}</h2>`, ...(ps.length > 1 && !ps.some((p) => p.length > 160) ? [`<ul>${ps.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`] : ps.map((p) => `<p>${esc(p)}</p>`))])].join('\n');
  const other = kind === 'terms' ? ['/privacy', 'Privacy Policy'] : ['/terms', 'Terms of Service'];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#071329">
<title>${esc(title[0])}</title><link rel="icon" href="/good-boy-logo.png"><link rel="stylesheet" href="/glass.css"><link rel="stylesheet" href="/style.css"></head>
<body><div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
<header class="topbar glass"><a class="brand" href="/" aria-label="Good Boy home"><img src="/good-boy-logo.png" alt=""><span><strong>Good Boy</strong><small>${esc(title[0])}</small></span></a><span id="who"><a href="${other[0]}">${other[1]}</a></span></header>
<main class="legal"><article class="card glass">${body}${custom ? '' : ''}</article></main></body></html>`;
}
