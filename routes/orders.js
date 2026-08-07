'use strict';
const router = require('express').Router();
const { pool } = require('../config/db');
const { protect, adminOnly, optionalAuth } = require('../middleware/auth');
const { uuid, makeOrderNo, ok, bad, wrap, audit, adjustStock, money, pushNotification, safeItems } = require('../utils/helpers');
const { quote, cfg } = require('../utils/delivery');
const { notifyAdminNewOrder, sendOrderConfirmation, sendStatusUpdate, notifyLowStock } = require('../utils/email');
const razorpay = require('../utils/razorpay');

const VALID_STATUS = ['pending','accepted','preparing','ready','out_for_delivery','delivered','cancelled'];

router.post('/delivery-quote', wrap(async (req, res) => {
  const { lat, lng, subtotal = 0 } = req.body;
  if (lat == null || lng == null) return bad(res, 400, 'Location coordinates are required');
  const q = await quote(Number(lat), Number(lng), Number(subtotal));
  ok(res, { quote: q, bakery: { lat: cfg().lat, lng: cfg().lng, name: process.env.BAKERY_NAME || 'PB Bake House' } });
}));

router.get('/delivery-config', (_req, res) => {
  const c = cfg();
  ok(res, { config: {
    base_fare: c.baseFare, base_km: c.baseKm, per_extra_km: c.perExtraKm, max_km: c.maxKm, free_above: c.freeAbove,
    bakery_name: process.env.BAKERY_NAME || 'PB Bake House', bakery_address: process.env.BAKERY_ADDRESS || '',
    bakery_lat: c.lat, bakery_lng: c.lng } });
});

