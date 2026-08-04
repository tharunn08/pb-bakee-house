/* ============================================================
   PB BAKE HOUSE — UI LAYER
   ------------------------------------------------------------
   Presentation only. Touches no API, no cart maths, no auth,
   no routing. Safe to remove without breaking any feature.
   Loaded in <head> (blocking) so the theme is set before paint.
   ============================================================ */
'use strict';

/* ---------- Theme: applied before first paint to avoid a flash ---------- */
(function () {
  try {
    var saved = localStorage.getItem('pb_theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
  } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
})();

const UI = {
  /* Toggle light / dark and remember the choice. */
  toggleTheme() {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('pb_theme', next); } catch (e) {}
    document.querySelectorAll('.theme-toggle i').forEach(i => i.textContent = next === 'dark' ? '☾' : '☀');
  },

  /* ---------- Wishlist: browser-only, never sent anywhere ---------- */
  wish: {
    read() { try { return JSON.parse(localStorage.getItem('pb_wishlist') || '[]'); } catch (e) { return []; } },
    has(id) { return UI.wish.read().includes(String(id)); },
    toggle(id, el) {
      id = String(id);
      let list = UI.wish.read();
      const on = list.includes(id);
      list = on ? list.filter(x => x !== id) : list.concat(id);
      try { localStorage.setItem('pb_wishlist', JSON.stringify(list)); } catch (e) {}
      if (el) {
        el.classList.toggle('on', !on);
        el.textContent = !on ? '♥' : '♡';
        el.setAttribute('aria-label', !on ? 'Remove from wishlist' : 'Save to wishlist');
      }
      if (typeof toast === 'function') toast(on ? 'Removed from your saved list' : 'Saved to your list', 'ok');
    },
    paint() {
      document.querySelectorAll('.wish[data-wid]').forEach(el => {
        const on = UI.wish.has(el.dataset.wid);
        el.classList.toggle('on', on);
        el.textContent = on ? '♥' : '♡';
      });
    }
  },

  /* ---------- Star rating markup ---------- */
  stars(rating, count) {
    const r = Math.round(Number(rating) || 0);
    let s = '';
    for (let i = 1; i <= 5; i++) s += i <= r ? '★' : '<span class="off">★</span>';
    const n = Number(count) || 0;
    return `<div class="rating"><span class="rs">${s}</span>${n ? `<small>${n}</small>` : ''}</div>`;
  },

  /* ---------- Ripple on every .btn ---------- */
  initRipple() {
    document.addEventListener('pointerdown', e => {
      const btn = e.target.closest('.btn');
      if (!btn || btn.disabled) return;
      const r = btn.getBoundingClientRect();
      const size = Math.max(r.width, r.height);
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = size + 'px';
      span.style.left = (e.clientX - r.left - size / 2) + 'px';
      span.style.top = (e.clientY - r.top - size / 2) + 'px';
      btn.appendChild(span);
      setTimeout(() => span.remove(), 620);
    }, { passive: true });
  },

  /* ---------- Nav shrinks on scroll ---------- */
  initNavScroll() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 30);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  },

  /* ---------- Back-to-top ---------- */
  initToTop() {
    if (document.getElementById('toTop')) return;
    const b = document.createElement('button');
    b.id = 'toTop';
    b.className = 'to-top';
    b.type = 'button';
    b.setAttribute('aria-label', 'Back to top');
    b.innerHTML = '&#8593;';
    b.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    document.body.appendChild(b);
    window.addEventListener('scroll', () => b.classList.toggle('on', window.scrollY > 640), { passive: true });
  },

  /* ---------- Split the hero headline into animated words ---------- */
  initHeroWords() {
    const h = document.querySelector('.hero h1');
    if (!h || h.dataset.split) return;
    h.dataset.split = '1';
    let i = 0;
    h.querySelectorAll('*').forEach(el => {
      if (el.children.length) return;
      el.innerHTML = el.textContent.split(/\s+/).filter(Boolean)
        .map(w => `<span class="w" style="animation-delay:${(i++) * 70 + 120}ms">${w}</span>`).join(' ');
    });
    h.childNodes.forEach(n => {
      if (n.nodeType !== 3 || !n.textContent.trim()) return;
      const frag = document.createElement('span');
      frag.innerHTML = n.textContent.split(/\s+/).filter(Boolean)
        .map(w => `<span class="w" style="animation-delay:${(i++) * 70 + 120}ms">${w}</span>`).join(' ');
      n.replaceWith(frag);
    });
  },

  /* ---------- Ambient flour motes in the hero ---------- */
  initMotes() {
    const hero = document.querySelector('.hero');
    if (!hero || hero.querySelector('.hero-motes')) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const wrap = document.createElement('div');
    wrap.className = 'hero-motes';
    let html = '';
    for (let i = 0; i < 16; i++) {
      const size = 2 + Math.random() * 5;
      html += `<i class="mote" style="
        left:${Math.random() * 100}%;
        bottom:${-10 + Math.random() * 40}%;
        width:${size}px;height:${size}px;
        animation-duration:${9 + Math.random() * 10}s;
        animation-delay:${-Math.random() * 12}s"></i>`;
    }
    wrap.innerHTML = html;
    hero.prepend(wrap);
  },

  /* ---------- Count numbers up when they scroll into view ---------- */
  initCounters() {
    const els = document.querySelectorAll('[data-count]');
    if (!els.length || !('IntersectionObserver' in window)) {
      els.forEach(el => el.textContent = el.dataset.count + (el.dataset.suffix || ''));
      return;
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        const el = en.target;
        const to = Number(el.dataset.count) || 0;
        const suffix = el.dataset.suffix || '';
        const dur = 1500;
        const t0 = performance.now();
        const tick = now => {
          const p = Math.min(1, (now - t0) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(to * eased).toLocaleString('en-IN') + suffix;
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, { threshold: .4 });
    els.forEach(el => io.observe(el));
  },

  /* ---------- Show / hide password ---------- */
  initPasswordToggles() {
    document.querySelectorAll('input[type=password]').forEach(inp => {
      if (inp.dataset.pwt) return;
      inp.dataset.pwt = '1';
      const field = inp.closest('.field');
      if (!field) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pw-toggle';
      b.textContent = '👁';
      b.setAttribute('aria-label', 'Show password');
      b.onclick = () => {
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        b.textContent = show ? '🙈' : '👁';
        b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      };
      field.appendChild(b);
    });
  },

  /* ---------- Horizontal rail arrows (testimonials) ---------- */
  railScroll(sel, dir) {
    const rail = document.querySelector(sel);
    if (!rail) return;
    rail.scrollBy({ left: dir * Math.min(rail.clientWidth * .8, 430), behavior: 'smooth' });
  },

  /* ---------- Free-delivery progress inside the cart drawer ---------- */
  paintDeliveryMeter() {
    const foot = document.getElementById('cartFoot');
    if (!foot || foot.classList.contains('hide')) return;
    if (typeof Cart !== 'function' && typeof Cart !== 'object') return;
    const cfg = window.SITE && window.SITE.delivery;
    if (!cfg || !cfg.free_above) return;
    const sub = Cart.subtotal();
    const target = Number(cfg.free_above);
    const pct = Math.min(100, (sub / target) * 100);
    const left = Math.max(0, target - sub);
    const money = n => '\u20b9' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    const msg = left > 0
      ? `Add <b>${money(left)}</b> more for free delivery within ${cfg.free_within_km} km`
      : `Free delivery unlocked within ${cfg.free_within_km} km`;
    let box = foot.querySelector('.deliv-meter');
    if (!box) {
      box = document.createElement('div');
      box.className = 'deliv-meter';
      box.innerHTML = '<p></p><div class="dm-track"><div class="dm-fill"></div></div>';
      foot.prepend(box);
    }
    box.querySelector('p').innerHTML = msg;
    box.querySelector('.dm-fill').style.width = pct + '%';
  },

  /* ---------- Fade images in once decoded ---------- */
  initLazyFade() {
    document.querySelectorAll('img:not([data-faded])').forEach(img => {
      img.dataset.faded = '1';
      if (img.complete) return;
      img.style.opacity = '0';
      img.style.transition = 'opacity .6s cubic-bezier(.22,1,.36,1)';
      img.addEventListener('load', () => { img.style.opacity = '1'; }, { once: true });
      img.addEventListener('error', () => { img.style.opacity = '1'; }, { once: true });
    });
  },

  /* Re-run the bits that need to see freshly rendered markup. */
  refresh() {
    this.initDatePlaceholders && this.initDatePlaceholders();
    this.initImageReveal && this.initImageReveal();
    UI.wish.paint();
    UI.initLazyFade();
    UI.initPasswordToggles();
    UI.paintDeliveryMeter();
  },

  init() {
    UI.initRipple();
    UI.initNavScroll();
    UI.initToTop();
    UI.initHeroWords();
    UI.initMotes();
    UI.initCounters();
    UI.refresh();

    // Anything the app renders later (product grids, cart) gets picked up too.
    const host = document.body;
    if (window.MutationObserver && host) {
      let queued = false;
      new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; UI.refresh(); });
      }).observe(host, { childList: true, subtree: true });
    }
  }
};

