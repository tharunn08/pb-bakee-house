'use strict';

const API = location.origin + '/api';
let TOKEN = localStorage.getItem('pb_admin_token') || '';
let ME = null;
let socket = null;
let alertQueue = [];

/* ---------- API HELPER ---------- */
async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (TOKEN) opts.headers.Authorization = `Bearer ${TOKEN}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + path, opts);
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : await res.blob();
  if (!res.ok || (isJson && data.success === false)) throw new Error((data && data.message) || `Request failed (${res.status})`);
  return data;
}

/* ---------- UTILS ---------- */
const rupee = n => '\u20b9' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = d => {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};
const STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'];
const statusBadge = s => `<span class="badge b-${s}">${s.replace(/_/g, ' ')}</span>`;

function toast(msg, kind = '') {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------- ALERT SOUND (WebAudio siren, no asset needed) ---------- */
let audioCtx = null;
let alarmLoop = null;
let audioUnlocked = false;

function ensureAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    audioUnlocked = true;
  } catch (e) { /* not allowed yet */ }
}

// One urgent, LOUD multi-tone burst (like Swiggy/Zomato order alert).
function alarmBurst() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  let t = audioCtx.currentTime;
  const notes = [1046, 1318, 1046, 1318, 1568, 1046];
  for (let i = 0; i < notes.length; i++) {
    // Two oscillators per note (fundamental + fifth) for a fuller, louder tone.
    [notes[i], notes[i] * 1.5].forEach((freq, k) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = k === 0 ? 'square' : 'triangle';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(k === 0 ? 0.85 : 0.4, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.30);
    });
    t += 0.30;
  }
}

// Play the alarm and keep repeating until dismissed (grabs attention if the
// owner stepped away). Falls back to an <audio> element if WebAudio is blocked.
function playAlert(loop = true) {
  ensureAudio();
  alarmBurst();
  const el = document.getElementById('alertSound');
  if (el) { el.currentTime = 0; el.play().catch(() => {}); }
  if (loop) {
    stopAlarm();
    // Rings INDEFINITELY until the admin accepts or rejects the order.
    alarmLoop = setInterval(() => {
      alarmBurst();
      if (el) { el.currentTime = 0; el.play().catch(() => {}); }
    }, 1800);
  }
}

function stopAlarm() {
  if (alarmLoop) { clearInterval(alarmLoop); alarmLoop = null; }
}

/* ---------- AUTH ---------- */
async function doLogin() {
  const btn = document.getElementById('loginBtn');
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) return toast('Enter email and password', 'err');
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const res = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.message || 'Login failed');
    if (!['staff', 'manager', 'owner'].includes(data.user.role)) throw new Error('This account does not have staff access');
    TOKEN = data.token; ME = data.user;
    localStorage.setItem('pb_admin_token', TOKEN);
    ensureAudio(); // unlock audio on this user gesture so order alerts can play
    bootApp();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Sign In'; }
}

function logout() {
  localStorage.removeItem('pb_admin_token');
  TOKEN = ''; ME = null;
  if (socket) { socket.disconnect(); socket = null; }
  document.getElementById('appView').classList.add('hide');
  document.getElementById('loginView').classList.remove('hide');
}

document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

/* ---------- NAV ---------- */
const NAV = [
  { sec: 'MAIN' },
  { id: 'dashboard', icon: '\ud83d\udcca', label: 'Dashboard' },
  { id: 'orders', icon: '\ud83d\udce6', label: 'Orders' },
  { id: 'kitchen', icon: '\ud83d\udc68\u200d\ud83c\udf73', label: 'Kitchen Mode' },
  { id: 'deliveries', icon: '\ud83d\udef5', label: 'Deliveries' },
  { sec: 'CATALOG' },
  { id: 'products', icon: '\ud83c\udf70', label: 'Products' },
  { id: 'coupons', icon: '\ud83c\udff7\ufe0f', label: 'Coupons' },
  { id: 'banners', icon: '\ud83d\uddbc\ufe0f', label: 'Banners' },
  { id: 'reviews', icon: '\u2b50', label: 'Reviews' },
  { sec: 'INSIGHTS' },
  { id: 'analytics', icon: '\ud83d\udcc8', label: 'Analytics' },
  { id: 'customers', icon: '\ud83d\udc65', label: 'Customers' },
  { id: 'reports', icon: '\ud83d\udcc4', label: 'Reports' },
  { sec: 'SYSTEM' },
  { id: 'notifications', icon: '\ud83d\udd14', label: 'Notifications' },
  { id: 'expenses', icon: '\ud83d\udcb0', label: 'Expenses' },
  { id: 'audit', icon: '\ud83d\udcdc', label: 'Audit Log', roles: ['owner', 'manager'] },
  { id: 'staff', icon: '\ud83d\udd11', label: 'Staff', roles: ['owner'] },
  { id: 'backup', icon: '\ud83d\udcbe', label: 'Backup', roles: ['owner'] },
];

function buildNav() {
  const menu = document.getElementById('navMenu');
  menu.innerHTML = NAV.map(n => {
    if (n.sec) return `<div class="nav-sec">${n.sec}</div>`;
    if (n.roles && !n.roles.includes(ME.role)) return '';
    return `<div class="nav-item" data-page="${n.id}" onclick="go('${n.id}')">
      <span class="ic">${n.icon}</span><span>${n.label}</span>
      ${n.id === 'notifications' ? '<span class="nav-badge hide" id="navNotif">0</span>' : ''}
    </div>`;
  }).join('');
}

let currentPage = 'dashboard';
function go(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === page));
  document.getElementById('sidebar').classList.remove('open');
  const found = NAV.find(n => n.id === page);
  document.getElementById('pageTitle').textContent = found ? found.label : 'Dashboard';
  RENDER[page] ? RENDER[page]() : (document.getElementById('content').innerHTML = '<div class="empty">Page not found</div>');
}

/* ---------- BOOT ---------- */
async function bootApp() {
  try {
    const me = await api('/auth/me');
    ME = me.user;
    if (!['staff', 'manager', 'owner'].includes(ME.role)) return logout();
  } catch { return logout(); }
  document.getElementById('loginView').classList.add('hide');
  document.getElementById('appView').classList.remove('hide');
  document.getElementById('avatar').textContent = (ME.name || 'A')[0].toUpperCase();
  buildNav();
  bindSearch();
  connectSocket();
  go('dashboard');
  refreshNotifBadge();
}

/* ---------- SOCKET.IO REAL-TIME ---------- */
function connectSocket() {
  socket = io();
  socket.on('connect', () => socket.emit('join_admin', TOKEN));
  socket.on('joined', () => console.log('Live alerts connected'));
  socket.on('new_order', order => {
    playAlert();
    alertQueue.push(order);
    showNextAlert();
    refreshNotifBadge();
    if (currentPage === 'dashboard' || currentPage === 'orders' || currentPage === 'kitchen') go(currentPage);
  });
  socket.on('notification', () => refreshNotifBadge());
  socket.on('order_updated', () => {
    if (['dashboard', 'orders', 'kitchen', 'deliveries'].includes(currentPage)) go(currentPage);
  });
}

function showNextAlert() {
  if (!alertQueue.length) return;
  const o = alertQueue[0];
  document.getElementById('alertAmt').textContent = rupee(o.total);
  document.getElementById('alertMeta').innerHTML =
    `<b>#${esc(o.order_no)}</b> &middot; ${esc(o.customer_name)}<br>${esc(o.customer_phone)} &middot; ${o.order_type === 'pickup' ? 'Pickup' : o.distance_km + ' km delivery'}`;
  const items = o.items || [];
  document.getElementById('alertItems').innerHTML = items.length
    ? items.map(i => `<div class="ai-row"><span>${esc(i.name)} × ${i.qty}</span><span>${rupee(i.price * i.qty)}</span></div>`).join('')
    : '';
  document.getElementById('alertBg').classList.add('show');
}