router.post('/', optionalAuth, wrap(async (req, res) => {
  const b = req.body;
  const io = req.app.get('io');
  if (!b.customer_name || !b.customer_phone) return bad(res, 400, 'Name and phone are required');
  // Server-side validation (never trust the client)
  if (!/^[A-Za-z][A-Za-z .'-]*$/.test(String(b.customer_name).trim()) || String(b.customer_name).trim().length < 2)
    return bad(res, 400, 'Please enter a valid name (letters only)');
  if (!/^[6-9]\d{9}$/.test(String(b.customer_phone).replace(/\D/g, '')))
    return bad(res, 400, 'Phone number must be a valid 10-digit mobile');
  if (b.customer_email && !/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(String(b.customer_email).trim().toLowerCase()))
    return bad(res, 400, 'Email must be a valid @gmail.com address');
  if (!Array.isArray(b.items) || !b.items.length) return bad(res, 400, 'Cart is empty');
  const isPickup = b.order_type === 'pickup';
  if (!isPickup && (b.lat == null || b.lng == null))
    return bad(res, 400, 'Delivery location is required so we can calculate the delivery charge');

  const lines = [];
  let subtotal = 0;
  for (const item of b.items) {
    const [rows] = await pool.query('SELECT * FROM products WHERE id=?', [item.id]);
    if (!rows.length) return bad(res, 400, `Product no longer available: ${item.name || item.id}`);
    const p = rows[0];
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    if (!p.is_available) return bad(res, 400, `${p.name} is currently unavailable`);
    if (p.stock < qty) return bad(res, 400, `Only ${p.stock} left of ${p.name}`);
    const unit = Number(p.offer_price || p.price);
    subtotal += unit * qty;
    lines.push({ id: p.id, name: p.name, price: unit, qty, weight: p.weight, image: p.image });
  }
  subtotal = money(subtotal);

  let discount = 0, coupon_code = '';
  if (b.coupon_code) {
    const [cr] = await pool.query('SELECT * FROM coupons WHERE code=? AND is_active=1', [b.coupon_code.toUpperCase()]);
    if (cr.length) {
      const c = cr[0];
      const expired = c.expires_on && new Date(c.expires_on) < new Date();
      const exhausted = c.usage_limit > 0 && c.used_count >= c.usage_limit;
      if (!expired && !exhausted && subtotal >= Number(c.min_order)) {
        discount = c.type === 'percent' ? (subtotal * Number(c.value)) / 100 : Number(c.value);
        if (Number(c.max_discount) > 0) discount = Math.min(discount, Number(c.max_discount));
        discount = money(Math.min(discount, subtotal));
        coupon_code = c.code;
        await pool.query('UPDATE coupons SET used_count=used_count+1 WHERE id=?', [c.id]);
      }
    }
  }

  let delivery_charge = 0, distance_km = 0;
  if (!isPickup) {
    const q = await quote(Number(b.lat), Number(b.lng), subtotal - discount);
    if (!q.deliverable) return bad(res, 400, q.breakdown);
    delivery_charge = q.delivery_charge;
    distance_km = q.distance_km;
  }

  const total = money(subtotal - discount + delivery_charge);
  const id = uuid();
  const order_no = makeOrderNo();

  await pool.query(
    `INSERT INTO orders (id,order_no,user_id,customer_name,customer_phone,customer_email,items,
       subtotal,discount,coupon_code,delivery_charge,distance_km,total,
       order_type,address_line,city,pincode,lat,lng,delivery_date,delivery_slot,payment_method,payment_status,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, order_no, req.user?.id || null, b.customer_name, b.customer_phone, b.customer_email || '',
     JSON.stringify(lines), subtotal, discount, coupon_code, delivery_charge, distance_km, total,
     isPickup ? 'pickup' : 'delivery', b.address_line || '', b.city || '', b.pincode || '',
     isPickup ? null : Number(b.lat), isPickup ? null : Number(b.lng),
     b.delivery_date || null, b.delivery_slot || '',
     'online', 'pending', b.notes || '']);

  await pool.query('INSERT INTO order_status_history (id,order_id,status,changed_by) VALUES (?,?,?,?)',
    [uuid(), id, 'pending', b.customer_name]);

  for (const line of lines) {
    const balance = await adjustStock(line.id, -line.qty, 'Order placed', order_no);
    await pool.query('UPDATE products SET total_sold = total_sold + ? WHERE id=?', [line.qty, line.id]);
    const [[p]] = await pool.query('SELECT * FROM products WHERE id=?', [line.id]);
    if (p && balance <= p.low_stock_at) {
      notifyLowStock(p).catch(() => {});
      await pushNotification(io, { type: 'low_stock',
        title: balance <= 0 ? `Out of stock: ${p.name}` : `Low stock: ${p.name}`,
        body: `${balance} remaining`, ref_id: p.id });
    }
  }

  const [orderRows] = await pool.query('SELECT * FROM orders WHERE id=?', [id]);
  const order = { ...orderRows[0], items: lines };

  // NOTE: the loud admin alert + notification emails are deliberately NOT sent
  // here. Orders are online-prepaid, so the kitchen is alerted only once the
  // payment is confirmed (see /:order_no/confirm-payment). This prevents the
  // bakery from preparing unpaid orders.

  ok(res, { order, message: 'Order created — awaiting payment' });
}));

// Create a Razorpay order for an existing PB Bake House order so the
// frontend can open the real Razorpay Checkout popup. Only works when
// PAYMENT_MODE=live and both Razorpay keys are set — otherwise the frontend
// falls back to the old manual-confirm flow, so nothing else breaks.
router.post('/:order_no/create-payment', wrap(async (req, res) => {
  const { phone } = req.body;
  const [rows] = await pool.query('SELECT * FROM orders WHERE order_no=?', [req.params.order_no]);
  if (!rows.length) return bad(res, 404, 'Order not found');
  const o = rows[0];
  if (phone && String(phone) !== String(o.customer_phone))
    return bad(res, 403, 'Phone does not match this order');
  if (o.payment_status === 'paid') return bad(res, 400, 'This order is already paid');
  if (!razorpay.isLive()) return bad(res, 400, 'Live payments are not enabled on this server');

  // Reuse the Razorpay order if the customer re-opens the payment popup
  // (e.g. closed it and clicked Pay again) instead of creating a duplicate.
  let razorpayOrderId = o.razorpay_order_id;
  if (!razorpayOrderId) {
    const rzOrder = await razorpay.createOrder({
      amount: Number(o.total), receipt: o.order_no, notes: { order_no: o.order_no },
    });
    razorpayOrderId = rzOrder.id;
    await pool.query('UPDATE orders SET razorpay_order_id=? WHERE id=?', [razorpayOrderId, o.id]);
  }
  ok(res, {
    razorpay_order_id: razorpayOrderId,
    amount: Math.round(Number(o.total) * 100),
    currency: 'INR',
    key_id: razorpay.KEY_ID,
    order_no: o.order_no,
  });
}));

// Confirm payment for an order. In MOCK mode (PAYMENT_MODE=mock, or no
// Razorpay keys configured) this simply marks the order paid so the flow can
// be tested end-to-end without real money. In LIVE mode, the payment is only
// ever marked paid after the Razorpay signature is verified server-side —
// the browser's word alone is never trusted.
router.post('/:order_no/confirm-payment', wrap(async (req, res) => {
  const { phone, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
  const [rows] = await pool.query('SELECT * FROM orders WHERE order_no=?', [req.params.order_no]);
  if (!rows.length) return bad(res, 404, 'Order not found');
  const o = rows[0];
  // Light ownership check so a random person can't mark others' orders paid.
  if (phone && String(phone) !== String(o.customer_phone))
    return bad(res, 403, 'Phone does not match this order');

  const live = razorpay.isLive();
  if (live) {
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature)
      return bad(res, 400, 'Missing payment verification details');
    // The Razorpay order id returned by the popup must match the one we
    // created for THIS order — stops a signature from a different order
    // (or a different customer's payment) being replayed here.
    if (o.razorpay_order_id && o.razorpay_order_id !== razorpay_order_id)
      return bad(res, 400, 'Payment does not match this order');
    if (!razorpay.verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }))
      return bad(res, 400, 'Payment verification failed — this payment could not be confirmed');
  }

  if (o.payment_status !== 'paid') {
    await pool.query('UPDATE orders SET payment_status=? WHERE id=?', ['paid', o.id]);
    const io = req.app.get('io');
    const order = { ...o, payment_status: 'paid', items: safeItems(o.items) };

    // Payment received — NOW alert the kitchen (loud alarm) and send emails.
    if (io) io.to('admin').emit('new_order', order);
    await pushNotification(io, {
      type: 'new_order',
      title: `New PAID order #${o.order_no}`,
      body: `${o.customer_name} - Rs.${o.total}`,
      ref_id: o.order_no,
    });
    notifyAdminNewOrder(order).catch(e => console.error('admin mail:', e.message));
    sendOrderConfirmation(order).catch(e => console.error('customer mail:', e.message));
  }
  ok(res, { order_no: o.order_no, payment_status: 'paid', mock: !live });
}));