window.UI = UI;

/* Boot */
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
  document.querySelectorAll('.theme-toggle i').forEach(i => {
    i.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☾' : '☀';
  });
});

/* Dismiss the opening curtain once everything is painted. */
window.addEventListener('load', () => {
  const l = document.getElementById('pbLoader');
  if (l) setTimeout(() => l.classList.add('done'), 380);
});
/* Safety net: never let the curtain trap the page. */
setTimeout(() => {
  const l = document.getElementById('pbLoader');
  if (l) l.classList.add('done');
}, 4000);

/* ---------- RECENTLY VIEWED ----------
   Purely local: a list of product ids in localStorage, newest first.
   No tracking, nothing sent anywhere. */
UI.recent = {
  KEY: 'pb_recent',
  read() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch { return []; }
  },
  push(id) {
    if (!id) return;
    try {
      const list = this.read().filter(x => String(x) !== String(id));
      list.unshift(String(id));
      localStorage.setItem(this.KEY, JSON.stringify(list.slice(0, 12)));
    } catch (e) { /* private mode - silently skip */ }
  },
  clear() { try { localStorage.removeItem(this.KEY); } catch (e) {} },
};

/* ---------- DATE PLACEHOLDER ----------
   Native date inputs ignore the placeholder attribute, so we track emptiness
   with a class and let CSS swap in our own uppercase DD-MM-YYYY. */