async function acceptOrder() {
  const o = alertQueue[0];
  if (!o) return;
  stopAlarm();
  try {
    await api(`/orders/${o.id || o.order_no}/status`, { method: 'PATCH', body: { status: 'accepted' } });
    toast(`Order #${o.order_no} accepted`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  clearCurrentAlert();
}

async function rejectOrder() {
  const o = alertQueue[0];
  if (!o) return;
  if (!confirm(`Reject and cancel order #${o.order_no}? This will restock the items.`)) return;
  stopAlarm();
  try {
    await api(`/orders/${o.id || o.order_no}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
    toast(`Order #${o.order_no} rejected`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  clearCurrentAlert();
}

function viewAlertOrder() {
  const o = alertQueue[0];
  stopAlarm();
  clearCurrentAlert();
  if (o) { go('orders'); setTimeout(() => openOrder(o.id || o.order_no), 200); }
}

function clearCurrentAlert() {
  stopAlarm();
  alertQueue.shift();
  document.getElementById('alertBg').classList.remove('show');
  if (['dashboard', 'orders', 'kitchen', 'deliveries'].includes(currentPage)) go(currentPage);
  if (alertQueue.length) setTimeout(showNextAlert, 500);
}

async function refreshNotifBadge() {
  try {
    const { unread } = await api('/admin/notifications');
    ['notifBadge', 'navNotif'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = unread; el.classList.toggle('hide', unread === 0); }
    });
  } catch { /* ignore */ }
}

/* ---------- MODAL ---------- */
function openModal(title, body, footer = '') {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = body;
  document.getElementById('modalFoot').innerHTML = footer;
  document.getElementById('modalBg').classList.add('show');
}
function closeModal() { document.getElementById('modalBg').classList.remove('show'); }
document.getElementById('modalBg').addEventListener('click', e => { if (e.target.id === 'modalBg') closeModal(); });

/* ---------- GLOBAL SEARCH ---------- */
let searchTimer;
async function runGlobalSearch(q) {
  const box = document.getElementById('searchResults');
  if (!box) return;
  if (!q) { box.classList.add('hide'); return; }
  box.innerHTML = '<div class="sr-item">Searching…</div>';
  box.classList.remove('hide');
  try {
    const r = await api('/admin/search?q=' + encodeURIComponent(q));
    let html = '';
    if (r.orders.length) html += `<div class="sr-group"><h5>ORDERS</h5>${r.orders.map(o => `<div class="sr-item" onclick="go('orders');setTimeout(()=>openOrder('${o.id}'),200);hideSearch()"><span>#${esc(o.order_no)} · ${esc(o.customer_name)}</span><span>${statusBadge(o.status)}</span></div>`).join('')}</div>`;
    if (r.products.length) html += `<div class="sr-group"><h5>PRODUCTS</h5>${r.products.map(p => `<div class="sr-item" onclick="go('products');hideSearch()"><span>${esc(p.name)}</span><span>${rupee(p.offer_price || p.price)}</span></div>`).join('')}</div>`;
    if (r.customers.length) html += `<div class="sr-group"><h5>CUSTOMERS</h5>${r.customers.map(c => `<div class="sr-item" onclick="go('customers');hideSearch()"><span>${esc(c.name)}</span><span>${c.orders} orders</span></div>`).join('')}</div>`;
    box.innerHTML = html || '<div class="sr-item">No results found</div>';
    box.classList.remove('hide');
  } catch (e) { box.innerHTML = `<div class="sr-item">${esc(e.message)}</div>`; }
}

function bindSearch() {
  const gs = document.getElementById('globalSearch');
  if (!gs || gs.dataset.bound) return;
  gs.dataset.bound = '1';
  gs.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runGlobalSearch(gs.value.trim()), 250);
  });
  gs.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); runGlobalSearch(gs.value.trim()); }
    if (e.key === 'Escape') hideSearch();
  });
  const icon = document.getElementById('searchIcon');
  if (icon) {
    icon.addEventListener('click', () => runGlobalSearch(gs.value.trim()));
    icon.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runGlobalSearch(gs.value.trim()); }
    });
  }
}
function hideSearch() {
  const box = document.getElementById('searchResults');
  const gs = document.getElementById('globalSearch');
  if (box) box.classList.add('hide');
  if (gs) gs.value = '';
}
document.addEventListener('click', e => {
  if (!e.target.closest('.search-box')) {
    const box = document.getElementById('searchResults');
    if (box) box.classList.add('hide');
  }
});

/* RENDER map is populated in admin.pages.js sections below */
const RENDER = {};

/* ---------- INIT ---------- */
if (TOKEN) bootApp();

