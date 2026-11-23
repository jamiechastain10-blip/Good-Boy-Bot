// Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The boot animation: the mascot comes in and a ring fills as the real start-up steps finish, then it settles
// into the app. It never holds the app back: it lasts at least a moment so it doesn't flash, and any click skips it.
'use strict';
(function () {
  const RING = 597;
  function boot() {
    const el = document.createElement('div');
    el.className = 'boot';
    el.setAttribute('role', 'status');
    el.innerHTML = '<div class="stage"><div class="orb"><svg viewBox="0 0 200 200" aria-hidden="true"><defs><linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d8cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><circle class="track" cx="100" cy="100" r="95"/><circle class="fill" cx="100" cy="100" r="95"/></svg><div class="pup"><img src="mascot.png" alt=""></div></div>'
      + '<h1>Good Boy</h1><div class="step"></div><div class="tag">Good Boy 4</div></div>';
    document.body.append(el);
    const fill = el.querySelector('.fill'), step = el.querySelector('.step'), orb = el.querySelector('.orb');
    const born = Date.now();
    let closed = false, wait = null;
    const close = () => {
      if (closed) return;
      closed = true;
      el.classList.add('done');
      setTimeout(() => el.remove(), 450);
      if (wait) wait();
    };
    el.addEventListener('click', close);
    return {
      /** One start-up step: what is happening, and how far along (0 to 1). Text only, never HTML. */
      step(text, amount, strong) {
        if (closed) return;
        step.textContent = text;
        if (strong) { const b = document.createElement('b'); b.textContent = strong; step.append(' ', b); }
        fill.style.strokeDashoffset = String(RING * (1 - Math.max(0, Math.min(1, amount))));
      },
      /** Finished: a green ring and a little hop, then away. Waits so the whole thing lasts at least 900 ms. */
      finish(ok = true) {
        if (closed) return Promise.resolve();
        if (ok) orb.classList.add('ok');
        fill.style.strokeDashoffset = '0';
        return new Promise((resolve) => { wait = resolve; setTimeout(close, Math.max(380, 900 - (Date.now() - born))); });
      },
      get closed() { return closed; },
    };
  }
  window.GBBoot = boot;
})();