UI.initDatePlaceholders = function () {
  document.querySelectorAll('.date-input').forEach(el => {
    if (el.dataset.phBound) return;
    el.dataset.phBound = '1';
    const sync = () => el.classList.toggle('is-empty', !el.value);
    sync();
    ['input', 'change', 'blur'].forEach(ev => el.addEventListener(ev, sync));
  });
};

/* ---------- IMAGE REVEAL ----------
   Product and section images fade up out of a soft blur as they scroll in. */
UI.initImageReveal = function () {
  if (!('IntersectionObserver' in window)) return;
  const imgs = document.querySelectorAll('.card-img img:not([data-rev]), .cc-design-img img:not([data-rev]), .cat-card img:not([data-rev])');
  if (!imgs.length) return;
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('shown');
      obs.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -40px 0px', threshold: 0.05 });

  imgs.forEach(img => {
    img.dataset.rev = '1';
    img.classList.add('reveal-img');
    // Cached images may already be complete — reveal on the next frame.
    if (img.complete && img.naturalWidth) requestAnimationFrame(() => img.classList.add('shown'));
    else img.addEventListener('load', () => img.classList.add('shown'), { once: true });
    io.observe(img);
  });
  // Nothing stays blurred if the observer never fires.
  setTimeout(() => imgs.forEach(i => i.classList.add('shown')), 2600);
};

/* ---------- CONFETTI ----------
   Used once, on the order success page. Pure CSS animation, no library. */
UI.confetti = function (count) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = document.createElement('div');
  host.className = 'confetti-host';
  document.body.appendChild(host);

  const colours = ['#D4AF37', '#8B4513', '#4E342E', '#E9CE7C', '#1F7A5C', '#A8862A'];
  const n = count || 90;
  let html = '';
  for (let i = 0; i < n; i++) {
    const left = Math.random() * 100;
    const delay = Math.random() * 2.2;
    const dur = 3.4 + Math.random() * 2.6;
    const c = colours[i % colours.length];
    const w = 6 + Math.random() * 6;
    const round = Math.random() > 0.75 ? '50%' : '2px';
    html += `<i class="confetti" style="left:${left}%;background:${c};width:${w}px;
      height:${w * 1.7}px;border-radius:${round};
      animation-delay:${delay}s;animation-duration:${dur}s"></i>`;
  }
  host.innerHTML = html;
  setTimeout(() => host.remove(), (n ? 8000 : 0));
};

/* Failsafe: whatever happens with IntersectionObserver, nothing stays invisible.
   After 2.5s any un-revealed block is shown. */
(function () {
  var force = function () {
    document.querySelectorAll('.reveal-up:not(.seen)').forEach(function (el) { el.classList.add('seen'); });
    document.querySelectorAll('.reveal:not(.in)').forEach(function (el) { el.classList.add('in'); });
  };
  setTimeout(force, 2500);
  window.addEventListener('load', function () { setTimeout(force, 1800); });
})();
