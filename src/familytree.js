/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Families (3.1): the rules (who can marry or adopt whom), the shape of a family tree, and drawing it as a picture or
 * as text. Plain functions over a small graph so they are tested without Discord.
 *
 * The graph: partners (married pairs, both ways) and parent -> child links (a child has at most one parent, the one who
 * adopted them; that parent's partner shows as the other parent on the tree).
 */
import { canvasLib } from './gameart.js';

/** g = { partners: Map<id, Set<id>>, parentOf: Map<child, parent>, childrenOf: Map<parent, Set<child>> } */
export function buildGraph(partnerRows, childRows) {
  const partners = new Map(), parentOf = new Map(), childrenOf = new Map();
  const add = (m, k, v) => (m.get(k) ?? m.set(k, new Set()).get(k)).add(v);
  for (const r of partnerRows) { add(partners, r.a, r.b); add(partners, r.b, r.a); }
  for (const r of childRows) { parentOf.set(r.child, r.parent); add(childrenOf, r.parent, r.child); }
  return { partners, parentOf, childrenOf };
}
const partnersOf = (g, id) => [...(g.partners.get(id) ?? [])];
const kidsOf = (g, id) => [...(g.childrenOf.get(id) ?? [])];

/** Everyone connected to id by marriage or parenthood (the whole family). */
export function familyOf(g, id, limit = 500) {
  const seen = new Set([id]), queue = [id];
  while (queue.length && seen.size < limit) {
    const x = queue.shift();
    const next = [...partnersOf(g, x), ...kidsOf(g, x), g.parentOf.get(x)].filter(Boolean);
    for (const y of next) if (!seen.has(y)) { seen.add(y); queue.push(y); }
  }
  return seen;
}

/** Why a and b can't marry, or null. maxPartners: how many partners one person may have. */
export function marryProblem(g, a, b, { maxPartners = 1 } = {}) {
  if (a === b) return "You can't marry yourself.";
  if (g.partners.get(a)?.has(b)) return "You're already married to them.";
  if ((g.partners.get(a)?.size ?? 0) >= maxPartners) return maxPartners === 1 ? "You're already married. Divorce first with `/family divorce`." : `You already have ${maxPartners} partners, the most this server allows.`;
  if ((g.partners.get(b)?.size ?? 0) >= maxPartners) return maxPartners === 1 ? "They're already married." : `They already have ${maxPartners} partners.`;
  if (familyOf(g, a).has(b)) return "You're already in the same family, so you can't marry them.";
  return null;
}
/** Why parent can't adopt child, or null. */
export function adoptProblem(g, parent, child, { maxChildren = 10 } = {}) {
  if (parent === child) return "You can't adopt yourself.";
  if (g.parentOf.get(child) === parent) return "They're already your child.";
  if (g.parentOf.has(child)) return 'They already have a parent. They can leave that family with `/family leave` first.';
  if ((g.childrenOf.get(parent)?.size ?? 0) >= maxChildren) return `You already have ${maxChildren} children, the most this server allows.`;
  if (familyOf(g, parent).has(child)) return "They're already in your family.";
  return null;
}

/** The top of id's family line: go up through parents (and a partner's parents) as far as possible. */
export function rootOf(g, id) {
  let cur = id; const seen = new Set();
  for (;;) {
    seen.add(cur);
    const up = g.parentOf.get(cur) ?? partnersOf(g, cur).map((p) => g.parentOf.get(p)).find(Boolean);
    if (!up || seen.has(up)) return cur;
    cur = up;
  }
}

/**
 * The tree as nested units: { people: [id, ...partners], children: [unit...] }. Each person appears once.
 * maxNodes stops very large families from producing a giant picture.
 */
export function treeFrom(g, root, { maxNodes = 80 } = {}) {
  const placed = new Set();
  const unit = (id, depth) => {
    if (placed.has(id) || placed.size >= maxNodes || depth > 12) return null;
    const people = [id, ...partnersOf(g, id).filter((p) => !placed.has(p))];
    people.forEach((p) => placed.add(p));
    const kids = [...new Set(people.flatMap((p) => kidsOf(g, p)))];
    return { people, children: kids.map((k) => unit(k, depth + 1)).filter(Boolean) };
  };
  return unit(root, 0);
}
export const countPeople = (u) => (u ? u.people.length + u.children.reduce((a, c) => a + countPeople(c), 0) : 0);

/** The tree as text, for when pictures can't be drawn or the family is too big. name(id) gives a display name. */
export function treeText(u, name, { highlight = null } = {}) {
  const lines = [];
  const label = (ids) => ids.map((id) => (id === highlight ? `**${name(id)}**` : name(id))).join(' ❤️ ');
  const walk = (node, prefix, last, top) => {
    lines.push(top ? `👑 ${label(node.people)}` : `${prefix}${last ? '└' : '├'} ${label(node.people)}`);
    const next = top ? '' : `${prefix}${last ? '  ' : '│ '}`;
    node.children.forEach((c, k) => walk(c, next, k === node.children.length - 1, false));
  };
  if (u) walk(u, '', true, true);
  return lines.join('\n');
}

// ------------------------------------------------------------------ the picture
const NODE_W = 150, NODE_H = 52, GAP_X = 18, GAP_Y = 58, HEART = 22;
const unitWidth = (u) => u.people.length * NODE_W + (u.people.length - 1) * HEART;
function measure(u) {
  const kids = u.children.map(measure);
  const kidsW = kids.reduce((a, w) => a + w, 0) + Math.max(0, kids.length - 1) * GAP_X;
  u._w = Math.max(unitWidth(u), kidsW);
  return u._w;
}
function place(u, x, y) {
  u._x = x + (u._w - unitWidth(u)) / 2; u._y = y;
  let cx = x + (u._w - (u.children.reduce((a, c) => a + c._w, 0) + Math.max(0, u.children.length - 1) * GAP_X)) / 2;
  for (const c of u.children) { place(c, cx, y + NODE_H + GAP_Y); cx += c._w + GAP_X; }
}
const depthOf = (u) => 1 + Math.max(0, ...u.children.map(depthOf));

/**
 * Draws the tree. people: Map<id, { name, avatarUrl }>. Returns a PNG Buffer, or null when the canvas package is
 * missing (use treeText instead).
 */
export async function treeImage(u, people, { highlight = null, title = 'Family tree', fetchFn = globalThis.fetch } = {}) {
  const L = await canvasLib(); if (!L || !u) return null;
  measure(u); place(u, 30, 70);
  const W = Math.max(420, Math.ceil(u._w + 60)), H = 70 + depthOf(u) * (NODE_H + GAP_Y) - GAP_Y + 40;
  const cv = L.createCanvas(Math.min(W, 4000), Math.min(H, 4000)); const g = cv.getContext('2d');
  g.fillStyle = '#0f131c'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#e9edf5'; g.font = '700 20px "GB Display", "GB Figtree", sans-serif'; g.fillText(title, 30, 40);
  const avatars = new Map();
  await Promise.all([...people.entries()].map(async ([id, p]) => {
    if (!p.avatarUrl) return;
    try { const r = await fetchFn(p.avatarUrl, { signal: AbortSignal.timeout(6000) }); if (r.ok) avatars.set(id, await L.loadImage(Buffer.from(await r.arrayBuffer()))); } catch { /* initials instead */ }
  }));
  const node = (id, x, y) => {
    const me = id === highlight;
    g.fillStyle = me ? '#24305a' : '#1b2130'; g.strokeStyle = me ? '#6b93ff' : 'rgba(160,180,230,.18)'; g.lineWidth = me ? 2 : 1;
    g.beginPath(); g.roundRect(x, y, NODE_W, NODE_H, 12); g.fill(); g.stroke();
    const cx = x + 26, cy = y + NODE_H / 2, img = avatars.get(id), nm = people.get(id)?.name ?? 'Someone';
    g.save(); g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI * 2); g.clip();
    if (img) g.drawImage(img, cx - 16, cy - 16, 32, 32); else { g.fillStyle = '#6b93ff'; g.fillRect(cx - 16, cy - 16, 32, 32); g.fillStyle = '#0b1020'; g.font = '700 13px "GB Figtree", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(nm.slice(0, 2).toUpperCase(), cx, cy); }
    g.restore();
    g.fillStyle = '#e9edf5'; g.font = `${me ? 700 : 600} 13px "GB Figtree", sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
    let t = nm; while (g.measureText(t).width > NODE_W - 56 && t.length > 2) t = t.slice(0, -2);
    g.fillText(t === nm ? t : `${t}…`, x + 48, cy);
  };
  const draw = (unit) => {
    unit.people.forEach((id, k) => {
      const x = unit._x + k * (NODE_W + HEART);
      node(id, x, unit._y);
      if (k > 0) { g.fillStyle = '#ff6b9a'; g.font = '16px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('♥', x - HEART / 2, unit._y + NODE_H / 2); }
    });
    if (unit.children.length) {
      const fromX = unit._x + unitWidth(unit) / 2, fromY = unit._y + NODE_H, midY = fromY + GAP_Y / 2;
      g.strokeStyle = 'rgba(160,180,230,.35)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(fromX, fromY); g.lineTo(fromX, midY); g.stroke();
      const xs = unit.children.map((c) => c._x + NODE_W / 2);
      g.beginPath(); g.moveTo(Math.min(fromX, ...xs), midY); g.lineTo(Math.max(fromX, ...xs), midY); g.stroke();
      for (const c of unit.children) { g.beginPath(); g.moveTo(c._x + NODE_W / 2, midY); g.lineTo(c._x + NODE_W / 2, c._y); g.stroke(); draw(c); }
    }
  };
  draw(u);
  return cv.toBuffer('image/png');
}