/* ======================= DASHBOARD ======================= */
RENDER.dashboard = async function () {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="empty">Loading dashboard...</div>';
  try {
    const d = await api('/admin/dashboard');
    const t = d.today;
    const change = d.revenue_change_pct;
    const changeHtml = change === null ? '<span class="sub">vs yesterday</span>'
      : `<span class="sub"><span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '\u25b2' : '\u25bc'} ${Math.abs(change)}%</span> vs yesterday</span>`;
    c.innerHTML = `
      <div class="stat-grid">
        <div class="stat accent-blue"><div class="label">Today's Revenue</div><div class="value">${rupee(t.revenue)}</div>${changeHtml}</div>
        <div class="stat accent-red"><div class="label">Today's Orders</div><div class="value">${t.orders}</div><div class="sub">${t.pending} pending now</div></div>
        <div class="stat accent-warn"><div class="label">In Kitchen</div><div class="value">${Number(t.accepted) + Number(t.preparing)}</div><div class="sub">${t.preparing} preparing, ${t.ready} ready</div></div>
        <div class="stat accent-ok"><div class="label">This Month</div><div class="value">${rupee(d.month.revenue)}</div><div class="sub">${d.month.orders} orders</div></div>
      </div>

      <div class="pill-row">
        <div class="pill"><span class="d" style="background:var(--warn)"></span>Pending <b>${t.pending}</b></div>
        <div class="pill"><span class="d" style="background:var(--blue)"></span>Accepted <b>${t.accepted}</b></div>
        <div class="pill"><span class="d" style="background:var(--blue-dark)"></span>Preparing <b>${t.preparing}</b></div>
        <div class="pill"><span class="d" style="background:var(--ok)"></span>Ready <b>${t.ready}</b></div>
        <div class="pill"><span class="d" style="background:var(--gold-deep)"></span>Out for delivery <b>${t.out_for_delivery}</b></div>
        <div class="pill"><span class="d" style="background:var(--forest)"></span>Delivered <b>${t.delivered}</b></div>
        <div class="pill"><span class="d" style="background:var(--red)"></span>Cancelled <b>${t.cancelled}</b></div>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-h"><h3>Recent Orders</h3><button class="btn btn-outline btn-sm" onclick="go('orders')">View All</button></div>
          <div class="card-b flush t-wrap">
            <table><thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Time</th></tr></thead><tbody>
            ${d.recent_orders.length ? d.recent_orders.map(o => `
              <tr style="cursor:pointer" onclick="go('orders');setTimeout(()=>openOrder('${o.id}'),200)">
                <td><b>#${esc(o.order_no)}</b></td><td>${esc(o.customer_name)}</td>
                <td><b>${rupee(o.total)}</b></td><td>${statusBadge(o.status)}</td><td>${ago(o.created_at)}</td>
              </tr>`).join('') : '<tr><td colspan="5"><div class="empty">No orders yet today</div></td></tr>'}
            </tbody></table>
          </div>
        </div>

        <div>
          <div class="card">
            <div class="card-h"><h3>Top Sellers Today</h3></div>
            <div class="card-b mini-list">
              ${d.top_today.length ? d.top_today.map(p => `
                <div class="mi"><span class="thumb">${p.image ? `<img src="${esc(p.image)}" style="width:100%;height:100%;border-radius:8px;object-fit:cover">` : '\ud83c\udf70'}</span>
                <div style="flex:1"><b>${esc(p.name)}</b></div><b style="color:var(--blue)">${p.sold} sold</b></div>`).join('')
                : '<div class="empty" style="padding:20px">No sales yet today</div>'}
            </div>
          </div>
          <div class="card">
            <div class="card-h"><h3>Low Stock</h3><button class="btn btn-outline btn-sm" onclick="go('products')">Manage</button></div>
            <div class="card-b mini-list">
              ${d.low_stock.length ? d.low_stock.map(p => `
                <div class="mi"><span class="thumb">${p.image ? `<img src="${esc(p.image)}" style="width:100%;height:100%;border-radius:8px;object-fit:cover">` : '\ud83c\udf70'}</span>
                <div style="flex:1"><b>${esc(p.name)}</b><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (p.stock / (p.low_stock_at * 2 || 10)) * 100)}%;background:${p.stock <= 0 ? 'var(--red)' : 'var(--warn)'}"></div></div></div>
                <b style="color:${p.stock <= 0 ? 'var(--red)' : 'var(--warn)'}">${p.stock}</b></div>`).join('')
                : '<div class="empty" style="padding:20px">All stocked up \ud83c\udf89</div>'}
            </div>
          </div>
        </div>
      </div>`;
  } catch (e) { c.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

/* ======================= ORDERS ======================= */
let orderFilter = { status: 'all', date: 'today', from: '', to: '', search: '' };
/* Reusable date-filter bar used by Orders / Customers / Deliveries */
function dateFilterBar(prefix, onChange) {
  return `
    <div class="date-bar">
      <div class="date-presets">
        ${[['today','Today'],['yesterday','Yesterday'],['week','Last 7 Days'],['month','Last 30 Days'],['all','All Time']]
          .map(([v,l]) => `<button class="dpreset${v==='today'?' on':''}" data-v="${v}" onclick="${onChange}('${v}')">${l}</button>`).join('')}
      </div>
      <div class="date-range">
        <label>From</label><input type="date" id="${prefix}From">
        <label>To</label><input type="date" id="${prefix}To">
        <button class="btn btn-primary btn-sm" onclick="${onChange}('custom')">Apply</button>
      </div>
    </div>`;
}
function setPresetActive(v) {
  document.querySelectorAll('.dpreset').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}

RENDER.orders = async function () {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="card">
      <div class="card-h">
        <h3>Orders</h3>
        <button class="btn btn-ghost btn-sm" onclick="loadOrders()">\u21bb Refresh</button>
      </div>
      <div class="card-b" style="padding-bottom:0">
        ${dateFilterBar('of', 'setOrderDate')}
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0">
          <select class="status-select" id="ofStatus" onchange="orderFilter.status=this.value;loadOrders()">
            <option value="all">All Statuses</option>
            ${STATUSES.map(s => `<option value="${s}">${s.replace(/_/g, ' ')}</option>`).join('')}
          </select>
          <input class="status-select" id="ofSearch" placeholder="Search order / name / phone" style="flex:1;min-width:180px"
                 oninput="orderFilter.search=this.value;debouncedOrders()">
        </div>
        <div id="ordersSummary"></div>
      </div>
      <div class="card-b flush t-wrap" id="ordersTable"><div class="empty">Loading…</div></div>
    </div>`;
  orderFilter.date = 'today';
  loadOrders();
};

function setOrderDate(v) {
  if (v === 'custom') {
    const f = document.getElementById('ofFrom').value, t = document.getElementById('ofTo').value;
    if (!f || !t) return toast('Pick both From and To dates', 'err');
    orderFilter.date = ''; orderFilter.from = f; orderFilter.to = t;
    setPresetActive('');
  } else {
    orderFilter.date = v === 'all' ? 'all' : v; orderFilter.from = ''; orderFilter.to = '';
    setPresetActive(v);
  }
  loadOrders();
}
let ordersTimer;
function debouncedOrders() { clearTimeout(ordersTimer); ordersTimer = setTimeout(loadOrders, 350); }
async function loadOrders() {
  const el = document.getElementById('ordersTable');
  if (!el) return;
  const q = new URLSearchParams();
  if (orderFilter.status !== 'all') q.set('status', orderFilter.status);
  if (orderFilter.date && orderFilter.date !== 'all') q.set('date', orderFilter.date);
  if (orderFilter.from) q.set('from', orderFilter.from);
  if (orderFilter.to) q.set('to', orderFilter.to);
  if (orderFilter.search) q.set('search', orderFilter.search);
  try {
    const { orders, summary } = await api('/orders?' + q);
    const sEl = document.getElementById('ordersSummary');
    if (sEl && summary) sEl.innerHTML = `
      <div class="mini-stats">
        <div class="ms"><span>Orders</span><b>${summary.orders || 0}</b></div>
        <div class="ms"><span>Revenue</span><b>${rupee(summary.revenue)}</b></div>
        <div class="ms"><span>Active</span><b>${summary.active || 0}</b></div>
        <div class="ms"><span>Delivered</span><b>${summary.delivered || 0}</b></div>
        <div class="ms"><span>Cancelled</span><b>${summary.cancelled || 0}</b></div>
      </div>`;
    el.innerHTML = `<table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Type</th><th>Status</th><th>Time</th><th></th></tr></thead><tbody>
      ${orders.length ? orders.map(o => `
        <tr>
          <td><b>#${esc(o.order_no)}</b></td>
          <td>${esc(o.customer_name)}<br><span style="color:var(--ink-faint);font-size:12px">${esc(o.customer_phone)}</span></td>
          <td>${(o.items || []).reduce((s, i) => s + i.qty, 0)}</td>
          <td><b>${rupee(o.total)}</b></td>
          <td><span style="font-size:12.5px">${o.order_type === 'pickup' ? 'Pickup' : o.distance_km + ' km'}</span></td>
          <td>
            <select class="status-select b-${o.status}" onchange="changeStatus('${o.id}',this.value)">
              ${STATUSES.map(s => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}
            </select>
          </td>
          <td style="font-size:12.5px;color:var(--ink-faint)">${ago(o.created_at)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-outline btn-sm" onclick="openOrder('${o.id}')">View</button>
            <button class="btn btn-outline btn-sm" title="Print bill" onclick="printBill('${o.id}')">🖨️ Print</button>
          </td>
        </tr>`).join('') : '<tr><td colspan="8"><div class="empty">No orders found</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function changeStatus(id, status) {
  try { await api(`/orders/${id}/status`, { method: 'PATCH', body: { status } }); toast('Order status updated', 'ok'); loadOrders(); }
  catch (e) { toast(e.message, 'err'); loadOrders(); }
}
async function openOrder(id) {
  try {
    const { order: o, history } = await api('/orders/' + id);
    openModal(`Order #${o.order_no}`, `
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px">
        <div><div style="font-size:12px;color:var(--ink-faint)">STATUS</div>${statusBadge(o.status)}</div>
        <div style="text-align:right"><div style="font-size:12px;color:var(--ink-faint)">PLACED</div><b>${fmtDate(o.created_at)}</b></div>
      </div>
      <div class="card" style="box-shadow:none"><div class="card-b">
        <b>${esc(o.customer_name)}</b> &middot; <a href="tel:${esc(o.customer_phone)}" style="color:var(--blue)">${esc(o.customer_phone)}</a>
        ${o.customer_email ? `<br><span style="color:var(--ink-soft);font-size:13px">${esc(o.customer_email)}</span>` : ''}
        ${o.order_type === 'delivery' ? `<div style="margin-top:8px;font-size:13.5px;color:var(--ink-soft)">\ud83d\udccd ${esc(o.address_line)}, ${esc(o.city)} ${esc(o.pincode)} (${o.distance_km} km)${o.lat && o.lng ? ` <a href="https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}" target="_blank" style="color:var(--blue);font-weight:700;white-space:nowrap">🗺️ Navigate</a>` : ''}</div>` : '<div style="margin-top:8px">\ud83c\udfea Store Pickup</div>'}
        ${o.delivery_date ? `<div style="font-size:13.5px;margin-top:4px">\ud83d\uddd3\ufe0f ${o.delivery_date} ${esc(o.delivery_slot || '')}</div>` : ''}
        ${o.notes ? `<div style="margin-top:8px;padding:8px 10px;background:var(--cream);border-radius:8px;font-size:13.5px">\ud83d\udcdd ${esc(o.notes)}</div>` : ''}
      </div></div>
      <table style="margin:8px 0"><thead><tr><th>Item</th><th>Qty</th><th style="text-align:right">Amount</th></tr></thead><tbody>
        ${(o.items || []).map(i => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td style="text-align:right">${rupee(i.price * i.qty)}</td></tr>`).join('')}
      </tbody></table>
      <div style="padding:12px 14px;background:var(--blue-light);border-radius:10px;margin-top:6px">
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px"><span>Subtotal</span><span>${rupee(o.subtotal)}</span></div>
        ${Number(o.discount) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;color:var(--ok)"><span>Discount ${o.coupon_code ? '(' + esc(o.coupon_code) + ')' : ''}</span><span>- ${rupee(o.discount)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px"><span>Delivery ${o.order_type === 'pickup' ? '(Pickup)' : '(' + o.distance_km + ' km)'}</span><span>${o.order_type === 'pickup' ? 'FREE' : (Number(o.delivery_charge) === 0 ? '<b style="color:var(--ok)">FREE 🎉</b>' : rupee(o.delivery_charge))}</span></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:20px;font-weight:800;border-top:2px solid var(--ink);margin-top:4px"><span>Total Paid</span><span style="color:var(--blue)">${rupee(o.total)}</span></div>
        <div style="margin-top:8px;font-size:13px;color:var(--ink-soft);display:flex;justify-content:space-between"><span>Payment</span><span><b>${String(o.payment_method).toUpperCase()}</b> · <span style="color:${o.payment_status === 'paid' ? 'var(--ok)' : 'var(--warn)'}">${o.payment_status}</span></span></div>
      </div>`,
      `<button class="btn btn-outline" onclick="printBill('${o.id}')">🖨️ Print Bill</button>
       <select class="status-select" id="modalStatus">${STATUSES.map(s => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select>
       <button class="btn btn-primary" onclick="modalSetStatus('${o.id}')">Update Status</button>`);
  } catch (e) { toast(e.message, 'err'); }
}
async function modalSetStatus(id) {
  const status = document.getElementById('modalStatus').value;
  try { await api(`/orders/${id}/status`, { method: 'PATCH', body: { status } }); toast('Status updated', 'ok'); closeModal(); loadOrders(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ======================= PRINT BILL ======================= */
// Cache /site-config for the invoice header (bakery name, address, GST, FSSAI)
// so repeated prints don't refetch it every click.
let _siteCfgCache = null;
async function getSiteCfg() {
  if (_siteCfgCache) return _siteCfgCache;
  try { const { config } = await api('/site-config'); _siteCfgCache = config; return config; }
  catch { return {}; }
}

async function printBill(id) {
  try {
    const [{ order: o }, cfg] = await Promise.all([api('/orders/' + id), getSiteCfg()]);
    const items = o.items || [];
    const rows = items.map((i, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${esc(i.name)}${i.weight ? ` <span class="muted">(${esc(i.weight)})</span>` : ''}</td>
        <td class="c">${i.qty}</td>
        <td class="r">${rupee(i.price)}</td>
        <td class="r">${rupee(i.price * i.qty)}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bill #${esc(o.order_no)}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: Arial, Helvetica, sans-serif; color: #222; margin: 0; padding: 24px; font-size: 13px; }
        .head { text-align: center; margin-bottom: 14px; }
        .head h1 { margin: 0 0 2px; font-size: 20px; letter-spacing: .5px; }
        .head p { margin: 1px 0; font-size: 11.5px; color: #555; }
        .meta { display: flex; justify-content: space-between; margin: 14px 0; gap: 16px; font-size: 12.5px; }
        .meta div { flex: 1; }
        .meta b { display: block; margin-bottom: 2px; font-size: 11px; color: #777; text-transform: uppercase; letter-spacing: .4px; }
        hr { border: none; border-top: 1px dashed #999; margin: 10px 0; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        th, td { padding: 6px 4px; border-bottom: 1px solid #e2e2e2; text-align: left; }
        th { font-size: 11px; text-transform: uppercase; color: #777; border-bottom: 2px solid #333; }
        .c { text-align: center; } .r { text-align: right; }
        .muted { color: #888; font-size: 11px; }
        .totals { width: 100%; margin-top: 10px; }
        .totals td { border: none; padding: 3px 4px; }
        .totals .grand td { border-top: 2px solid #333; font-size: 15px; font-weight: 700; padding-top: 8px; }
        .foot { text-align: center; margin-top: 22px; font-size: 11.5px; color: #666; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; background: #f1e6da; font-size: 11px; font-weight: 700; text-transform: uppercase; }
        @media print { body { padding: 0; } @page { margin: 12mm; } }
      </style></head><body>
      <div class="head">
        <h1>${esc(cfg.bakery_name || 'PB Bake House')}</h1>
        ${cfg.bakery_address ? `<p>${esc(cfg.bakery_address)}</p>` : ''}
        <p>${cfg.contact_phone ? 'Ph: ' + esc(cfg.contact_phone) : ''}${cfg.gst ? '  &nbsp;|&nbsp;  GSTIN: ' + esc(cfg.gst) : ''}${cfg.fssai ? '  &nbsp;|&nbsp;  FSSAI: ' + esc(cfg.fssai) : ''}</p>
      </div>
      <hr>
      <div class="meta">
        <div><b>Order</b>#${esc(o.order_no)}<br><span class="muted">${fmtDate(o.created_at)}</span></div>
        <div><b>Customer</b>${esc(o.customer_name)}<br><span class="muted">${esc(o.customer_phone)}</span></div>
        <div><b>${o.order_type === 'pickup' ? 'Pickup' : 'Deliver To'}</b>${o.order_type === 'pickup' ? 'Store Pickup' : `${esc(o.address_line)}, ${esc(o.city)} ${esc(o.pincode)}`}</div>
        <div><b>Payment</b><span class="badge">${esc(o.payment_method)} · ${esc(o.payment_status)}</span></div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Item</th><th class="c">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="r" style="width:80%">Subtotal</td><td class="r">${rupee(o.subtotal)}</td></tr>
        ${Number(o.discount) > 0 ? `<tr><td class="r">Discount${o.coupon_code ? ' (' + esc(o.coupon_code) + ')' : ''}</td><td class="r">- ${rupee(o.discount)}</td></tr>` : ''}
        <tr><td class="r">Delivery Charge</td><td class="r">${o.order_type === 'pickup' ? 'FREE' : rupee(o.delivery_charge)}</td></tr>
        <tr class="grand"><td class="r">Total</td><td class="r">${rupee(o.total)}</td></tr>
      </table>
      ${o.notes ? `<hr><p><b>Notes:</b> ${esc(o.notes)}</p>` : ''}
      <div class="foot">Thank you for ordering from ${esc(cfg.bakery_name || 'PB Bake House')}!<br>This is a computer-generated bill and does not require a signature.</div>
      </body></html>`;

    let frame = document.getElementById('billPrintFrame');
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.id = 'billPrintFrame';
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    const doc = frame.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    frame.onload = () => {
      setTimeout(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      }, 150);
    };
  } catch (e) { toast(e.message || 'Could not generate bill', 'err'); }
}

/* ======================= KITCHEN MODE ======================= */
RENDER.kitchen = async function () {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="card"><div class="card-h">
      <h3>Kitchen Mode - Active Orders</h3>
      <button class="btn btn-ghost btn-sm" onclick="go('kitchen')">\u21bb Refresh</button>
    </div></div>
    <div class="kitchen-grid" id="kitchenGrid"><div class="empty">Loading…</div></div>`;
  try {
    const { orders } = await api('/orders/kitchen');
    const grid = document.getElementById('kitchenGrid');
    if (!orders.length) { grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="ei">\u2705</div><p>No active orders. Kitchen is clear!</p></div>'; return; }
    const NEXT = { pending: 'accepted', accepted: 'preparing', preparing: 'ready', ready: 'out_for_delivery' };
    const NEXTLABEL = { pending: 'Accept', accepted: 'Start Preparing', preparing: 'Mark Ready', ready: 'Out for Delivery' };
    grid.innerHTML = orders.map(o => `
      <div class="kt-card ${o.status}">
        <div class="kt-h"><div><div class="no">#${esc(o.order_no)}</div><div class="time">${ago(o.created_at)} &middot; ${statusBadge(o.status)}</div></div>
          <div style="text-align:right"><div style="font-weight:800">${rupee(o.total)}</div><div class="time">${o.order_type === 'pickup' ? 'Pickup' : 'Delivery'}</div></div>
        </div>
        <div class="kt-items">${(o.items || []).map(i => `<div class="it"><span>${esc(i.name)}</span><span class="q">x ${i.qty}</span></div>`).join('')}</div>
        ${o.notes ? `<div class="kt-note">\ud83d\udcdd ${esc(o.notes)}</div>` : ''}
        <div class="kt-actions">
          ${NEXT[o.status] ? `<button class="btn btn-primary btn-block" onclick="kitchenAdvance('${o.id}','${NEXT[o.status]}')">${NEXTLABEL[o.status]}</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="changeStatus('${o.id}','cancelled')">Cancel</button>
        </div>
      </div>`).join('');
  } catch (e) { document.getElementById('kitchenGrid').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};
async function kitchenAdvance(id, status) {
  try { await api(`/orders/${id}/status`, { method: 'PATCH', body: { status } }); toast('Order moved to ' + status.replace(/_/g, ' '), 'ok'); go('kitchen'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ======================= DELIVERIES ======================= */
RENDER.deliveries = async function () {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Deliveries</h3>
        <button class="btn btn-ghost btn-sm" onclick="loadDeliveries()">\u21bb Refresh</button></div>
      <div class="card-b" style="padding-bottom:0">
        ${dateFilterBar('df', 'setDelDate')}
        <div id="delSummary" style="margin-top:12px"></div>
      </div>
      <div class="card-b flush t-wrap" id="delTable"><div class="empty">Loading…</div></div>
    </div>`;
  delFilter = { date: 'today', from: '', to: '' };
  loadDeliveries();
};

let delFilter = { date: 'today', from: '', to: '' };
function setDelDate(v) {
  if (v === 'custom') {
    const f = document.getElementById('dfFrom').value, t = document.getElementById('dfTo').value;
    if (!f || !t) return toast('Pick both From and To dates', 'err');
    delFilter.date = ''; delFilter.from = f; delFilter.to = t; setPresetActive('');
  } else { delFilter.date = v; delFilter.from = ''; delFilter.to = ''; setPresetActive(v); }
  loadDeliveries();
}

async function loadDeliveries() {
  const el = document.getElementById('delTable');
  if (!el) return;
  const p = new URLSearchParams();
  if (delFilter.date && delFilter.date !== 'all') p.set('date', delFilter.date);
  if (delFilter.from) p.set('from', delFilter.from);
  if (delFilter.to) p.set('to', delFilter.to);
  try {
    const { orders, summary } = await api('/orders/deliveries?' + p);
    const sEl = document.getElementById('delSummary');
    if (sEl && summary) sEl.innerHTML = `
      <div class="mini-stats">
        <div class="ms"><span>Deliveries</span><b>${summary.deliveries || 0}</b></div>
        <div class="ms"><span>Revenue</span><b>${rupee(summary.revenue)}</b></div>
        <div class="ms"><span>Delivery Fees</span><b>${rupee(summary.delivery_fees)}</b></div>
        <div class="ms"><span>Avg Distance</span><b>${summary.avg_km || 0} km</b></div>
      </div>`;
    el.innerHTML = `<table><thead><tr><th>Order</th><th>Customer</th><th>Address</th><th>Distance</th><th>Slot</th><th>Status</th><th></th></tr></thead><tbody>
      ${orders.length ? orders.map(o => `
        <tr><td><b>#${esc(o.order_no)}</b></td>
          <td>${esc(o.customer_name)}<br><a href="tel:${esc(o.customer_phone)}" style="color:var(--blue);font-size:12px">${esc(o.customer_phone)}</a></td>
          <td style="max-width:240px;font-size:13px">${esc(o.address_line)}, ${esc(o.city)} ${esc(o.pincode)}</td>
          <td>${o.distance_km} km</td><td>${esc(o.delivery_slot || 'Any')}</td>
          <td><select class="status-select b-${o.status}" onchange="changeStatus('${o.id}',this.value)">${STATUSES.map(s => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select></td>
          <td style="white-space:nowrap">
            ${o.lat && o.lng ? `<a class="btn btn-outline btn-sm" target="_blank" href="https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}">Map</a>` : ''}
            <button class="btn btn-outline btn-sm" title="Print bill" onclick="printBill('${o.id}')">🖨️</button>
          </td>
        </tr>`).join('') : '<tr><td colspan="7"><div class="empty">No deliveries for this period</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ======================= PRODUCTS ======================= */
RENDER.products = async function () {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="card"><div class="card-h">
      <div style="display:flex;gap:8px;align-items:center"><h3>Products</h3><input class="status-select" id="pSearch" placeholder="Filter by name" oninput="filterProducts(this.value)"></div>
      <button class="btn btn-primary" onclick="productModal()">+ Add Product</button>
    </div><div class="card-b flush t-wrap" id="prodTable"><div class="empty">Loading…</div></div></div>`;
  loadProducts();
};
let ALL_PRODUCTS = [];
async function loadProducts() {
  try {
    const { products } = await api('/products?all=1&limit=200');
    ALL_PRODUCTS = products;
    renderProducts(products);
  } catch (e) { document.getElementById('prodTable').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function filterProducts(q) {
  q = q.toLowerCase();
  renderProducts(ALL_PRODUCTS.filter(p => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)));
}
function renderProducts(products) {
  document.getElementById('prodTable').innerHTML = `<table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Flags</th><th>Live</th><th>Actions</th></tr></thead><tbody>
    ${products.length ? products.map(p => {
      const out = p.stock <= 0, low = p.stock > 0 && p.stock <= p.low_stock_at;
      return `<tr>
        <td><div style="display:flex;align-items:center;gap:10px"><span class="thumb">${p.image ? `<img src="${esc(p.image)}" style="width:100%;height:100%;border-radius:8px;object-fit:cover">` : '\ud83c\udf70'}</span><b>${esc(p.name)}</b></div></td>
        <td>${esc(p.category)}</td>
        <td><b>${rupee(p.offer_price || p.price)}</b>${p.offer_price ? `<br><s style="color:var(--ink-faint);font-size:12px">${rupee(p.price)}</s>` : ''}</td>
        <td><b style="color:${out ? 'var(--red)' : low ? 'var(--warn)' : 'var(--ink)'}">${p.stock}</b>
          <div style="display:flex;gap:3px;margin-top:4px"><button class="btn btn-ghost btn-sm" style="padding:2px 8px" onclick="quickStock('${p.id}',-1)">-</button><button class="btn btn-ghost btn-sm" style="padding:2px 8px" onclick="quickStock('${p.id}',1)">+</button><button class="btn btn-ghost btn-sm" style="padding:2px 8px" onclick="stockModal('${p.id}')">Set</button></div></td>
        <td style="font-size:12px">${p.is_featured ? '\u2b50Featured<br>' : ''}${p.is_trending ? '\ud83d\udd25Trending<br>' : ''}${p.is_eggless ? '\ud83c\udf31Eggless' : ''}</td>
        <td><label class="check" style="padding:0"><input type="checkbox" ${p.is_available ? 'checked' : ''} onchange="toggleField('${p.id}','is_available')"></label></td>
        <td><button class="btn btn-outline btn-sm" onclick="productModal('${p.id}')">Edit</button> <button class="btn btn-red btn-sm" onclick="deleteProduct('${p.id}','${esc(p.name).replace(/'/g, "")}')">Delete</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="7"><div class="empty">No products. Click "Add Product" to start.</div></td></tr>'}
  </tbody></table>`;
}
function productModal(id) {
  const p = id ? ALL_PRODUCTS.find(x => x.id === id) : {};
  openModal(id ? 'Edit Product' : 'Add Product', `
    <div class="field"><label>Name *</label><input id="pName" value="${esc(p.name || '')}"></div>
    <div class="grid2">
      <div class="field"><label>Category</label><input id="pCat" value="${esc(p.category || '')}" placeholder="Cakes, Breads..."></div>
      <div class="field"><label>Weight / Size</label><input id="pWeight" value="${esc(p.weight || '')}" placeholder="1 Kg, 6 pcs"></div>
    </div>
    <div class="field"><label>Description</label><textarea id="pDesc">${esc(p.description || '')}</textarea></div>
    <div class="grid3">
      <div class="field"><label>Price (\u20b9) *</label><input id="pPrice" type="number" value="${p.price ?? ''}"></div>
      <div class="field"><label>Offer Price (\u20b9)</label><input id="pOffer" type="number" value="${p.offer_price ?? ''}"></div>
      <div class="field"><label>Cost Price (\u20b9)</label><input id="pCost" type="number" value="${p.cost_price ?? ''}"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Stock</label><input id="pStock" type="number" value="${p.stock ?? 0}"></div>
      <div class="field"><label>Low Stock Alert</label><input id="pLow" type="number" value="${p.low_stock_at ?? 5}"></div>
      <div class="field"><label>Prep (min)</label><input id="pPrep" type="number" value="${p.prep_minutes ?? 30}"></div>
    </div>
    <div class="field"><label>Product Image</label><input id="pImage" type="file" accept="image/*">
      <div style="font-size:12px;color:var(--ink-faint);margin-top:4px">${p.image ? 'Current image will be kept unless you upload a new one.' : 'Leave blank to use a placeholder slot.'}</div></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap">
      <label class="check"><input type="checkbox" id="pAvail" ${p.is_available === undefined || p.is_available ? 'checked' : ''}> Available</label>
      <label class="check"><input type="checkbox" id="pFeatured" ${p.is_featured ? 'checked' : ''}> Featured</label>
      <label class="check"><input type="checkbox" id="pTrending" ${p.is_trending ? 'checked' : ''}> Trending</label>
      <label class="check"><input type="checkbox" id="pEggless" ${p.is_eggless ? 'checked' : ''}> Eggless</label>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" onclick="saveProduct(${id ? `'${id}'` : 'null'})">${id ? 'Save Changes' : 'Add Product'}</button>`);
}
async function saveProduct(id) {
  const name = document.getElementById('pName').value.trim();
  if (!name) return toast('Product name is required', 'err');
  const fd = new FormData();
  fd.append('name', name);
  fd.append('category', document.getElementById('pCat').value.trim() || 'General');
  fd.append('weight', document.getElementById('pWeight').value.trim());
  fd.append('description', document.getElementById('pDesc').value.trim());
  fd.append('price', document.getElementById('pPrice').value || 0);
  fd.append('offer_price', document.getElementById('pOffer').value);
  fd.append('cost_price', document.getElementById('pCost').value || 0);
  fd.append('stock', document.getElementById('pStock').value || 0);
  fd.append('low_stock_at', document.getElementById('pLow').value || 5);
  fd.append('prep_minutes', document.getElementById('pPrep').value || 30);
  fd.append('is_available', document.getElementById('pAvail').checked);
  fd.append('is_featured', document.getElementById('pFeatured').checked);
  fd.append('is_trending', document.getElementById('pTrending').checked);
  fd.append('is_eggless', document.getElementById('pEggless').checked);
  const file = document.getElementById('pImage').files[0];
  if (file) fd.append('image', file);
  try {
    await api(id ? '/products/' + id : '/products', { method: id ? 'PUT' : 'POST', body: fd });
    toast(id ? 'Product updated' : 'Product added', 'ok'); closeModal(); loadProducts();
  } catch (e) { toast(e.message, 'err'); }
}
async function quickStock(id, delta) {
  try { await api(`/products/${id}/stock`, { method: 'PATCH', body: { change_qty: delta, reason: 'Quick adjust' } }); loadProducts(); }
  catch (e) { toast(e.message, 'err'); }
}
function stockModal(id) {
  const p = ALL_PRODUCTS.find(x => x.id === id);
  openModal('Adjust Stock - ' + p.name, `
    <p style="margin-bottom:12px">Current stock: <b>${p.stock}</b></p>
    <div class="field"><label>Add (+) or Remove (-) quantity</label><input id="stockDelta" type="number" placeholder="e.g. 10 or -5"></div>
    <div class="field"><label>Reason</label><input id="stockReason" placeholder="Restocked, wastage, correction..."></div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="applyStock('${id}')">Apply</button>`);
}
async function applyStock(id) {
  const delta = Number(document.getElementById('stockDelta').value);
  if (!delta) return toast('Enter a non-zero quantity', 'err');
  try { await api(`/products/${id}/stock`, { method: 'PATCH', body: { change_qty: delta, reason: document.getElementById('stockReason').value || 'Manual' } }); toast('Stock updated', 'ok'); closeModal(); loadProducts(); }
  catch (e) { toast(e.message, 'err'); }
}
async function toggleField(id, field) {
  try { await api(`/products/${id}/toggle`, { method: 'PATCH', body: { field } }); loadProducts(); }
  catch (e) { toast(e.message, 'err'); loadProducts(); }
}
async function deleteProduct(id, name) {
  openModal('Delete Product', `<p>Are you sure you want to permanently delete <b>${esc(name)}</b>? This cannot be undone.</p>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-red" onclick="confirmDeleteProduct('${id}')">Delete</button>`);
}
async function confirmDeleteProduct(id) {
  try { await api('/products/' + id, { method: 'DELETE' }); toast('Product deleted', 'ok'); closeModal(); loadProducts(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ======================= ANALYTICS ======================= */
RENDER.analytics = async function () {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="empty">Loading analytics...</div>';
  try {
    const a = await api('/admin/analytics?days=30');
    const p = a.profit;
    const maxRev = Math.max(...a.daily.map(d => Number(d.revenue)), 1);
    c.innerHTML = `
      <div class="stat-grid">
        <div class="stat accent-blue"><div class="label">Revenue (30d)</div><div class="value">${rupee(p.revenue)}</div><div class="sub">${p.orders} orders</div></div>
        <div class="stat accent-warn"><div class="label">Expenses (30d)</div><div class="value">${rupee(p.expenses)}</div></div>
        <div class="stat accent-ok"><div class="label">Est. Profit</div><div class="value">${rupee(p.profit)}</div></div>
        <div class="stat accent-red"><div class="label">Avg Order Value</div><div class="value">${rupee(p.avg_order_value)}</div></div>
      </div>
      <div class="card"><div class="card-h"><h3>Daily Revenue (last 30 days)</h3></div><div class="card-b">
        <div style="display:flex;align-items:flex-end;gap:3px;height:180px;overflow-x:auto">
          ${a.daily.map(d => `<div style="flex:1;min-width:12px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center" title="${d.day}: ${rupee(d.revenue)}">
            <div style="width:100%;background:var(--blue);border-radius:4px 4px 0 0;height:${(Number(d.revenue) / maxRev) * 160}px;min-height:2px"></div>
          </div>`).join('') || '<div class="empty">No data</div>'}
        </div>
      </div></div>
      <div class="two-col">
        <div class="card"><div class="card-h"><h3>Top Products</h3></div><div class="card-b flush t-wrap">
          <table><thead><tr><th>Product</th><th>Sold</th><th>Revenue</th></tr></thead><tbody>
          ${a.top_products.length ? a.top_products.map(t => `<tr><td><b>${esc(t.name)}</b></td><td>${t.sold}</td><td>${rupee(t.revenue)}</td></tr>`).join('') : '<tr><td colspan="3"><div class="empty">No sales</div></td></tr>'}
          </tbody></table></div></div>
        <div class="card"><div class="card-h"><h3>By Category</h3></div><div class="card-b flush t-wrap">
          <table><thead><tr><th>Category</th><th>Sold</th><th>Revenue</th></tr></thead><tbody>
          ${a.by_category.length ? a.by_category.map(t => `<tr><td><b>${esc(t.category)}</b></td><td>${t.sold}</td><td>${rupee(t.revenue)}</td></tr>`).join('') : '<tr><td colspan="3"><div class="empty">No sales</div></td></tr>'}
          </tbody></table></div></div>
      </div>`;
  } catch (e) { c.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

/* ======================= CUSTOMERS ======================= */
RENDER.customers = async function () {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Customers</h3>
        <button class="btn btn-ghost btn-sm" onclick="loadCustomers()">\u21bb Refresh</button></div>
      <div class="card-b" style="padding-bottom:0">
        ${dateFilterBar('cf', 'setCustDate')}
        <input class="status-select" id="custSearch" placeholder="Search name / phone"
               style="width:100%;margin:12px 0" oninput="custFilter.search=this.value;debouncedCust()">
        <div id="custSummary"></div>
      </div>
      <div class="card-b flush t-wrap" id="custTable"><div class="empty">Loading…</div></div>
    </div>`;
  custFilter = { search: '', date: 'all', from: '', to: '' };
  setTimeout(() => setPresetActive('all'), 20);
  loadCustomers();
};

let custFilter = { search: '', date: 'all', from: '', to: '' };
function setCustDate(v) {
  if (v === 'custom') {
    const f = document.getElementById('cfFrom').value, t = document.getElementById('cfTo').value;
    if (!f || !t) return toast('Pick both From and To dates', 'err');
    custFilter.date = ''; custFilter.from = f; custFilter.to = t; setPresetActive('');
  } else { custFilter.date = v; custFilter.from = ''; custFilter.to = ''; setPresetActive(v); }
  loadCustomers();
}
let custTimer;
function debouncedCust() { clearTimeout(custTimer); custTimer = setTimeout(() => loadCustomers(), 350); }
async function loadCustomers() {
  try {
    const p = new URLSearchParams();
    if (custFilter.search) p.set('search', custFilter.search);
    if (custFilter.date && custFilter.date !== 'all') p.set('date', custFilter.date);
    if (custFilter.from) p.set('from', custFilter.from);
    if (custFilter.to) p.set('to', custFilter.to);
    const { customers, summary } = await api('/admin/customers?' + p);
    const sEl = document.getElementById('custSummary');
    if (sEl && summary) sEl.innerHTML = `
      <div class="mini-stats">
        <div class="ms"><span>Customers</span><b>${summary.customers || 0}</b></div>
        <div class="ms"><span>Orders</span><b>${summary.orders || 0}</b></div>
        <div class="ms"><span>Revenue</span><b>${rupee(summary.revenue)}</b></div>
      </div>`;
    document.getElementById('custTable').innerHTML = `<table><thead><tr><th>Customer</th><th>Contact</th><th>Delivery Location</th><th>Orders</th><th>Total Spent</th><th>Last Order</th><th></th></tr></thead><tbody>
      ${customers.length ? customers.map(c => `<tr>
        <td><b>${esc(c.name)}</b>${c.email ? `<br><span style="font-size:12px;color:var(--ink-faint)">${esc(c.email)}</span>` : ''}</td>
        <td><a href="tel:${esc(c.phone)}" style="color:var(--blue)">📞 ${esc(c.phone)}</a><br><a href="https://wa.me/91${esc(c.phone)}" target="_blank" style="color:var(--forest);font-size:12px">💬 WhatsApp</a></td>
        <td style="max-width:240px"><span style="font-size:12.5px;color:var(--ink-soft)">${esc(c.address || '—')}</span>${c.lat && c.lng ? `<br><a href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}" target="_blank" style="color:var(--blue);font-weight:700;font-size:12px">🗺️ Navigate</a>` : ''}</td>
        <td>${c.order_count}</td>
        <td><b>${rupee(c.total_spent)}</b></td>
        <td style="font-size:13px;color:var(--ink-faint)">${c.last_order ? fmtDate(c.last_order) : '-'}</td>
        <td><button class="btn btn-outline btn-sm" onclick="viewCustomerOrders('${esc(c.phone)}','${esc(c.name)}')">History</button></td></tr>`).join('')
        : '<tr><td colspan="7"><div class="empty">No customers yet</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { document.getElementById('custTable').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function viewCustomerOrders(phone, name) {
  try {
    const { orders } = await api(`/admin/customers/${encodeURIComponent(phone)}/orders`);
    openModal(`${name} — Order History`, `
      <div style="max-height:60vh;overflow-y:auto">
        <table><thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th></tr></thead><tbody>
        ${orders.map(o => `<tr style="cursor:pointer" onclick="closeModal();setTimeout(()=>openOrder('${o.id}'),150)">
          <td><b>#${esc(o.order_no)}</b></td><td style="font-size:12.5px">${fmtDate(o.created_at)}</td>
          <td>${(o.items||[]).reduce((s,i)=>s+i.qty,0)}</td><td><b>${rupee(o.total)}</b></td><td>${statusBadge(o.status)}</td></tr>`).join('')}
        </tbody></table>
      </div>`, '');
  } catch (e) { toast(e.message, 'err'); }
}

/* ======================= COUPONS ======================= */
RENDER.coupons = async function () {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="card"><div class="card-h"><h3>Coupons</h3><button class="btn btn-primary" onclick="couponModal()">+ New Coupon</button></div><div class="card-b flush t-wrap" id="coupTable"><div class="empty">Loading…</div></div></div>';
  loadCoupons();
};
async function loadCoupons() {
  try {
    const { coupons } = await api('/admin/coupons');
    document.getElementById('coupTable').innerHTML = `<table><thead><tr><th>Code</th><th>Discount</th><th>Min Order</th><th>Used</th><th>Active</th><th></th></tr></thead><tbody>
      ${coupons.length ? coupons.map(c => `<tr><td><b>${esc(c.code)}</b></td>
        <td>${c.type === 'percent' ? c.value + '% off' + (Number(c.max_discount) > 0 ? ` (max ${rupee(c.max_discount)})` : '') : rupee(c.value) + ' off'}</td>
        <td>${rupee(c.min_order)}</td><td>${c.used_count}${c.usage_limit > 0 ? '/' + c.usage_limit : ''}</td>
        <td>${c.is_active ? '<span class="badge b-ready">Active</span>' : '<span class="badge b-cancelled">Off</span>'}</td>
        <td><button class="btn btn-red btn-sm" onclick="deleteCoupon('${c.id}')">Delete</button></td></tr>`).join('')
        : '<tr><td colspan="6"><div class="empty">No coupons yet</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { document.getElementById('coupTable').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function couponModal() {
  openModal('New Coupon', `
    <div class="field"><label>Code *</label><input id="cCode" placeholder="WELCOME10" style="text-transform:uppercase"></div>
    <div class="grid2">
      <div class="field"><label>Type</label><select id="cType"><option value="percent">Percentage</option><option value="flat">Flat Amount</option></select></div>
      <div class="field"><label>Value *</label><input id="cValue" type="number" placeholder="10"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Min Order (\u20b9)</label><input id="cMin" type="number" value="0"></div>
      <div class="field"><label>Max Discount (\u20b9, for %)</label><input id="cMax" type="number" value="0"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Usage Limit (0 = unlimited)</label><input id="cLimit" type="number" value="0"></div>
      <div class="field"><label>Expires On</label><input id="cExpiry" type="date"></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveCoupon()">Create</button>`);
}
async function saveCoupon() {
  const code = document.getElementById('cCode').value.trim();
  const value = document.getElementById('cValue').value;
  if (!code || !value) return toast('Code and value are required', 'err');
  try {
    await api('/admin/coupons', { method: 'POST', body: {
      code, type: document.getElementById('cType').value, value,
      min_order: document.getElementById('cMin').value, max_discount: document.getElementById('cMax').value,
      usage_limit: document.getElementById('cLimit').value, expires_on: document.getElementById('cExpiry').value || null } });
    toast('Coupon created', 'ok'); closeModal(); loadCoupons();
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteCoupon(id) {
  try { await api('/admin/coupons/' + id, { method: 'DELETE' }); toast('Coupon deleted', 'ok'); loadCoupons(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ======================= BANNERS ======================= */
RENDER.banners = async function () {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="card"><div class="card-h"><h3>Homepage Banners</h3><button class="btn btn-primary" onclick="bannerModal()">+ New Banner</button></div><div class="card-b flush t-wrap" id="banTable"><div class="empty">Loading…</div></div></div>';
  loadBanners();
};
async function loadBanners() {
  try {
    const { banners } = await api('/banners/all');
    document.getElementById('banTable').innerHTML = `<table><thead><tr><th>Image</th><th>Title</th><th>Active</th><th></th></tr></thead><tbody>
      ${banners.length ? banners.map(b => `<tr><td>${b.image ? `<img src="${esc(b.image)}" style="width:90px;height:44px;object-fit:cover;border-radius:6px">` : '<span class="thumb">\ud83d\uddbc\ufe0f</span>'}</td>
        <td><b>${esc(b.title || '(untitled)')}</b><br><span style="font-size:12px;color:var(--ink-faint)">${esc(b.subtitle || '')}</span></td>
        <td><label class="check" style="padding:0"><input type="checkbox" ${b.is_active ? 'checked' : ''} onchange="toggleBanner('${b.id}',this.checked)"></label></td>
        <td><button class="btn btn-red btn-sm" onclick="deleteBanner('${b.id}')">Delete</button></td></tr>`).join('')
        : '<tr><td colspan="4"><div class="empty">No banners yet</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { document.getElementById('banTable').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function bannerModal() {
  openModal('New Banner', `
    <div class="field"><label>Title</label><input id="bTitle" placeholder="Weekend Special"></div>
    <div class="field"><label>Subtitle</label><input id="bSub" placeholder="20% off all cakes"></div>
    <div class="field"><label>Link (optional)</label><input id="bLink" placeholder="/menu.html?category=Cakes"></div>
    <div class="field"><label>Image</label><input id="bImage" type="file" accept="image/*"></div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveBanner()">Create</button>`);
}
async function saveBanner() {
  const fd = new FormData();
  fd.append('title', document.getElementById('bTitle').value.trim());
  fd.append('subtitle', document.getElementById('bSub').value.trim());
  fd.append('link', document.getElementById('bLink').value.trim());
  const file = document.getElementById('bImage').files[0];
  if (file) fd.append('image', file);
  try { await api('/banners', { method: 'POST', body: fd }); toast('Banner added', 'ok'); closeModal(); loadBanners(); }
  catch (e) { toast(e.message, 'err'); }
}
async function toggleBanner(id, active) {
  try { await api('/banners/' + id, { method: 'PATCH', body: { is_active: active } }); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteBanner(id) {
  try { await api('/banners/' + id, { method: 'DELETE' }); toast('Banner deleted', 'ok'); loadBanners(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ======================= REVIEWS ======================= */
RENDER.reviews = async function () {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="card"><div class="card-h"><h3>Customer Reviews</h3></div><div class="card-b flush t-wrap" id="revTable"><div class="empty">Loading…</div></div></div>';
  try {
    const { reviews } = await api('/admin/reviews');
    document.getElementById('revTable').innerHTML = `<table><thead><tr><th>Product</th><th>Customer</th><th>Rating</th><th>Comment</th><th>Approved</th><th></th></tr></thead><tbody>
      ${reviews.length ? reviews.map(r => `<tr><td>${esc(r.product_name || '-')}</td><td>${esc(r.name)}</td>
        <td style="color:var(--gold-deep)">${'\u2605'.repeat(r.rating)}</td>
        <td style="max-width:260px;font-size:13px">${esc(r.comment || '')}${r.reply ? `<br><span style="color:var(--blue)">Reply: ${esc(r.reply)}</span>` : ''}</td>
        <td><label class="check" style="padding:0"><input type="checkbox" ${r.is_approved ? 'checked' : ''} onchange="approveReview('${r.id}',this.checked)"></label></td>
        <td><button class="btn btn-outline btn-sm" onclick="replyReview('${r.id}')">Reply</button> <button class="btn btn-red btn-sm" onclick="deleteReview('${r.id}')">Delete</button></td></tr>`).join('')
        : '<tr><td colspan="6"><div class="empty">No reviews yet</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { document.getElementById('revTable').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};
async function approveReview(id, approved) {
  try { await api('/admin/reviews/' + id, { method: 'PATCH', body: { is_approved: approved } }); toast(approved ? 'Review approved' : 'Review hidden', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}
function replyReview(id) {
  openModal('Reply to Review', '<div class="field"><label>Your Reply</label><textarea id="revReply" placeholder="Thank you for your feedback!"></textarea></div>',
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveReviewReply('${id}')">Post Reply</button>`);
}
async function saveReviewReply(id) {
  try { await api('/admin/reviews/' + id, { method: 'PATCH', body: { reply: document.getElementById('revReply').value.trim(), is_approved: true } }); toast('Reply posted', 'ok'); closeModal(); RENDER.reviews(); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteReview(id) {
  try { await api('/admin/reviews/' + id, { method: 'DELETE' }); toast('Review deleted', 'ok'); RENDER.reviews(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ======================= REPORTS ======================= */
RENDER.reports = function () {
  const c = document.getElementById('content');
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  c.innerHTML = `
    <div class="card"><div class="card-h"><h3>Download Reports</h3></div><div class="card-b">
      <div class="grid2" style="max-width:420px;margin-bottom:18px">
        <div class="field"><label>From</label><input type="date" id="repFrom" value="${monthAgo}"></div>
        <div class="field"><label>To</label><input type="date" id="repTo" value="${today}"></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
        ${[['sales', 'Sales Report', '\ud83d\udcb0'], ['orders', 'Orders Export', '\ud83d\udce6'], ['products', 'Product Performance', '\ud83c\udf70'], ['gst', 'GST Summary (5%)', '\ud83e\uddfe'], ['customers', 'Customer List', '\ud83d\udc65']].map(([type, label, icon]) => `
          <div class="card" style="margin:0"><div class="card-b" style="text-align:center">
            <div style="font-size:32px">${icon}</div><h3 style="margin:8px 0">${label}</h3>
            <button class="btn btn-primary btn-block" onclick="downloadReport('${type}')">Download CSV</button>
          </div></div>`).join('')}
      </div>
    </div></div>`;
};
async function downloadReport(type) {
  const from = document.getElementById('repFrom').value, to = document.getElementById('repTo').value;
  try {
    const res = await fetch(`${API}/admin/reports/${type}?from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Report failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `${type}-report-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Report downloaded', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/* ======================= NOTIFICATIONS ======================= */
RENDER.notifications = async function () {
  const c = document.getElementById('content');
  c.innerHTML = `<div class="card">
    <div class="card-h"><h3>Notifications</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="markAllRead()">Mark All Read</button>
        <button class="btn btn-outline btn-sm" onclick="clearNotifs('read')">Clear Read</button>
        <button class="btn btn-red btn-sm" onclick="clearNotifs('all')">Delete All</button>
      </div>
    </div>
    <div class="card-b mini-list" id="notifList"><div class="empty">Loading…</div></div></div>`;
  try {
    const { notifications } = await api('/admin/notifications');
    await api('/admin/notifications/read', { method: 'PATCH', body: {} });
    refreshNotifBadge();
    const ICON = { new_order: '\ud83d\udce6', low_stock: '\u26a0\ufe0f', review: '\u2b50', system: '\ud83d\udce9' };
    document.getElementById('notifList').innerHTML = notifications.length ? notifications.map(n => `
      <div class="mi" id="nf-${n.id}" style="${n.is_read ? '' : 'background:var(--blue-light);margin:0 -20px;padding-left:20px;padding-right:20px'}">
        <span style="font-size:22px">${ICON[n.type] || '\ud83d\udd14'}</span>
        <div style="flex:1"><b>${esc(n.title)}</b>${n.body ? `<div style="font-size:13px;color:var(--ink-soft)">${esc(n.body)}</div>` : ''}</div>
        <span style="font-size:12px;color:var(--ink-faint)">${ago(n.created_at)}</span>
        <button class="nf-del" title="Delete" aria-label="Delete notification" onclick="deleteNotif('${n.id}')">\u2715</button>
      </div>`).join('') : '<div class="empty">No notifications</div>';
  } catch (e) { document.getElementById('notifList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

async function markAllRead() {
  try { await api('/admin/notifications/read', { method: 'PATCH', body: {} }); refreshNotifBadge(); RENDER.notifications(); }
  catch (e) { toast(e.message, 'err'); }
}

async function deleteNotif(id) {
  try {
    await api(`/admin/notifications/${id}`, { method: 'DELETE' });
    const el = document.getElementById('nf-' + id);
    if (el) { el.style.transition = 'opacity .2s,transform .2s'; el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 200); }
    refreshNotifBadge();
    toast('Notification deleted', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function clearNotifs(scope) {
  const msg = scope === 'all' ? 'Delete ALL notifications? This cannot be undone.' : 'Delete all read notifications?';
  if (!confirm(msg)) return;
  try {
    await api(`/admin/notifications?scope=${scope}`, { method: 'DELETE' });
    refreshNotifBadge();
    RENDER.notifications();
    toast('Notifications cleared', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/* ======================= EXPENSES ======================= */
RENDER.expenses = async function () {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="card"><div class="card-h"><h3>Expenses</h3><button class="btn btn-primary" onclick="expenseModal()">+ Add Expense</button></div><div class="card-b flush t-wrap" id="expTable"><div class="empty">Loading…</div></div></div>';
  loadExpenses();
};
async function loadExpenses() {
  try {
    const { expenses } = await api('/admin/expenses');
    document.getElementById('expTable').innerHTML = `<table><thead><tr><th>Date</th><th>Title</th><th>Category</th><th>Amount</th><th></th></tr></thead><tbody>
      ${expenses.length ? expenses.map(e => `<tr><td>${e.spent_on}</td><td><b>${esc(e.title)}</b>${e.note ? `<br><span style="font-size:12px;color:var(--ink-faint)">${esc(e.note)}</span>` : ''}</td>
        <td>${esc(e.category)}</td><td><b>${rupee(e.amount)}</b></td>
        <td><button class="btn btn-red btn-sm" onclick="deleteExpense('${e.id}')">Delete</button></td></tr>`).join('')
        : '<tr><td colspan="5"><div class="empty">No expenses recorded</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { document.getElementById('expTable').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function expenseModal() {
  openModal('Add Expense', `
    <div class="field"><label>Title *</label><input id="eTitle" placeholder="Flour purchase"></div>
    <div class="grid2">
      <div class="field"><label>Category</label><input id="eCat" placeholder="Ingredients"></div>
      <div class="field"><label>Amount (\u20b9) *</label><input id="eAmount" type="number"></div>
    </div>
    <div class="field"><label>Date</label><input id="eDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
    <div class="field"><label>Note</label><input id="eNote"></div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveExpense()">Save</button>`);
}
async function saveExpense() {
  const title = document.getElementById('eTitle').value.trim(), amount = document.getElementById('eAmount').value;
  if (!title || !amount) return toast('Title and amount required', 'err');
  try {
    await api('/admin/expenses', { method: 'POST', body: { title, amount, category: document.getElementById('eCat').value.trim() || 'General', spent_on: document.getElementById('eDate').value, note: document.getElementById('eNote').value.trim() } });
    toast('Expense recorded', 'ok'); closeModal(); loadExpenses();
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteExpense(id) {
  try { await api('/admin/expenses/' + id, { method: 'DELETE' }); toast('Deleted', 'ok'); loadExpenses(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ======================= AUDIT LOG ======================= */
RENDER.audit = async function () {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="card"><div class="card-h"><h3>Audit Log</h3></div><div class="card-b flush t-wrap" id="auditTable"><div class="empty">Loading…</div></div></div>';
  try {
    const { log } = await api('/admin/audit');
    document.getElementById('auditTable').innerHTML = `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
      ${log.length ? log.map(l => `<tr><td style="font-size:12.5px;color:var(--ink-faint)">${fmtDate(l.created_at)}</td><td>${esc(l.actor)}</td>
        <td><span class="badge b-accepted">${esc(l.action)}</span></td><td>${esc(l.entity)}</td><td style="font-size:13px">${esc(l.details || '')}</td></tr>`).join('')
        : '<tr><td colspan="5"><div class="empty">No activity logged</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { document.getElementById('auditTable').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

/* ======================= STAFF ======================= */
RENDER.staff = async function () {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="card"><div class="card-h"><h3>Staff Members</h3><span style="font-size:13px;color:var(--ink-faint)">New staff register on the storefront, then you set their role here</span></div><div class="card-b flush t-wrap" id="staffTable"><div class="empty">Loading…</div></div></div>';
  try {
    const { staff } = await api('/admin/staff');
    document.getElementById('staffTable').innerHTML = `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th></tr></thead><tbody>
      ${staff.length ? staff.map(s => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.email)}</td>
        <td><select class="status-select" onchange="setStaffRole('${s.id}',this.value)" ${s.id === ME.id ? 'disabled' : ''}>
          ${['staff', 'manager', 'owner'].map(r => `<option value="${r}" ${r === s.role ? 'selected' : ''}>${r.replace(/^./, c => c.toUpperCase())}</option>`).join('')}</select></td>
        <td><label class="check" style="padding:0"><input type="checkbox" ${s.is_active ? 'checked' : ''} ${s.id === ME.id ? 'disabled' : ''} onchange="setStaffActive('${s.id}',this.checked)"></label></td></tr>`).join('')
        : '<tr><td colspan="4"><div class="empty">No staff members</div></td></tr>'}
      </tbody></table>`;
  } catch (e) { document.getElementById('staffTable').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};
async function setStaffRole(id, role) {
  try { await api('/admin/staff/' + id, { method: 'PATCH', body: { role } }); toast('Role updated', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}
async function setStaffActive(id, is_active) {
  try { await api('/admin/staff/' + id, { method: 'PATCH', body: { is_active } }); toast('Updated', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ======================= BACKUP ======================= */
RENDER.backup = function () {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="card"><div class="card-h"><h3>Database Backup</h3></div><div class="card-b" style="text-align:center;padding:40px">
      <div style="font-size:48px">\ud83d\udcbe</div>
      <h3 style="margin:12px 0">Download a full backup</h3>
      <p style="color:var(--ink-soft);max-width:440px;margin:0 auto 22px">Exports all products, orders, customers, coupons, banners, reviews and expenses as a single JSON file. Passwords are never included.</p>
      <button class="btn btn-primary" onclick="downloadBackup()">Download Backup (JSON)</button>
    </div></div>`;
};
async function downloadBackup() {
  try {
    const res = await fetch(`${API}/admin/backup`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Backup failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `pb-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Backup downloaded', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
