/* Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved. */
/*
 * Good Boy 3.0 liquid layer, shared by the dashboard, the phone page and the Windows app (copied by `npm run sync`).
 * Adds what CSS alone can't: the aurora background, the glass refraction filter, spring motion, sliding highlights
 * under the active nav item / tab / segment, a squish on press, page transitions and the Dynamic Island.
 * Everything holds still for prefers-reduced-motion or when the page has the motion-off class. No inline styles in
 * HTML (the pages' security policy forbids them): positions are set through the style object.
 */
(() => {
  'use strict';
  const doc = document, root = doc.documentElement;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches || root.classList.contains('motion-off') || doc.body?.classList.contains('motion-off');
  const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  /** Builds elements without HTML strings: el('div', { class: 'x' }, child, 'text'). */
  const el = (tag, attrs = {}, ...kids) => {
    const n = attrs.ns ? doc.createElementNS(attrs.ns, tag) : doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k !== 'ns' && v != null) n.setAttribute(k === 'className' ? 'class' : k, v);
    for (const kid of kids) n.append(kid?.nodeType ? kid : doc.createTextNode(String(kid)));
    return n;
  };

  /* ---------- springs ---------- */
  function spring(from, to, onFrame, { k = 260, c = 22, done } = {}) {
    if (still()) { onFrame(to, 0); done?.(); return () => {}; }
    let x = from, v = 0, last = performance.now(), id;
    const step = (t) => {
      const dt = Math.min(0.032, (t - last) / 1000); last = t;
      v += (-k * (x - to) - c * v) * dt; x += v * dt;
      onFrame(x, v);
      if (Math.abs(v) < 0.02 && Math.abs(x - to) < 0.02) { onFrame(to, 0); done?.(); return; }
      id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }
  const jelly = (el, s = 1) => { if (!still() && el.animate) el.animate([{ transform: 'scale(1)' }, { transform: `scale(${1 - 0.05 * s},${1 + 0.04 * s})` }, { transform: `scale(${1 + 0.025 * s},${1 - 0.025 * s})` }, { transform: 'scale(1)' }], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' }); };
  const transition = (fn) => (doc.startViewTransition && !still() ? doc.startViewTransition(fn) : fn());

  /* ---------- refraction filter (static noise: the moving background makes it shimmer) ---------- */
  function addFilter() {
    if (doc.getElementById('gb-filters')) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = el('svg', { ns, id: 'gb-filters', width: '0', height: '0', 'aria-hidden': 'true' },
      el('filter', { ns, id: 'gb-liquid', x: '0', y: '0', width: '100%', height: '100%' },
        el('feTurbulence', { ns, type: 'fractalNoise', baseFrequency: '0.007 0.01', numOctaves: '2', seed: '7', result: 'n' }),
        el('feDisplacementMap', { ns, in: 'SourceGraphic', in2: 'n', scale: '22', xChannelSelector: 'R', yChannelSelector: 'G' })));
    svg.style.position = 'absolute';
    doc.body.prepend(svg);
  }

  /* ---------- aurora background: slow fields of light on a deep base (about 30 frames a second, paused when hidden) ---------- */
  function aurora() {
    if (doc.getElementById('gb-aurora')) return;
    const c = el('canvas', { id: 'gb-aurora', 'aria-hidden': 'true' }); doc.body.prepend(c);
    const g = c.getContext('2d'); let W = 0, H = 0, lastDraw = 0;
    const size = () => { const d = Math.min(1.5, devicePixelRatio || 1); W = innerWidth; H = innerHeight; c.width = W * d; c.height = H * d; g.setTransform(d, 0, 0, d, 0, 0); draw(performance.now()); };
    const fields = [['--gb-m1', 0.2, 0.25, 0.55, 0.07], ['--gb-m2', 0.82, 0.7, 0.5, 0.05], ['--gb-m3', 0.7, 0.15, 0.45, 0.06], ['--gb-m4', 0.15, 0.9, 0.35, 0.04]];
    function draw(t) {
      const s = t / 1000, mix = Number(css('--gb-mesh')) || 0.55;
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = css('--gb-bg') || '#060a12'; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = css('--gb-blend') || 'lighter';
      fields.forEach(([col, bx, by, rr, sp], i) => {
        const x = W * (bx + Math.sin(s * sp + i * 1.7) * 0.12), y = H * (by + Math.cos(s * sp * 1.3 + i) * 0.1);
        const r = Math.max(W, H) * rr * (1 + Math.sin(s * sp * 2 + i) * 0.08);
        const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, css(col) || '#1d4ed8'); rg.addColorStop(1, 'transparent');
        g.globalAlpha = mix * 0.55; g.fillStyle = rg; g.fillRect(0, 0, W, H);
      });
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'transparent'); v.addColorStop(1, 'rgba(0,0,0,.3)'); g.fillStyle = v; g.fillRect(0, 0, W, H);
    }
    const loop = (t) => { if (!doc.hidden && !still() && t - lastDraw > 33) { lastDraw = t; draw(t); } requestAnimationFrame(loop); };
    addEventListener('resize', size); size(); requestAnimationFrame(loop);
    new MutationObserver(() => draw(performance.now())).observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    if (doc.body) new MutationObserver(() => draw(performance.now())).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  }

  /* ---------- sliding highlights: nav, segmented controls, tabs ---------- */
  const memory = new Map(); // key -> { y, h } or { x, w } so a re-rendered sidebar continues from where the pill was
  function placeNav() {
    for (const box of doc.querySelectorAll('.side, aside, nav.nav')) {
      const items = box.querySelectorAll(':scope > .nav-item, :scope > button[data-nav], :scope > .nav > button[data-nav], :scope > button.nav');
      if (!items.length) continue;
      const host = items[0].parentElement;
      host.classList.add('gb-hasnav');
      let pill = host.querySelector(':scope > .gb-navpill');
      if (!pill) { pill = el('div', { class: 'gb-navpill' }); host.prepend(pill); }
      const active = [...items].find((x) => x.classList.contains('active') || x.getAttribute('aria-current') === 'page');
      if (!active) { pill.style.opacity = '0'; continue; }
      pill.style.opacity = '1';
      const to = { y: active.offsetTop, h: active.offsetHeight, x: active.offsetLeft, w: active.offsetWidth };
      const key = 'nav', from = memory.get(key) ?? to;
      if (from.y === to.y && from.h === to.h && pill.dataset.placed) continue;
      pill.dataset.placed = '1';
      pill._stop?.();
      pill.style.width = `${to.w}px`; pill.style.right = 'auto'; pill.style.left = `${to.x}px`;
      pill._stop = spring(0, 1, (p, vel) => {
        const y = from.y + (to.y - from.y) * p, h = from.h + (to.h - from.h) * p, st = Math.min(0.4, Math.abs(vel) / 30);
        memory.set(key, { ...to, y, h });
        pill.style.height = `${h}px`; pill.style.transform = `translateY(${y}px) scale(${1 - st * 0.25},${1 + st * 0.6})`;
      }, { k: 300, c: 24 });
    }
  }
  function placeSegs() {
    for (const seg of doc.querySelectorAll('.gb-seg')) {
      let pill = seg.querySelector(':scope > .gb-pill');
      if (!pill) { pill = el('div', { class: 'gb-pill' }); seg.prepend(pill); }
      const active = seg.querySelector(':scope > [aria-pressed="true"], :scope > [aria-selected="true"]');
      if (!active) { pill.style.opacity = '0'; continue; }
      pill.style.opacity = '1';
      const key = seg.dataset.key || seg.id || 'seg';
      const to = { x: active.offsetLeft, w: active.offsetWidth }, from = memory.get(key) ?? to;
      if (pill.dataset.x === String(to.x) && pill.dataset.w === String(to.w)) continue;
      pill.dataset.x = String(to.x); pill.dataset.w = String(to.w);
      pill._stop?.();
      pill._stop = spring(0, 1, (p) => { const x = from.x + (to.x - from.x) * p, w = from.w + (to.w - from.w) * p; memory.set(key, { x, w }); pill.style.width = `${w}px`; pill.style.transform = `translateX(${x}px)`; }, { k: 320, c: 24 });
    }
  }
  let queued = false;
  const sync = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; placeNav(); placeSegs(); }); };

  /* ---------- squish on press ---------- */
  // 3.0: no wobble on press; buttons only darken slightly (in CSS).

  /* ---------- Dynamic Island ---------- */
  const island = {
    el: null, state: { w: 240, h: 38, r: 22 }, stop: null, timer: null,
    mount(container, { actions = [] } = {}) {
      if (!container) return null;
      const acts = el('div', { class: 'gb-acts' });
      const isl = el('div', { class: 'gb-island', tabindex: '0', role: 'button', 'aria-expanded': 'false', 'aria-label': 'Bot status. Open quick actions' },
        el('div', { class: 'gb-in' }, el('span', { class: 'gb-dot' }), el('span', { class: 'gb-st' }, 'Good Boy'), el('span', { class: 'gb-ms' })),
        el('div', { class: 'gb-news' }, el('span', { class: 'gb-ni' }), el('span', { class: 'gb-nt' })),
        el('div', { class: 'gb-full' }, el('h4', { class: 'gb-fh' }, 'Good Boy'), el('small', { class: 'gb-fs' }), acts, el('ul', { class: 'gb-feed' })));
      for (const a of actions) { const b = el('button', { type: 'button' }, a.label); b.addEventListener('click', (e) => { e.stopPropagation(); a.run(); }); acts.append(b); }
      isl.addEventListener('click', () => this.toggle());
      isl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(); } });
      const wrap = el('div', { class: 'gb-island-wrap' }, isl);
      container.append(wrap);
      // On phones the island docks at the bottom of the screen. A glass ancestor would trap position:fixed, so it
      // moves out to the page itself there, and back into its place on wider screens.
      const home = { parent: container, next: null };
      const phone = matchMedia('(max-width: 760px)');
      const place = () => { if (phone.matches) { if (wrap.parentElement !== doc.body) { home.next = wrap.nextSibling; doc.body.append(wrap); } } else if (wrap.parentElement !== home.parent) home.parent.insertBefore(wrap, home.next && home.next.parentElement === home.parent ? home.next : null); };
      phone.addEventListener('change', place); this.place = place; setTimeout(place, 0);
      this.el = isl; this.set(this.state);
      return wrap;
    },
    set(s) { if (!this.el) return; Object.assign(this.state, s); this.el.style.width = `${this.state.w}px`; this.el.style.height = `${this.state.h}px`; this.el.style.borderRadius = `${this.state.r}px`; },
    morph(w, h, r, opt) { this.stop?.(); const a = { ...this.state }; this.stop = spring(0, 1, (p) => this.set({ w: a.w + (w - a.w) * p, h: a.h + (h - a.h) * p, r: a.r + (r - a.r) * p }), opt); },
    swap(out, inn) {
      if (still()) { out.style.opacity = '0'; inn.style.opacity = '1'; return; }
      out.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(6px)' }], { duration: 160, fill: 'forwards' });
      inn.animate([{ opacity: 0, filter: 'blur(6px)', transform: 'scale(.96)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 360, delay: 120, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    },
    status({ text, ms, ok = true, title, sub }) {
      if (!this.el) return;
      this.el.querySelector('.gb-st').textContent = text;
      this.el.querySelector('.gb-ms').textContent = ms == null ? '' : `${ms} ms`;
      this.el.querySelector('.gb-dot').classList.toggle('off', !ok);
      if (title) this.el.querySelector('.gb-fh').textContent = title;
      if (sub) this.el.querySelector('.gb-fs').textContent = sub;
    },
    feed(lines) { if (!this.el) return; const ul = this.el.querySelector('.gb-feed'); ul.replaceChildren(...lines.slice(0, 4).map((l) => el('li', {}, l))); },
    toggle() {
      if (!this.el) return;
      const open = !this.el.hasAttribute('data-open');
      this.el.toggleAttribute('data-open', open); this.el.setAttribute('aria-expanded', String(open));
      const inl = this.el.querySelector('.gb-in'), full = this.el.querySelector('.gb-full'), news = this.el.querySelector('.gb-news');
      if (open) { this.morph(Math.min(380, innerWidth - 32), 220, 30, { k: 200, c: 17 }); this.swap(news.style.opacity === '1' ? news : inl, full); }
      else { this.morph(240, 38, 22, { k: 320, c: 26 }); this.swap(full, inl); }
    },
    news(icon, text) {
      if (!this.el || this.el.hasAttribute('data-open')) return;
      const inl = this.el.querySelector('.gb-in'), n = this.el.querySelector('.gb-news');
      n.querySelector('.gb-ni').textContent = icon; n.querySelector('.gb-nt').textContent = text;
      clearTimeout(this.timer);
      // a quick inward breath, then it stretches open with a soft wobble
      this.morph(222, 34, 18, { k: 520, c: 30, done: () => { this.morph(Math.min(360, innerWidth - 32), 44, 22, { k: 230, c: 14 }); this.swap(inl, n); } });
      this.timer = setTimeout(() => { if (this.el.hasAttribute('data-open')) return; this.morph(240, 38, 22, { k: 300, c: 24 }); this.swap(n, inl); }, 3600);
    },
  };

  function start() {
    addFilter(); // 3.0: no aurora background (the flat look from the 3.0 design)
    new MutationObserver(sync).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-pressed', 'aria-selected'] });
    addEventListener('resize', sync); sync();
  }
  window.GB = { spring, jelly, transition, island, sync, still };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})();
