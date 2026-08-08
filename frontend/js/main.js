'use strict';

const API = location.origin + '/api';

async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  const token = localStorage.getItem('pb_token');
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

const rupee = n => '\u20b9' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Shared input validators ---------- */
const Validate = {
  name: v => /^[A-Za-z][A-Za-z .'-]*$/.test(String(v || '').trim()) && String(v || '').trim().length >= 2,
  phone: v => /^[6-9]\d{9}$/.test(String(v || '').replace(/\D/g, '')),
  gmail: v => /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(String(v || '').trim().toLowerCase()),
  pincode: v => /^\d{6}$/.test(String(v || '').trim()),
};
// Attach live validation to an input: strips invalid chars as the user types.
function liveFilter(el, kind) {
  if (!el) return;
  el.addEventListener('input', () => {
    if (kind === 'name') el.value = el.value.replace(/[^A-Za-z .'-]/g, '');
    if (kind === 'phone') el.value = el.value.replace(/\D/g, '').slice(0, 10);
    if (kind === 'pincode') el.value = el.value.replace(/\D/g, '').slice(0, 6);
  });
}

const Cart = {
  read() { try { return JSON.parse(localStorage.getItem('pb_cart') || '[]'); } catch { return []; } },
  write(v) { localStorage.setItem('pb_cart', JSON.stringify(v)); Cart.paint(); },
  add(product, qty = 1) {
    const cart = Cart.read();
    const hit = cart.find(i => i.id === product.id);
    if (hit) hit.qty += qty;
    else cart.push({ id: product.id, name: product.name, price: Number(product.offer_price || product.price),
      image: product.image || '', weight: product.weight || '', stock: product.stock, qty });
    Cart.write(cart);
    toast(`${product.name} added to cart`, 'ok');
  },
  setQty(id, qty) {
    let cart = Cart.read();
    if (qty <= 0) cart = cart.filter(i => i.id !== id);
    else { const hit = cart.find(i => i.id === id); if (hit) hit.qty = Math.min(qty, hit.stock ?? 99); }
    Cart.write(cart);
  },
  remove(id) { Cart.write(Cart.read().filter(i => i.id !== id)); },
  clear() { localStorage.removeItem('pb_cart'); Cart.paint(); },
  count() { return Cart.read().reduce((s, i) => s + i.qty, 0); },
  subtotal() { return Cart.read().reduce((s, i) => s + i.price * i.qty, 0); },
  paint() {
    const n = Cart.count();
    document.querySelectorAll('#cartCount').forEach(b => { b.textContent = n; b.classList.toggle('hide', n === 0); });
    if (typeof renderCartDrawer === 'function') renderCartDrawer();
  },
};

const Auth = {
  user() { try { return JSON.parse(localStorage.getItem('pb_user') || 'null'); } catch { return null; } },
  save(token, user) { localStorage.setItem('pb_token', token); localStorage.setItem('pb_user', JSON.stringify(user)); },
  logout() { localStorage.removeItem('pb_token'); localStorage.removeItem('pb_user'); location.href = '/'; },
};

function productImage(p) {
  if (p.image) return `<img src="${esc(p.image)}" alt="${esc(p.name)}" onerror="this.parentElement.innerHTML=placeholderHTML()">`;
  return placeholderHTML();
}
function placeholderHTML() {
  return `<div class="img-placeholder"><div class="ph-icon">\ud83c\udf70</div><div>PHOTO COMING SOON</div></div>`;
}

/* Presentation-only badge derivation. Reads fields the product already has —
   nothing is written, no request is made, and the ranking is purely visual.
   Only the single highest-priority badge is shown so cards stay clean. */
function productBadge(p) {
  const out = p.stock <= 0 || !p.is_available;
  if (out) return { label: 'Sold out', cls: 'badge-out' };

  const hasOffer = p.offer_price && Number(p.offer_price) < Number(p.price);
  if (hasOffer) {
    const off = Math.round((1 - p.offer_price / p.price) * 100);
    return { label: `${off}% off`, cls: 'badge-off' };
  }
  if (p.is_featured) return { label: 'Best seller', cls: 'badge-best' };

  // "New" means added in the last three weeks.
  if (p.created_at) {
    const age = (Date.now() - new Date(p.created_at).getTime()) / 86400000;
    if (age >= 0 && age <= 21) return { label: 'New', cls: 'badge-new' };
  }
  if (p.is_trending) return { label: 'Popular', cls: 'badge-pop' };
  return null;
}

function productCard(p) {
  const hasOffer = p.offer_price && Number(p.offer_price) < Number(p.price);
  const off = hasOffer ? Math.round((1 - p.offer_price / p.price) * 100) : 0;
  const out = p.stock <= 0 || !p.is_available;
  const low = !out && p.stock <= (p.low_stock_at || 5);
  const payload = JSON.stringify(p).replace(/'/g, "&#39;");
  const stars = (typeof UI !== 'undefined' && p.review_count > 0)
    ? UI.stars(p.rating, p.review_count) : '';
  const badge = productBadge(p);
  return `
  <div class="card">
    <a href="/product.html?id=${p.id}" class="card-img">
      ${productImage(p)}
      ${badge ? `<span class="pbadge ${badge.cls}">${badge.label}</span>` : ''}
      ${p.is_eggless ? '<span class="pbadge badge-veg">Eggless</span>' : ''}
    </a>
    <button class="wish" type="button" data-wid="${p.id}" aria-label="Save to wishlist"
      onclick="event.preventDefault();UI.wish.toggle('${p.id}',this)">&#9825;</button>
    <div class="card-body">
      <div class="card-cat">${esc(p.category)}</div>
      <a href="/product.html?id=${p.id}" class="card-name">${esc(p.name)}</a>
      ${p.weight ? `<div class="card-meta">${esc(p.weight)} \u00b7 ${p.prep_minutes || 30} min prep</div>` : ''}
      ${stars}
      <div class="price-row">
        <span class="price">${rupee(p.offer_price || p.price)}</span>
        ${hasOffer ? `<span class="price-old">${rupee(p.price)}</span><span class="price-off">Save ${off}%</span>` : ''}
      </div>
      ${out ? '<div class="stock-note stock-out">Back soon</div>' : low ? `<div class="stock-note stock-low">Only ${p.stock} left today</div>` : ''}
      <div class="card-foot">
        ${out
          ? '<button class="btn btn-outline btn-block btn-sm" disabled>Sold out</button>'
          : `<div class="card-btns"><button class="btn btn-primary btn-cart" onclick='Cart.add(${payload})'><span>Add to cart</span></button><button class="btn btn-outline btn-sm btn-buy" onclick='Cart.add(${payload});location.href="/checkout.html"'>Buy now</button></div>`}
      </div>
    </div>
  </div>`;
}

function renderCartDrawer() {
  const body = document.getElementById('cartBody');
  const foot = document.getElementById('cartFoot');
  if (!body) return;
  const items = Cart.read();
  if (!items.length) {
    body.innerHTML = `<div class="empty"><div class="ei">\ud83e\uddc1</div>
      <p>Nothing in your box yet.<br>Today's batch is still warm.</p>
      <a href="/menu.html" class="btn btn-primary btn-sm" style="margin-top:18px">Browse the menu</a></div>`;
    if (foot) foot.classList.add('hide');
    return;
  }
  body.innerHTML = items.map(i => `
    <div class="cart-item">
      <div class="cart-thumb">${i.image ? `<img src="${esc(i.image)}" alt="">` : '\ud83c\udf70'}</div>
      <div class="cart-info">
        <h4>${esc(i.name)}</h4>
        ${i.weight ? `<div class="card-meta">${esc(i.weight)}</div>` : ''}
        <div class="p">${rupee(i.price)}</div>
        <div class="qty">
          <button aria-label="Decrease quantity" onclick="Cart.setQty('${i.id}', ${i.qty - 1})">\u2212</button>
          <span>${i.qty}</span>
          <button aria-label="Increase quantity" onclick="Cart.setQty('${i.id}', ${i.qty + 1})">+</button>
        </div>
      </div>
      <button class="icon-btn" style="width:32px;height:32px;font-size:14px;border-radius:10px;align-self:flex-start"
        onclick="Cart.remove('${i.id}')" title="Remove" aria-label="Remove ${esc(i.name)}">\u2715</button>
    </div>`).join('');
  if (foot) {
    foot.classList.remove('hide');
    foot.innerHTML = `
      <div class="sum-row"><span>Subtotal</span><span>${rupee(Cart.subtotal())}</span></div>
      <div class="sum-row"><span>Delivery</span><span style="color:var(--ink-faint)">Calculated at checkout</span></div>
      <div class="sum-row total"><span>Total</span><b>${rupee(Cart.subtotal())}</b></div>
      <a href="/checkout.html" class="btn btn-primary btn-block" style="margin-top:16px">Checkout</a>`;
    if (typeof UI !== 'undefined') UI.paintDeliveryMeter();
  }
}

/* Account dropdown — the user icon opens a small menu (name, quick links,
   log out) instead of logging out on a single click. */
function toggleAccountMenu(e) {
  e && e.stopPropagation();
  const menu = document.getElementById('acctMenu');
  if (!menu) return;
  menu.classList.toggle('show');
}
document.addEventListener('click', e => {
  const wrap = document.getElementById('acctWrap');
  if (!wrap) return;
  if (!wrap.contains(e.target)) document.getElementById('acctMenu')?.classList.remove('show');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('acctMenu')?.classList.remove('show'); });

/* Mobile nav dropdown — tapping anywhere outside the open menu (or its
   hamburger toggle) closes it, same as the account menu above. */
document.addEventListener('click', e => {
  const links = document.getElementById('navLinks');
  if (!links || !links.classList.contains('open')) return;
  const toggle = e.target.closest('.hamburger');
  if (links.contains(e.target) || toggle) return;
  links.classList.remove('open');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('navLinks')?.classList.remove('open'); });

function toggleCart(open) {
  const d = document.getElementById('cartDrawer');
  const o = document.getElementById('overlay');
  if (!d) return;
  const show = open ?? !d.classList.contains('show');
  d.classList.toggle('show', show);
  o?.classList.toggle('show', show);
  document.body.style.overflow = show ? 'hidden' : '';
}

function mountShell(active = '') {
  const user = Auth.user();
  const nav = `
  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="logo">
        <div class="logo-mark" id="logoMark">PB</div>
        <div class="logo-text">PB Bake House<small>FRESHLY BAKED</small></div>
      </a>
      <div class="nav-links" id="navLinks">
        <a href="/" class="${active === 'home' ? 'active' : ''}">Home</a>
        <a href="/menu.html" class="${active === 'menu' ? 'active' : ''}">Menu</a>
        <a href="/custom-cakes.html" class="${active === 'custom' ? 'active' : ''}">Custom Cakes</a>
        <a href="/track.html" class="${active === 'track' ? 'active' : ''}">Track Order</a>
        <a href="/about.html" class="${active === 'about' ? 'active' : ''}">About</a>
      </div>
      <div class="nav-actions">
        ${user ? `<div class="acct-wrap" id="acctWrap">
          <button class="icon-btn" onclick="toggleAccountMenu(event)" title="${esc(user.name)}" aria-label="Account menu" aria-haspopup="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </button>
          <div class="acct-menu" id="acctMenu">
            <div class="acct-menu-head"><b>${esc(user.name)}</b>${user.email ? `<span>${esc(user.email)}</span>` : ''}</div>
            <a href="/track.html">Track my orders</a>
            <a href="/menu.html?favourites=1">My favourites</a>
            <button type="button" onclick="Auth.logout()">Log out</button>
          </div>
        </div>`
               : `<a href="/login.html" class="btn btn-primary btn-sm" style="min-height:44px">Sign in</a>`}
        <button class="icon-btn" onclick="toggleCart(true)" title="Cart" aria-label="Open cart">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
          <span class="badge hide" id="cartCount">0</span>
        </button>
        <button class="icon-btn hamburger" onclick="document.getElementById('navLinks').classList.toggle('open')" aria-label="Menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </button>
      </div>
    </div>
  </nav>
  <div class="overlay" id="overlay" onclick="toggleCart(false)"></div>
  <aside class="drawer" id="cartDrawer">
    <div class="drawer-head"><h3>Your box</h3><button class="icon-btn" onclick="toggleCart(false)" aria-label="Close cart">\u2715</button></div>
    <div class="drawer-body" id="cartBody"></div>
    <div class="drawer-foot hide" id="cartFoot"></div>
  </aside>`;

  const footer = `
  <footer class="footer">
    <div class="container footer-grid">
      <div>
        <div class="logo" style="margin-bottom:18px">
          <div class="logo-mark" id="logoMarkFooter">PB</div>
          <div class="logo-text">PB Bake House<small>FRESHLY BAKED</small></div>
        </div>
        <p>A neighbourhood bakery in Girinagar, Bengaluru. Everything is eggless, everything is baked the morning it reaches you.</p>
        <h5 style="margin-top:26px">New bakes, first</h5>
        <p style="margin-bottom:10px">Tell us where to send the weekly menu.</p>
        <div class="news-form">
          <input id="newsEmail" type="email" placeholder="you@gmail.com" aria-label="Your email">
          <button type="button" onclick="joinList()" aria-label="Join the list">\u2192</button>
        </div>
        <div class="foot-socials">
          <a id="footWa" href="#" target="_blank" rel="noopener" aria-label="WhatsApp">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.6.2-.2.3-.7 1-.9 1.1-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5C9.7 8.6 9.2 7.2 9 6.6c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 5 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.5A10 10 0 1 0 12 2z"/></svg>
          </a>
          <a id="footIg" href="#" target="_blank" rel="noopener" aria-label="Instagram">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.68A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 16 12a4 4 0 0 1-4 4zm6.4-10.4a1.44 1.44 0 1 0 1.44 1.44 1.44 1.44 0 0 0-1.44-1.44z"/></svg>
          </a>
          <a id="footLoc" href="#" target="_blank" rel="noopener" aria-label="Find us">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>
          </a>
        </div>
      </div>

      <div><h5>Shop</h5>
        <a href="/menu.html">Everything</a><a href="/custom-cakes.html">Custom cakes</a><a href="/menu.html?category=Cakes">Cakes</a>
        <a href="/menu.html?category=Pastries">Pastries</a><a href="/menu.html?category=Breads">Breads</a>
        <a href="/menu.html?category=Cookies">Cookies</a>
      </div>

      <div><h5>Help</h5>
        <a href="/track.html">Track an order</a><a href="/about.html">About us</a>
        <a href="/about.html#contact">Contact</a><a href="/login.html">Your account</a>
        <h5 style="margin-top:26px">Kitchen hours</h5>
        <div class="foot-hours"><b>Mon \u2013 Sat</b><span>7:00 \u2013 21:30</span></div>
        <div class="foot-hours"><b>Sunday</b><span>8:00 \u2013 21:00</span></div>
      </div>

      <div><h5>Find us</h5>
        <p id="footAddress">Address coming soon</p>
        <p id="footDelivery">Base \u20b940 up to 2 km \u00b7 \u20b910 per extra km</p>
        <div class="foot-map" id="footMap"></div>
      </div>
    </div>
    <div class="footer-bot">\u00a9 ${new Date().getFullYear()} PB Bake House \u00b7 100% eggless, 100% vegetarian
      <div class="made-by">Made by <a href="#" id="madeByLink" target="_blank" rel="noopener">TrionCode Solutions</a></div>
    </div>
  </footer>`;

  document.body.insertAdjacentHTML('afterbegin', nav);
  document.body.insertAdjacentHTML('beforeend', footer);

  // Floating contact buttons — visible on every page, animate in on scroll.
  const fab = `
  <div class="fab-stack" id="fabStack">
    <a class="fab fab-call" id="fabCall" href="tel:8971727805" aria-label="Call PB Bake House">
      <svg viewBox="0 0 24 24" width="25" height="25" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.7.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.7.1.3 0 .7-.2 1l-2.3 2.1z"/></svg>
      <span class="fab-tip">Call us</span>
    </a>
    <a class="fab fab-insta" id="fabInsta" href="#" target="_blank" rel="noopener" aria-label="Instagram">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.68A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 16 12a4 4 0 0 1-4 4zm6.4-10.4a1.44 1.44 0 1 0 1.44 1.44 1.44 1.44 0 0 0-1.44-1.44z"/></svg>
      <span class="fab-tip">Follow &amp; get 10% off</span>
    </a>
    <a class="fab fab-wa" id="fabWa" href="#" target="_blank" rel="noopener" aria-label="WhatsApp">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.6.2-.2.3-.7 1-.9 1.1-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5C9.7 8.6 9.2 7.2 9 6.6c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 5 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.5A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-2.9.9.9-2.8-.2-.3a8.2 8.2 0 1 1 6.7 3.4z"/></svg>
      <span class="fab-tip">Order on WhatsApp</span>
    </a>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', fab);

  Cart.paint();
  applyLogo();
  initScrollReveal();
  loadSiteConfig();

  // Scroll-reveal for the floating stack.
  const stack = document.getElementById('fabStack');
  let lastY = 0;
  const onScroll = () => {
    const y = window.scrollY;
    stack.classList.toggle('fab-visible', y > 120);
    lastY = y;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  setTimeout(() => stack.classList.add('fab-visible'), 700);
  setTimeout(onScroll, 400);
}

// Fade sections up as they scroll into view (professional, subtle).
function initScrollReveal() {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
  // Observe main content blocks
  setTimeout(() => {
    document.querySelectorAll('.section, .feature, .partner, .val, .insta-cta').forEach(el => {
      el.classList.add('reveal-up'); io.observe(el);
    });
  }, 60);
}

// Swap the "PB" placeholder for your real logo.
// Drop your file in frontend/images/ as logo.png / .jpg / .jpeg / .webp / .svg
const LOGO_CANDIDATES = ['/images/logo.png','/images/logo.jpg','/images/logo.jpeg','/images/logo.webp','/images/logo.svg'];
function applyLogo(list = LOGO_CANDIDATES) {
  if (!list.length) return;                       // none found -> keep "PB" text
  const [url, ...rest] = list;
  const img = new Image();
  img.onload = () => {
    document.querySelectorAll('#logoMark, #logoMarkFooter').forEach(el => {
      el.innerHTML = `<img src="${url}" alt="PB Bake House logo">`;
      el.classList.add('has-logo');
    });
    let link = document.querySelector("link[rel='icon']");
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = url;
  };
  img.onerror = () => applyLogo(rest);            // try next extension
  img.src = url;
}

// Single source of truth for social/payment/promo config across all pages.
let SITE = null;

/* Footer list sign-up. There is no mailing-list endpoint, so this opens
   WhatsApp with the address pre-typed — a real message, not a dead form. */
function joinList() {
  const el = document.getElementById('newsEmail');
  const val = (el?.value || '').trim();
  if (!Validate.gmail(val)) return toast('Enter a valid @gmail.com address', 'err');
  const phone = (SITE && SITE.whatsapp) || '';
  if (!phone) return toast('List sign-up is unavailable right now', 'err');
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent('Hi! Please add ' + val + ' to your new-bake list.')}`, '_blank', 'noopener');
  el.value = '';
  toast('Opening WhatsApp to confirm', 'ok');
}

// Trust bar uses pure CSS hover (zoom + glow) — no cursor-follow circle.
function initTrustBarCursor() { /* hover handled in CSS */ }

async function loadSiteConfig() {
  try {
    const { config } = await api('/site-config');
    SITE = config; window.SITE = config;
    const wa = document.getElementById('fabWa');
    const insta = document.getElementById('fabInsta');
    const call = document.getElementById('fabCall');
    if (wa) wa.href = `https://wa.me/${config.whatsapp}?text=${encodeURIComponent('Hi PB Bake House! I would like to order.')}`;
    if (insta) insta.href = config.instagram || '#';
    if (call && config.contact_phone) call.href = 'tel:' + config.contact_phone;
    const d = document.getElementById('footDelivery');
    const a = document.getElementById('footAddress');
    if (d) d.innerHTML = `Base ${rupee(config.delivery.base_fare)} up to ${config.delivery.base_km} km \u00b7 ${rupee(config.delivery.per_extra_km)} per extra km<br><b style="color:var(--gold)">Free above ${rupee(config.delivery.free_above)} within ${config.delivery.free_within_km} km</b>`;
    if (a && config.bakery_address) a.innerHTML = `<a href="${config.maps_url}" target="_blank" rel="noopener">${esc(config.bakery_address)}</a>`;

    /* Footer social row + embedded map — presentation only. */
    const fw = document.getElementById('footWa');
    const fi = document.getElementById('footIg');
    const fl = document.getElementById('footLoc');
    if (fw) fw.href = `https://wa.me/${config.whatsapp}?text=${encodeURIComponent('Hi PB Bake House! I would like to order.')}`;
    if (fi) fi.href = config.instagram || '#';
    if (fl) fl.href = config.maps_url || '#';
    const fm = document.getElementById('footMap');
    if (fm && !fm.dataset.on && config.bakery_lat && config.bakery_lng) {
      fm.dataset.on = '1';
      const la = Number(config.bakery_lat), ln = Number(config.bakery_lng), pad = 0.006;
      fm.innerHTML = `<iframe loading="lazy" title="PB Bake House on the map" src="https://www.openstreetmap.org/export/embed.html?bbox=${ln - pad}%2C${la - pad}%2C${ln + pad}%2C${la + pad}&layer=mapnik&marker=${la}%2C${ln}"></iframe>`;
    }
    const mb = document.getElementById('madeByLink');
    if (mb && config.developer_url) mb.href = config.developer_url;
    document.dispatchEvent(new CustomEvent('siteconfig', { detail: config }));
    initTrustBarCursor();
  } catch (e) { /* silent */ }
}
