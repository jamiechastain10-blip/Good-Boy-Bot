// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Answers from Good Boy 3's own rule functions, for the v4 tests to compare against.
//   node rules-3x.mjs <file holding json: { daily: [[streak, lastDaily, shields, best, base, now], ...], amounts: [[text, have, min, max], ...] }>
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
// on Windows an absolute path must be given to import() as a file:// address
const load = (file) => import(pathToFileURL(file).href);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const E = await load(path.join(root, 'src/economy.js'));
// the questions are read from a file: there can be thousands, more than a Windows command line holds
const ask = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = {};
if (ask.daily) out.daily = ask.daily.map(([streak, lastDaily, shields, bestStreak, base, now]) => E.claimDaily({ streak, lastDaily, shields, bestStreak }, base, now));
if (ask.amounts) out.amounts = ask.amounts.map(([text, have, min, max]) => E.parseAmount(text, { have, min, max }));
if (ask.numbers || ask.counts || ask.words) {
  const C = await load(path.join(root, 'modules/counting/index.js'));
  if (ask.numbers) out.numbers = ask.numbers.map((t) => C.readNumber(t));
  // each answer is 'skip', 'ok' or the reason it was wrong
  const say = (r) => (r.skip ? 'skip' : r.ok ? 'ok' : r.why);
  if (ask.counts) out.counts = ask.counts.map(([n, last, user, text, one]) => say(C.checkCount({ n, last }, user, text, { oneAtATime: one })));
  if (ask.words) out.words = ask.words.map(([word, lastUser, used, user, text, one]) => say(C.checkWord({ word, lastUser, used }, user, text, { oneAtATime: one })));
}
if (ask.ships) {
  const M = await load(path.join(root, 'src/minigames.js'));
  out.ships = ask.ships.map(([a, b]) => [M.shipPercent(a, b), M.shipName(a, b)]);
  out.lists = [M.EIGHT_BALL, M.TOPICS];
}
if (ask.durations || ask.whens) {
  const U = await load(path.join(root, 'src/util.js'));
  if (ask.durations) out.durations = ask.durations.map((t) => U.parseDuration(t));
  // dates only: a delay depends on the clock at the moment it is asked
  if (ask.whens) out.whens = ask.whens.map(([t, offset]) => { try { return U.parseWhen(t, offset); } catch { return null; } });
}
if (ask.steps) {
  const Mod = await load(path.join(root, 'modules/moderation/index.js'));
  out.steps = ask.steps.map(([warns, timeoutEvery, kickAt, banAt]) => Mod.warnStep(warns, { timeoutEvery, kickAt, banAt }));
}
if (ask.scripts) {
  const T = await load(path.join(root, 'src/tagscript.js'));
  // every "random" pick is the first choice and every number the lowest, so the answers can be compared
  out.scripts = ask.scripts.map(([tpl, args, vars]) => T.runTagScript(tpl, { ...vars, ...T.argVars(args) }, () => 0));
}
if (ask.matches) {
  const Tags = await load(path.join(root, 'modules/tags/index.js'));
  out.matches = ask.matches.map(([text, list, prefixes]) => { const m = Tags.matchMessage(text, list, prefixes); return m ? [m.cmd.name, m.args] : null; });
}
if (ask.automod) {
  const A = await load(path.join(root, 'src/automod.js'));
  const U = await load(path.join(root, 'src/util.js'));
  const a = ask.automod;
  // the word filter and allowed links, written the way the moderation module writes them
  const wordRe = (words) => (words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(U.escapeRegex).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null);
  const domainAllowed = (host, allowed) => { host = host.toLowerCase(); return allowed.some((x) => { x = x.toLowerCase().replace(/^www\./, ''); return host === x || host.endsWith('.' + x); }); };
  const blocked = (text, allowed) => {
    const bad = [...String(text).matchAll(/\b(?:https?:\/\/|www\.)([^\s/?#<>]+)/gi)].map((m) => m[1]).find((d) => !domainAllowed(d, allowed));
    if (bad) return bad;
    return /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/\w+/i.test(text) && !domainAllowed('discord.gg', allowed) ? 'a server invite' : null;
  };
  out.automod = {
    emoji: a.texts.map((t) => A.countEmoji(t)),
    caps: a.texts.map((t) => A.capsRatio(t, { minLetters: 12 })),
    normal: a.texts.map((t) => A.normalizeText(t)),
    snippet: a.texts.map((t) => A.snippet(t, 20)),
    hosts: a.texts.map((t) => A.linkHosts(t)),
    scam: a.texts.map((t) => A.scamReason(t)),
    fake: a.sites.map((h) => A.fakeSite(h)),
    words: a.words.map(([t, list]) => { const re = wordRe(list); return re ? (String(t).match(re) ?? [null])[0] : null; }),
    links: a.links.map(([t, allowed]) => blocked(t, allowed)),
    exempt: a.exempt.map(([ex, rule, where]) => A.isExempt(ex, rule, where)),
    edits: a.edits.map(([ex, rule, kind, id, add]) => A.editExempt(ex, rule, kind, id, add)),
  };
}
if (ask.tickets) {
  const T = await load(path.join(root, 'src/tickets.js'));
  const SUP = await load(path.join(root, 'modules/support/index.js'));
  const k = ask.tickets;
  const tryIt = (fn) => { try { return { ok: fn() }; } catch (e) { return { err: e.message }; } };
  out.tickets = {
    names: k.names.map((n) => T.normalizeName(n)),
    parsed: k.parsed.map(([u, id, req]) => tryIt(() => T.parseReported({ username: u, userid: id }, { required: req }))),
    from: k.from.map(([who, outside, req]) => tryIt(() => T.reportedFrom({ who, outside }, { required: req }))),
    ages: k.ages.map(([ms, now]) => T.ageText(ms, now)),
    ids: k.texts.map((t) => [...T.idsIn(t)]),
    matches: k.matches.map((m) => T.matchWatch(m, k.entries).map((x) => [x.entry.id, x.how, x.exact])),
    described: k.matches.map((m) => { const ms = T.matchWatch(m, k.entries); return ms.length ? T.describeMatches(ms, k.entries) : null; }),
    close: k.close.map((v) => tryIt(() => T.readCloseForm((id) => v[id]))),
    summary: T.summarize(k.history, k.now, 30),
    questions: T.CATEGORIES.concat([T.findCategory('own', k.custom)]).map((c) => T.questionsFor(c).map((q) => [q.id, q.kind ?? 'text', q.label, q.desc ?? null, !!q.required, q.max ?? null, q.placeholder ?? null])),
    ratings: SUP.ratingSummary(k.ratings, k.now, 30),
  };
}
if (ask.transcripts) {
  const SUP = await load(path.join(root, 'modules/support/index.js'));
  let html = null;
  const ADD = await load(path.join(root, 'modules/support-html-transcripts/index.js'));
  await ADD.default.init({ hostApi: { registerTranscriptFormat: (n, fn) => { html = fn; } } });
  const k = ask.transcripts;
  const messages = k.messages.map((m) => ({ createdTimestamp: m.at, author: { tag: m.tag, displayAvatarURL: () => m.avatar ?? '' }, cleanContent: m.content,
    attachments: new Map(m.files.map(([n, u], i) => [String(i), { name: n, url: u }])), embeds: m.boxes.map((b) => ({ data: { description: b } })) }));
  const args = { ticket: k.ticket, messages, guild: { name: k.guild }, summary: k.summary, embedText: SUP.embedText };
  out.transcripts = { txt: SUP.default.api.formats.get('txt').fn(args), html: html(args) };
}
console.log(JSON.stringify(out));
