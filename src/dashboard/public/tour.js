// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Guided tours (3.2): dims the page, lights up one thing at a time and explains it in a small card.
// GBTour.start([{ target: '.css-selector' | () => element, title, text }], { onEnd }). Text only, no HTML strings.
'use strict';
(function () {
  let T = null;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const find = (t) => { try { return typeof t === 'function' ? t() : document.querySelector(t); } catch { return null; } };
  function end(finished) {
    if (!T) return;
    const t = T; T = null;
    window.removeEventListener('resize', t.place); window.removeEventListener('scroll', t.place, true); document.removeEventListener('keydown', t.key, true);
    t.ring.remove(); t.card.remove(); t.shade.remove();
    try { t.opts.onEnd?.(finished); } catch { /* the page's own business */ }
  }
  function show(k) {
    const t = T; if (!t) return;
    // skip steps whose thing isn't on the page right now
    const dir = k >= t.at ? 1 : -1;
    while (k >= 0 && k < t.steps.length && !find(t.steps[k].target)) k += dir;
    if (k >= t.steps.length) return end(true);
    if (k < 0) k = t.at;
    t.at = k;
    const s = t.steps[k], target = find(s.target);
    target?.scrollIntoView({ block: 'center', behavior: 'instant' });
    t.title.textContent = s.title; t.text.textContent = s.text;
    const here = t.steps.map((x, n) => (find(x.target) ? n : -1)).filter((n) => n >= 0); // only the steps that are on the page now
    t.count.textContent = `${here.indexOf(k) + 1} of ${here.length}`;
    t.back.hidden = k === 0;
    t.next.textContent = k === here.at(-1) ? 'Done' : 'Next';
    t.place(); t.next.focus({ preventScroll: true });
  }
  function start(steps, opts = {}) {
    end(false);
    const list = (steps ?? []).filter((s) => s && s.title);
    if (!list.length) return;
    const shade = el('div', 'gbt-shade'), ring = el('div', 'gbt-ring'), card = el('div', 'gbt-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Guided tour');
    const title = el('b', 'gbt-title'), text = el('p', 'gbt-text'), count = el('span', 'gbt-count');
    const skip = el('button', 'plain gbt-skip', 'Skip'), back = el('button', 'plain gbt-btn gbt-ghost', 'Back'), next = el('button', 'plain gbt-btn', 'Next');
    for (const b of [skip, back, next]) b.type = 'button';
    const row = el('div', 'gbt-row'); row.append(count, skip, back, next);
    card.append(title, text, row);
    document.body.append(shade, ring, card);
    const place = () => {
      if (!T) return;
      const target = find(T.steps[T.at].target); if (!target) return;
      const r = target.getBoundingClientRect(), pad = 6;
      Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      const cw = card.offsetWidth, ch = card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      const below = r.bottom + pad + 12 + ch <= vh, above = r.top - pad - 12 - ch >= 0;
      const top = below ? r.bottom + pad + 12 : above ? r.top - pad - 12 - ch : Math.max(12, vh - ch - 12);
      const left = Math.max(12, Math.min(vw - cw - 12, r.left + r.width / 2 - cw / 2));
      Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); end(false); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); show(T.at + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); show(T.at - 1); }
    };
    T = { steps: list, opts, at: 0, shade, ring, card, title, text, count, back, next, place, key };
    skip.addEventListener('click', () => end(false)); back.addEventListener('click', () => show(T.at - 1)); next.addEventListener('click', () => show(T.at + 1));
    shade.addEventListener('click', () => end(false));
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true); document.addEventListener('keydown', key, true);
    show(0);
  }
  window.GBTour = { start, stop: () => end(false), running: () => !!T };
})();
