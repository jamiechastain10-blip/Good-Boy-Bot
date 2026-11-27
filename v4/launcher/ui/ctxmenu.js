/* Basic Ghost Labs. Copyright (c) 2026 Basic Ghost Labs. All rights reserved. */
/* The right-click menu, the same in every Basic Ghost Labs app. It replaces the plain Windows menu with one drawn in the
   app's own look (its colours come from the --cm-* variables in ctxmenu.css, which each app points at its own colours,
   so the menu changes with the theme). It always offers what makes sense where you clicked: cut, copy and paste in a
   box you can type in, copy for selected words, open and copy for a link. Each app adds its own actions with
   BGLMenu.setup({ extra(ctx) { return [...] } }).

   An item is { label, run, icon, kbd, disabled, danger }, the string '-' for a line between groups, or { heading }.
   Anything inside an element with data-native-menu keeps the normal menu. */
(function () {
  'use strict';
  const ICON = {
    undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
    redo: 'm15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
    cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    paste: 'M9 4h6v3H9zM8 5H5v16h14V5h-3',
    select: 'M4 4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 8v8M20 8v8M8 4h8M8 20h8',
    erase: 'M20 20H9l-5-5 10-10 7 7-7 7M7 13l5 5',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    back: 'M15 18l-6-6 6-6',
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2.1 1.2L14.7 22h-4l-.3-1.9a7 7 0 0 1-2.1-1.2l-1.9.7-2-3.4L6 15a7 7 0 0 1 0-2.4L4.4 11.4l2-3.4 1.9.7a7 7 0 0 1 2.1-1.2L10.7 5h4l.3 2.5a7 7 0 0 1 2.1 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.4z',
    palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5s.8-1.5 2-1.5H17a4 4 0 0 0 4-4c0-4.7-4-8.5-9-8.5zM7.5 12.5h0M9.5 8h0M14.5 8h0',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    play: 'M7 4v16l13-8z',
    stop: 'M6 6h12v12H6z',
    folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
    help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h0',
    lock: 'M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3',
    plus: 'M12 5v14M5 12h14',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
    heart: 'M12 21s-7-4.4-9-9.5C1.7 8 4 4.5 7.5 4.5c2 0 3.4 1.1 4.5 2.6 1.1-1.5 2.5-2.6 4.5-2.6C20 4.5 22.3 8 21 11.5 19 16.6 12 21 12 21z',
    bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h0',
    key: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 12l9-9M17 6l3 3M15 8l2 2',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0',
    check: 'm5 12 5 5 9-10',
  };
  const NS = 'http://www.w3.org/2000/svg';
  const opts = { edit: null, extra: null, toast: null };
  let menu = null, items = [], at = -1, back = null;

  function icon(name) {
    const d = ICON[name] || name;
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    if (d) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
    return s;
  }
  function say(text) { if (opts.toast) opts.toast(text); }

  // ---- what was clicked
  const TYPED = /^(text|search|url|email|tel|password|number)$/i;
  function typable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TYPED.test(el.type || 'text');
  }
  function selectedIn(el) {
    try { if (el && typeof el.selectionStart === 'number') return el.value.slice(el.selectionStart, el.selectionEnd); } catch (e) { /* a box without a selection */ }
    return String(window.getSelection ? window.getSelection() : '');
  }
  function context(e) {
    const t = e.target instanceof Element ? e.target : e.target && e.target.parentElement;
    const field = t && t.closest('input,textarea,[contenteditable]');
    const editable = typable(field) ? field : null;
    const a = t && t.closest('a[href]');
    const img = t && t.closest('img');
    return {
      target: t, x: e.clientX, y: e.clientY,
      editable, password: !!editable && editable.type === 'password',
      selection: selectedIn(editable),
      link: a && !/^javascript:/i.test(a.getAttribute('href')) ? a.href : null,
      image: img ? (img.currentSrc || img.src) : null,
    };
  }

  // ---- doing it: the app can do edits itself (Electron does it best from the main side), otherwise the page does
  async function writeClip(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* not allowed */ }
    ta.remove();
    return ok;
  }
  function changed(el) { el.dispatchEvent(new Event('input', { bubbles: true })); }
  async function edit(action, ctx) {
    const el = ctx.editable;
    if (el) el.focus();
    if (opts.edit) { try { if (await opts.edit(action) !== false) return; } catch (e) { /* the page tries */ } }
    if (action === 'selectAll') { if (el && el.select) el.select(); else document.execCommand('selectAll'); return; }
    if (action === 'paste') {
      let text = null;
      try { text = await navigator.clipboard.readText(); } catch (e) { /* not allowed here */ }
      if (text == null) { if (!document.execCommand('paste')) say('Press Ctrl+V to paste here.'); return; }
      if (!document.execCommand('insertText', false, text) && el && typeof el.setRangeText === 'function') { el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end'); changed(el); }
      return;
    }
    if (action === 'copy' || action === 'cut') {
      if (document.execCommand(action)) return;
      const text = ctx.selection;
      if (!text) return;
      if (!(await writeClip(text))) { say(`Press Ctrl+${action === 'cut' ? 'X' : 'C'} instead.`); return; }
      if (action === 'cut' && el && typeof el.setRangeText === 'function') { el.setRangeText('', el.selectionStart, el.selectionEnd, 'end'); changed(el); }
      return;
    }
    if (action === 'delete') { if (!document.execCommand('delete') && el && typeof el.setRangeText === 'function') { el.setRangeText('', el.selectionStart, el.selectionEnd, 'end'); changed(el); } return; }
    document.execCommand(action); // undo, redo
  }

  // ---- the items for this spot
  function built(ctx) {
    const groups = [];
    if (ctx.editable) {
      const sel = !!ctx.selection, pw = ctx.password;
      groups.push([
        { label: 'Undo', icon: 'undo', kbd: 'Ctrl+Z', run: () => edit('undo', ctx) },
        { label: 'Redo', icon: 'redo', kbd: 'Ctrl+Y', run: () => edit('redo', ctx) },
      ], [
        { label: 'Cut', icon: 'cut', kbd: 'Ctrl+X', disabled: !sel || pw, run: () => edit('cut', ctx) },
        { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', disabled: !sel || pw, run: () => edit('copy', ctx) },
        { label: 'Paste', icon: 'paste', kbd: 'Ctrl+V', run: () => edit('paste', ctx) },
        { label: 'Delete', icon: 'erase', kbd: 'Del', disabled: !sel, run: () => edit('delete', ctx) },
      ], [
        { label: 'Select all', icon: 'select', kbd: 'Ctrl+A', disabled: !(ctx.editable.value || ctx.editable.textContent), run: () => edit('selectAll', ctx) },
      ]);
    } else if (ctx.selection.trim()) {
      groups.push([{ label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', run: () => edit('copy', ctx) }]);
    }
    if (ctx.link) {
      const open = opts.openLink || ((u) => window.open(u, '_blank', 'noopener'));
      groups.push([
        { label: 'Open link', icon: 'open', run: () => open(ctx.link) },
        { label: 'Copy link', icon: 'link', run: () => api.copy(ctx.link, 'Link copied.') },
      ]);
    }
    if (ctx.image && !/^data:/.test(ctx.image)) groups.push([{ label: 'Copy picture address', icon: 'image', run: () => api.copy(ctx.image, 'Picture address copied.') }]);
    let more = [];
    try { more = (opts.extra && opts.extra(ctx)) || []; } catch (e) { more = []; }
    const out = [];
    for (const g of groups) { if (out.length) out.push('-'); out.push(...g); }
    if (more.length) { if (out.length && more[0] !== '-' && !more[0].heading) out.push('-'); out.push(...more); }
    // no line at the start or end, and never two together
    return out.filter((it, i, all) => it !== '-' || (i > 0 && i < all.length - 1 && all[i - 1] !== '-'));
  }

  // ---- drawing it
  function close() {
    if (!menu) return;
    menu.remove(); menu = null; items = []; at = -1;
    document.removeEventListener('keydown', keys, true);
    if (back && back.isConnected && document.activeElement === document.body) back.focus();
    back = null;
  }
  function mark(i) {
    if (!menu) return;
    const els = menu.querySelectorAll('[role=menuitem]');
    els.forEach((el, k) => el.classList.toggle('on', k === i));
    at = i;
    if (els[i]) menu.setAttribute('aria-activedescendant', els[i].id);
  }
  function pick(i) {
    const it = items[i];
    if (!it || it.disabled) return;
    close();
    try { const r = it.run && it.run(); if (r && r.catch) r.catch((e) => say(e && e.message ? e.message : String(e))); } catch (e) { say(e && e.message ? e.message : String(e)); }
  }
  function step(dir) {
    if (!items.length) return;
    for (let n = 1; n <= items.length; n++) { const i = (at + dir * n + items.length * 2) % items.length; if (!items[i].disabled) return mark(i); }
  }
  function keys(e) {
    if (!menu) return;
    const k = e.key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); return step(k === 'ArrowDown' ? 1 : -1); }
    if (k === 'Home' || k === 'End') { e.preventDefault(); at = k === 'Home' ? -1 : items.length; return step(k === 'Home' ? 1 : -1); }
    if ((k === 'Enter' || k === ' ') && at >= 0) { e.preventDefault(); e.stopPropagation(); return pick(at); }
    if (k === 'Tab') { e.preventDefault(); return step(e.shiftKey ? -1 : 1); }
    if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const i = items.findIndex((it, n) => n > at && !it.disabled && it.label && it.label[0].toLowerCase() === k.toLowerCase());
      const j = i >= 0 ? i : items.findIndex((it) => !it.disabled && it.label && it.label[0].toLowerCase() === k.toLowerCase());
      if (j >= 0) { e.preventDefault(); mark(j); }
      return;
    }
    close(); // any other key goes on to the page
  }
  function open(x, y, list, keyboard) {
    close();
    if (!list || !list.length) return;
    back = document.activeElement;
    menu = document.createElement('div');
    menu.className = 'bgl-menu'; menu.setAttribute('role', 'menu'); menu.tabIndex = -1;
    items = [];
    let n = 0;
    for (const it of list) {
      if (it === '-') { const s = document.createElement('div'); s.className = 'bgl-sep'; s.setAttribute('role', 'separator'); menu.append(s); continue; }
      if (it.heading) { const hd = document.createElement('div'); hd.className = 'bgl-head'; hd.textContent = it.heading; menu.append(hd); continue; }
      const i = items.length; items.push(it);
      const b = document.createElement('div');
      b.className = 'bgl-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '');
      b.setAttribute('role', 'menuitem'); b.id = `bgl-menu-${n++}`;
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      b.append(icon(it.checked ? 'check' : it.icon || ''));
      const l = document.createElement('span'); l.className = 'bgl-label'; l.textContent = it.label; b.append(l);
      if (it.kbd) { const k = document.createElement('span'); k.className = 'bgl-kbd'; k.textContent = it.kbd; b.append(k); }
      b.addEventListener('pointermove', () => { if (!it.disabled && at !== i) mark(i); });
      b.addEventListener('click', (e) => { e.stopPropagation(); pick(i); });
      menu.append(b);
    }
    menu.addEventListener('pointerleave', () => mark(-1));
    // keep the text box focused and its selection in place while the menu is used
    menu.addEventListener('pointerdown', (e) => e.preventDefault());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(menu);
    const r = menu.getBoundingClientRect(), W = innerWidth, H = innerHeight, pad = 6;
    let left = x, top = y;
    if (left + r.width > W - pad) left = Math.max(pad, x - r.width);
    if (top + r.height > H - pad) top = Math.max(pad, Math.min(y - r.height, H - pad - r.height));
    menu.style.left = `${Math.round(left)}px`; menu.style.top = `${Math.round(top)}px`;
    menu.style.maxHeight = `${H - pad * 2}px`;
    menu.style.transformOrigin = `${left < x ? 'right' : 'left'} ${top < y ? 'bottom' : 'top'}`;
    document.addEventListener('keydown', keys, true);
    if (keyboard) step(1);
  }

  // ---- listening
  document.addEventListener('contextmenu', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-native-menu]')) return;
    e.preventDefault();
    if (menu && menu.contains(e.target)) return;
    const ctx = context(e);
    let x = e.clientX, y = e.clientY;
    const kb = e.button !== 2 && x === 0 && y === 0; // the menu key or Shift+F10
    if (kb) { const el = ctx.target && ctx.target.getBoundingClientRect ? ctx.target.getBoundingClientRect() : { left: 20, bottom: 20 }; x = el.left + 8; y = Math.min(el.bottom, innerHeight - 20); }
    open(x, y, built(ctx), kb);
  });
  addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) close(); }, true);
  addEventListener('blur', close);
  addEventListener('resize', close);
  addEventListener('scroll', (e) => { if (menu && !menu.contains(e.target)) close(); }, true);
  addEventListener('wheel', (e) => { if (menu && !menu.contains(e.target)) close(); }, { capture: true, passive: true });

  const api = {
    /** edit(action): do 'cut' | 'copy' | 'paste' | 'undo' | 'redo' | 'delete' | 'selectAll'; return false to let the page try.
        extra(ctx): the app's own items for this spot. toast(text): show a short message. openLink(url): open a link. */
    setup(o) { Object.assign(opts, o || {}); },
    open, close,
    copy: async (text, done) => { if (await writeClip(String(text))) say(done || 'Copied.'); else say('Could not copy that.'); },
    icons: ICON,
  };
  window.BGLMenu = api;
})();
