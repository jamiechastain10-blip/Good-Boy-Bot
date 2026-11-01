/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Event voice hubs: the team logic, with no Discord in it, so it can be tested on its own.
 * An event has a team size (2 for duos, 3 trios, 4 squads...) and a most-teams limit. People can:
 *   - join solo: they fill an open team that has room, or wait in the queue; a full queue becomes a new team
 *   - make a team room: a team with just them, open for solo players to fill
 *   - join with friends: a team with them, where the friends they picked are invited and can accept
 * Every function returns a plain answer and changes the event object it was given.
 */
export const SIZES = [2, 3, 4, 5, 6, 8, 10];

export function newEvent({ id, name, size, maxTeams, by, channelId = null, categoryId = null, now = Date.now() }) {
  if (!SIZES.includes(Number(size))) throw new Error(`Team size must be one of ${SIZES.join(', ')}.`);
  const mt = Number(maxTeams);
  if (!(mt >= 1 && mt <= 50)) throw new Error('Most teams must be 1 to 50.');
  return { id, name: String(name).trim().slice(0, 60) || 'Event', size: Number(size), maxTeams: mt, by, channelId, categoryId, messageId: null, teams: [], queue: [], locked: false, ended: false, createdAt: now, nextN: 1 };
}

const fail = (error) => ({ ok: false, error });
export function placeOf(ev, uid) {
  if (ev.queue.includes(uid)) return { where: 'queue' };
  const team = ev.teams.find((t) => t.members.includes(uid));
  return team ? { where: 'team', team } : null;
}
const canJoin = (ev) => (ev.ended ? 'This event has ended.' : ev.locked ? 'The event is locked: no new players right now.' : null);
const spaceFor = (ev, t) => ev.size - t.members.length - (t.invited?.length ?? 0);

function newTeam(ev, members, { open, invited = [] }) {
  const team = { n: ev.nextN++, members: [...members], invited: [...invited], open, roomId: null };
  ev.teams.push(team);
  return team;
}

/** Fill an open team that has room, or queue; a queue that reaches the team size becomes a team. */
export function joinSolo(ev, uid) {
  const why = canJoin(ev); if (why) return fail(why);
  if (placeOf(ev, uid)) return fail('You are already in this event. Press Leave first to change.');
  const open = ev.teams.filter((t) => t.open && spaceFor(ev, t) > 0).sort((a, b) => spaceFor(ev, a) - spaceFor(ev, b) || a.n - b.n)[0];
  if (open) {
    open.members.push(uid);
    if (spaceFor(ev, open) <= 0) open.open = false;
    return { ok: true, action: 'added', team: open };
  }
  ev.queue.push(uid);
  if (ev.queue.length >= ev.size) {
    if (ev.teams.length >= ev.maxTeams) return { ok: true, action: 'queued', full: true, position: ev.queue.length };
    const members = ev.queue.splice(0, ev.size);
    return { ok: true, action: 'formed', team: newTeam(ev, members, { open: false }) };
  }
  return { ok: true, action: 'queued', position: ev.queue.length, needed: ev.size - ev.queue.length };
}

/** A team with you in it. invited: friends who can accept. open: solo players may fill the rest. */
export function makeTeam(ev, uid, { invited = [], open = true } = {}) {
  const why = canJoin(ev); if (why) return fail(why);
  if (placeOf(ev, uid)) return fail('You are already in this event. Press Leave first to change.');
  if (ev.teams.length >= ev.maxTeams) return fail(`The event is full (${ev.maxTeams} teams).`);
  const friends = [...new Set(invited)].filter((f) => f !== uid);
  if (friends.length > ev.size - 1) return fail(`A team has ${ev.size} players, so pick up to ${ev.size - 1} friends.`);
  const busy = friends.find((f) => placeOf(ev, f));
  if (busy) return fail(`<@${busy}> is already in this event.`);
  return { ok: true, team: newTeam(ev, [uid], { invited: friends, open: open && friends.length < ev.size - 1 }) };
}

export function acceptInvite(ev, n, uid) {
  if (ev.ended) return fail('This event has ended.');
  const t = ev.teams.find((x) => x.n === Number(n));
  if (!t) return fail('That team is gone.');
  if (!t.invited.includes(uid)) return fail('That invite is not for you.');
  const elsewhere = placeOf(ev, uid);
  if (elsewhere) { if (elsewhere.where === 'queue') ev.queue = ev.queue.filter((x) => x !== uid); else return fail('You are already on another team. Press Leave first.'); }
  t.invited = t.invited.filter((x) => x !== uid);
  t.members.push(uid);
  if (spaceFor(ev, t) <= 0) t.open = false;
  return { ok: true, team: t };
}

export function declineInvite(ev, n, uid) {
  const t = ev.teams.find((x) => x.n === Number(n));
  if (!t || !t.invited.includes(uid)) return fail('That invite is not for you.');
  t.invited = t.invited.filter((x) => x !== uid);
  return { ok: true, team: t };
}

/** Leave the queue or your team. A team with nobody left is removed (its room gets deleted). */
export function leave(ev, uid) {
  if (ev.queue.includes(uid)) { ev.queue = ev.queue.filter((x) => x !== uid); return { ok: true, from: 'queue' }; }
  const t = ev.teams.find((x) => x.members.includes(uid));
  if (!t) return fail('You are not in this event.');
  t.members = t.members.filter((x) => x !== uid);
  if (!t.members.length) { ev.teams = ev.teams.filter((x) => x !== t); return { ok: true, from: 'team', team: t, emptied: true }; }
  if (spaceFor(ev, t) > 0) t.open = true;
  return { ok: true, from: 'team', team: t, emptied: false };
}

/** The room of a team was deleted (everyone left): forget the team. */
export function dropTeam(ev, n) {
  const t = ev.teams.find((x) => x.n === Number(n));
  if (t) ev.teams = ev.teams.filter((x) => x !== t);
  return t ?? null;
}

/** After a spot opens (someone left, a team was removed, or the event was unlocked), move waiting players in:
 *  first into open teams with room, then into new teams while the queue has enough people. Returns what changed. */
export function drainQueue(ev) {
  const added = [], formed = [];
  if (ev.ended || ev.locked) return { added, formed };
  for (const t of ev.teams.filter((x) => x.open)) {
    while (ev.queue.length && spaceFor(ev, t) > 0) { const uid = ev.queue.shift(); t.members.push(uid); added.push({ team: t, uid }); }
    if (spaceFor(ev, t) <= 0) t.open = false;
  }
  while (ev.queue.length >= ev.size && ev.teams.length < ev.maxTeams) formed.push(newTeam(ev, ev.queue.splice(0, ev.size), { open: false }));
  return { added, formed };
}

export function summary(ev) {
  const players = ev.teams.reduce((s, t) => s + t.members.length, 0) + ev.queue.length;
  return { teams: ev.teams.length, players, waiting: ev.queue.length, openSpots: ev.teams.filter((t) => t.open).reduce((s, t) => s + spaceFor(ev, t), 0) };
}