router.get('/track/:order_no', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM orders WHERE order_no=?', [req.params.order_no]);
  if (!rows.length) return bad(res, 404, 'Order not found');
  const o = rows[0];
  if (req.query.phone && req.query.phone !== o.customer_phone)
    return bad(res, 403, 'Phone number does not match this order');
  const [history] = await pool.query(
    'SELECT status,created_at FROM order_status_history WHERE order_id=? ORDER BY created_at', [o.id]);
  ok(res, { order: { ...o, items: safeItems(o.items) }, history });
}));

router.get('/mine', protect, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  ok(res, { orders: rows.map(o => ({ ...o, items: safeItems(o.items) })) });
}));

/* ADMIN */
router.use(protect, adminOnly);

// Every order placed through the storefront is payment_method='online'. The
// row is inserted the moment checkout starts (so Razorpay has an order_no to
// attach to) but should stay invisible to the kitchen/admin until the
// payment actually clears — otherwise an abandoned/cancelled checkout shows
// up as a phantom order forever. COD orders (payment_method<>'online', if
// ever enabled) are unaffected since they're expected to be unpaid upfront.
const PAID_ONLY = "(payment_status IN ('paid','refunded') OR payment_method<>'online')";

router.get('/', wrap(async (req, res) => {
  const { status, date, from, to, search, limit = 100, page = 1 } = req.query;
  const where = [PAID_ONLY], args = [];
  if (status && status !== 'all') { where.push('status=?'); args.push(status); }

  // Flexible date filtering:
  //   date=today | yesterday | week | month  OR  date=YYYY-MM-DD  OR  from=..&to=..
  if (from && to) { where.push('DATE(created_at) BETWEEN ? AND ?'); args.push(from, to); }
  else if (from) { where.push('DATE(created_at) >= ?'); args.push(from); }
  else if (to) { where.push('DATE(created_at) <= ?'); args.push(to); }
  else if (date === 'today') where.push('DATE(created_at)=CURDATE()');
  else if (date === 'yesterday') where.push('DATE(created_at)=CURDATE()-INTERVAL 1 DAY');
  else if (date === 'week') where.push('created_at >= CURDATE()-INTERVAL 7 DAY');
  else if (date === 'month') where.push('created_at >= CURDATE()-INTERVAL 30 DAY');
  else if (date && date !== 'all') { where.push('DATE(created_at)=?'); args.push(date); }

  if (search) { where.push('(order_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
    args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(parseInt(limit, 10) || 100, 300);
  const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
  const [rows] = await pool.query(`SELECT * FROM orders ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...args, lim, off]);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM orders ${clause}`, args);

  // Summary for the selected range so the admin sees totals at a glance
  const [[sum]] = await pool.query(
    `SELECT COUNT(*) AS orders,
       COALESCE(SUM(CASE WHEN status<>'cancelled' THEN total END),0) AS revenue,
       SUM(status='delivered') AS delivered,
       SUM(status='cancelled') AS cancelled,
       SUM(status IN ('pending','accepted','preparing','ready','out_for_delivery')) AS active
     FROM orders ${clause}`, args);

  ok(res, { orders: rows.map(o => ({ ...o, items: safeItems(o.items) })), total, summary: sum });
}));

router.get('/kitchen', wrap(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM orders WHERE status IN ('pending','accepted','preparing','ready') AND ${PAID_ONLY} ORDER BY created_at ASC`);
  ok(res, { orders: rows.map(o => ({ ...o, items: safeItems(o.items) })) });
}));

router.get('/deliveries', wrap(async (req, res) => {
  const { date, from, to } = req.query;
  const where = ["order_type='delivery'", PAID_ONLY], args = [];
  if (from && to) { where.push('DATE(created_at) BETWEEN ? AND ?'); args.push(from, to); }
  else if (date === 'today') where.push('DATE(created_at)=CURDATE()');
  else if (date === 'yesterday') where.push('DATE(created_at)=CURDATE()-INTERVAL 1 DAY');
  else if (date === 'week') where.push('created_at >= CURDATE()-INTERVAL 7 DAY');
  else if (date === 'month') where.push('created_at >= CURDATE()-INTERVAL 30 DAY');
  else if (date === 'all') { /* no date restriction — show every delivery */ }
  else if (date) { where.push('DATE(created_at)=?'); args.push(date); }
  else where.push("status IN ('ready','out_for_delivery')");   // default: active runs

  const [rows] = await pool.query(
    `SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY delivery_slot, created_at`, args);
  const [[sum]] = await pool.query(
    `SELECT COUNT(*) AS deliveries,
       COALESCE(SUM(CASE WHEN status<>'cancelled' THEN total END),0) AS revenue,
       COALESCE(SUM(delivery_charge),0) AS delivery_fees,
       COALESCE(ROUND(AVG(distance_km),2),0) AS avg_km
     FROM orders WHERE ${where.join(' AND ')}`, args);
  ok(res, { orders: rows.map(o => ({ ...o, items: safeItems(o.items) })), summary: sum });
}));

router.get('/:id', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM orders WHERE id=? OR order_no=?', [req.params.id, req.params.id]);
  if (!rows.length) return bad(res, 404, 'Order not found');
  const [history] = await pool.query('SELECT * FROM order_status_history WHERE order_id=? ORDER BY created_at', [rows[0].id]);
  ok(res, { order: { ...rows[0], items: safeItems(rows[0].items) }, history });
}));

router.patch('/:id/status', wrap(async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUS.includes(status)) return bad(res, 400, 'Invalid status');
  const [rows] = await pool.query('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!rows.length) return bad(res, 404, 'Order not found');
  const order = { ...rows[0], items: safeItems(rows[0].items) };
  if (status === 'cancelled' && order.status !== 'cancelled') {
    for (const line of order.items) {
      await adjustStock(line.id, line.qty, 'Order cancelled', order.order_no);
      await pool.query('UPDATE products SET total_sold=GREATEST(0,total_sold-?) WHERE id=?', [line.qty, line.id]);
    }
  }
  await pool.query('UPDATE orders SET status=? WHERE id=?', [status, req.params.id]);
  await pool.query('INSERT INTO order_status_history (id,order_id,status,changed_by) VALUES (?,?,?,?)',
    [uuid(), req.params.id, status, req.user.email]);
  await audit(req.user.email, 'status_change', 'order', order.order_no, `${order.status} -> ${status}`);
  const io = req.app.get('io');
  if (io) {
    io.to('admin').emit('order_updated', { id: req.params.id, order_no: order.order_no, status });
    io.to(`order_${order.order_no}`).emit('status', { status });
  }
  sendStatusUpdate(order, status).catch(() => {});
  ok(res, { message: `Order marked ${status.replace(/_/g, ' ')}` });
}));

router.patch('/:id/payment', wrap(async (req, res) => {
  const { payment_status } = req.body;
  if (!['pending','paid','failed','refunded'].includes(payment_status)) return bad(res, 400, 'Invalid payment status');
  await pool.query('UPDATE orders SET payment_status=? WHERE id=?', [payment_status, req.params.id]);
  await audit(req.user.email, 'payment_change', 'order', req.params.id, payment_status);
  ok(res, { message: 'Payment status updated' });
}));

module.exports = router;
