'use strict';
const router = require('express').Router();
const { pool } = require('../config/db');
const { protect, adminOnly, allowRoles } = require('../middleware/auth');
const { uuid, ok, bad, wrap, audit, money, safeItems } = require('../utils/helpers');

router.use(protect, adminOnly);

// Keeps abandoned/unpaid online checkouts out of every admin-facing count and
// revenue figure — see the matching constant + comment in routes/orders.js.
const PAID_ONLY = "(payment_status IN ('paid','refunded') OR payment_method<>'online')";

router.get('/dashboard', wrap(async (_req, res) => {
  const [[today]] = await pool.query(`
    SELECT COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status<>'cancelled' THEN total END),0) AS revenue,
      SUM(status='pending') AS pending, SUM(status='accepted') AS accepted,
      SUM(status='preparing') AS preparing, SUM(status='ready') AS ready,
      SUM(status='out_for_delivery') AS out_for_delivery,
      SUM(status='delivered') AS delivered, SUM(status='cancelled') AS cancelled
    FROM orders WHERE DATE(created_at)=CURDATE() AND ${PAID_ONLY}`);
  const [[yesterday]] = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN status<>'cancelled' THEN total END),0) AS revenue
    FROM orders WHERE DATE(created_at)=CURDATE()-INTERVAL 1 DAY AND ${PAID_ONLY}`);
  const [[month]] = await pool.query(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN status<>'cancelled' THEN total END),0) AS revenue
    FROM orders WHERE YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE()) AND ${PAID_ONLY}`);
  const [recent] = await pool.query(`SELECT * FROM orders WHERE ${PAID_ONLY} ORDER BY created_at DESC LIMIT 12`);
  const [lowStock] = await pool.query(
    'SELECT id,name,stock,low_stock_at,image FROM products WHERE stock<=low_stock_at ORDER BY stock ASC LIMIT 20');
  const [topToday] = await pool.query(`
    SELECT p.name, p.image, SUM(j.qty) AS sold FROM orders o
    JOIN JSON_TABLE(o.items,'$[*]' COLUMNS (pid VARCHAR(36) PATH '$.id', qty INT PATH '$.qty')) j ON 1=1
    JOIN products p ON p.id = j.pid COLLATE utf8mb4_unicode_ci
    WHERE DATE(o.created_at)=CURDATE() AND o.status<>'cancelled' AND ${PAID_ONLY}
    GROUP BY p.id, p.name, p.image ORDER BY sold DESC LIMIT 5`);
  const [[unread]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE is_read=0');
  const [[customers]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='customer'");
  const prev = Number(yesterday.revenue);
  const change = prev > 0 ? Math.round(((Number(today.revenue) - prev) / prev) * 100) : null;
  ok(res, {
    today: { ...today, revenue: money(today.revenue) },
    yesterday_revenue: money(prev), revenue_change_pct: change,
    month: { ...month, revenue: money(month.revenue) },
    recent_orders: recent.map(o => ({ ...o, items: safeItems(o.items) })),
    low_stock: lowStock, top_today: topToday,
    unread_notifications: unread.n, total_customers: customers.n });
}));

router.get('/analytics', wrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const [daily] = await pool.query(`
    SELECT DATE(created_at) AS day, COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status<>'cancelled' THEN total END),0) AS revenue
    FROM orders WHERE created_at >= CURDATE()-INTERVAL ? DAY AND ${PAID_ONLY} GROUP BY day ORDER BY day`, [days]);
  const [topProducts] = await pool.query(`
    SELECT p.id,p.name,p.image,SUM(j.qty) AS sold, SUM(j.qty*j.price) AS revenue FROM orders o
    JOIN JSON_TABLE(o.items,'$[*]' COLUMNS (pid VARCHAR(36) PATH '$.id', qty INT PATH '$.qty', price DECIMAL(10,2) PATH '$.price')) j ON 1=1
    JOIN products p ON p.id = j.pid COLLATE utf8mb4_unicode_ci
    WHERE o.created_at >= CURDATE()-INTERVAL ? DAY AND o.status<>'cancelled' AND ${PAID_ONLY}
    GROUP BY p.id, p.name, p.image ORDER BY sold DESC LIMIT 10`, [days]);
  const [leastProducts] = await pool.query('SELECT id,name,image,total_sold FROM products ORDER BY total_sold ASC LIMIT 10');
  const [byCategory] = await pool.query(`
    SELECT p.category, SUM(j.qty) AS sold, SUM(j.qty*j.price) AS revenue FROM orders o
    JOIN JSON_TABLE(o.items,'$[*]' COLUMNS (pid VARCHAR(36) PATH '$.id', qty INT PATH '$.qty', price DECIMAL(10,2) PATH '$.price')) j ON 1=1
    JOIN products p ON p.id = j.pid COLLATE utf8mb4_unicode_ci
    WHERE o.created_at >= CURDATE()-INTERVAL ? DAY AND o.status<>'cancelled' AND ${PAID_ONLY}
    GROUP BY p.category ORDER BY revenue DESC`, [days]);
  const [[rev]] = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN status<>'cancelled' THEN total END),0) AS revenue, COUNT(*) AS orders
    FROM orders WHERE created_at >= CURDATE()-INTERVAL ? DAY AND ${PAID_ONLY}`, [days]);
  const [[exp]] = await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses WHERE spent_on >= CURDATE()-INTERVAL ? DAY', [days]);
  ok(res, { days, daily, top_products: topProducts, least_products: leastProducts, by_category: byCategory,
    profit: { revenue: money(rev.revenue), expenses: money(exp.expenses),
      profit: money(Number(rev.revenue) - Number(exp.expenses)), orders: rev.orders,
      avg_order_value: rev.orders ? money(Number(rev.revenue) / rev.orders) : 0 } });
}));

router.get('/customers', wrap(async (req, res) => {
  const { search, date, from, to } = req.query;
  const where = ["(o.payment_status IN ('paid','refunded') OR o.payment_method<>'online')"], args = [];
  if (search) { where.push('(o.customer_name LIKE ? OR o.customer_phone LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  // Date filter = customers who ordered within the selected period
  if (from && to) { where.push('DATE(o.created_at) BETWEEN ? AND ?'); args.push(from, to); }
  else if (date === 'today') where.push('DATE(o.created_at)=CURDATE()');
  else if (date === 'yesterday') where.push('DATE(o.created_at)=CURDATE()-INTERVAL 1 DAY');
  else if (date === 'week') where.push('o.created_at >= CURDATE()-INTERVAL 7 DAY');
  else if (date === 'month') where.push('o.created_at >= CURDATE()-INTERVAL 30 DAY');
  else if (date && date !== 'all') { where.push('DATE(o.created_at)=?'); args.push(date); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(`
    SELECT COALESCE(u.id, o.customer_phone) AS ref, MAX(o.customer_name) AS name,
      o.customer_phone AS phone, MAX(o.customer_email) AS email, COUNT(*) AS order_count,
      COALESCE(SUM(CASE WHEN o.status<>'cancelled' THEN o.total END),0) AS total_spent,
      MAX(o.created_at) AS last_order, MIN(o.created_at) AS first_order,
      SUBSTRING_INDEX(GROUP_CONCAT(CONCAT_WS(', ',o.address_line,o.city,o.pincode) ORDER BY o.created_at DESC SEPARATOR '||'),'||',1) AS address,
      SUBSTRING_INDEX(GROUP_CONCAT(o.lat ORDER BY o.created_at DESC SEPARATOR '||'),'||',1) AS lat,
      SUBSTRING_INDEX(GROUP_CONCAT(o.lng ORDER BY o.created_at DESC SEPARATOR '||'),'||',1) AS lng
    FROM orders o LEFT JOIN users u ON u.id=o.user_id
    ${clause}
    GROUP BY o.customer_phone, u.id ORDER BY total_spent DESC LIMIT 300`, args);

  // New vs returning within the selected window
  const [[sum]] = await pool.query(`
    SELECT COUNT(DISTINCT o.customer_phone) AS customers,
      COALESCE(SUM(CASE WHEN o.status<>'cancelled' THEN o.total END),0) AS revenue,
      COUNT(*) AS orders
    FROM orders o ${clause}`, args);

  ok(res, { customers: rows, summary: sum });
}));

// Registered accounts (from the `users` table itself, role='customer') —
// distinct from /customers above, which is built from orders. This view
// shows everyone who has signed up, including people who registered but
// have not ordered yet, which is exactly the list that's useful for
// marketing outreach (new-bake announcements, offers, win-back emails).
// Paginated so large customer bases stay fast to browse.
router.get('/registered-users', wrap(async (req, res) => {
  const { search } = req.query;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  const offset = (page - 1) * limit;
  const where = ["role='customer'"], args = [];
  if (search) { where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const [rows] = await pool.query(
    `SELECT id,name,email,phone,address_line,city,pincode,is_active,created_at,last_login_at
       FROM users ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users ${clause}`, args);
  ok(res, { users: rows, total, page, pages: Math.ceil(total / limit) || 1 });
}));

// All orders for a specific customer (by phone) — quick history lookup.
router.get('/customers/:phone/orders', wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM orders WHERE customer_phone=? ORDER BY created_at DESC LIMIT 100', [req.params.phone]);
  ok(res, { orders: rows.map(o => ({ ...o, items: safeItems(o.items) })) });
}));

router.get('/search', wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return ok(res, { orders: [], products: [], customers: [] });
  const like = `%${q}%`;
  const [orders] = await pool.query(
    `SELECT id,order_no,customer_name,customer_phone,total,status,created_at FROM orders
     WHERE order_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? ORDER BY created_at DESC LIMIT 15`,
    [like, like, like]);
  const [products] = await pool.query(
    'SELECT id,name,price,offer_price,stock,image,is_available FROM products WHERE name LIKE ? LIMIT 15', [like]);
  const [customers] = await pool.query(
    `SELECT MAX(customer_name) AS name, customer_phone AS phone, COUNT(*) AS orders FROM orders
     WHERE customer_name LIKE ? OR customer_phone LIKE ? GROUP BY customer_phone LIMIT 15`, [like, like]);
  ok(res, { orders, products, customers });
}));

router.get('/notifications', wrap(async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 60');
  const [[u]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE is_read=0');
  ok(res, { notifications: rows, unread: u.n });
}));

router.patch('/notifications/read', wrap(async (req, res) => {
  if (req.body.id) await pool.query('UPDATE notifications SET is_read=1 WHERE id=?', [req.body.id]);
  else await pool.query('UPDATE notifications SET is_read=1 WHERE is_read=0');
  ok(res, { message: 'Marked as read' });
}));

// Delete a single notification
router.delete('/notifications/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM notifications WHERE id=?', [req.params.id]);
  ok(res, { message: 'Notification deleted' });
}));

// Bulk delete: ?scope=read deletes only read ones, ?scope=all clears everything
router.delete('/notifications', wrap(async (req, res) => {
  if (req.query.scope === 'read') await pool.query('DELETE FROM notifications WHERE is_read=1');
  else await pool.query('DELETE FROM notifications');
  await audit(req.user.email, 'delete', 'notifications', req.query.scope || 'all');
  ok(res, { message: 'Notifications cleared' });
}));

router.get('/coupons', wrap(async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
  ok(res, { coupons: rows });
}));

router.post('/coupons', wrap(async (req, res) => {
  const b = req.body;
  if (!b.code || !b.value) return bad(res, 400, 'Code and value are required');
  const id = uuid();
  await pool.query(
    `INSERT INTO coupons (id,code,type,value,min_order,max_discount,expires_on,usage_limit,is_active)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, b.code.toUpperCase(), b.type || 'percent', Number(b.value), Number(b.min_order || 0),
     Number(b.max_discount || 0), b.expires_on || null, Number(b.usage_limit || 0), b.is_active === false ? 0 : 1]);
  await audit(req.user.email, 'create', 'coupon', id, b.code);
  ok(res, { message: 'Coupon created' });
}));

router.delete('/coupons/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM coupons WHERE id=?', [req.params.id]);
  await audit(req.user.email, 'delete', 'coupon', req.params.id);
  ok(res, { message: 'Coupon deleted' });
}));

router.get('/expenses', wrap(async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM expenses ORDER BY spent_on DESC LIMIT 200');
  ok(res, { expenses: rows });
}));

router.post('/expenses', wrap(async (req, res) => {
  const b = req.body;
  if (!b.title || !b.amount) return bad(res, 400, 'Title and amount are required');
  await pool.query('INSERT INTO expenses (id,title,category,amount,spent_on,note) VALUES (?,?,?,?,?,?)',
    [uuid(), b.title, b.category || 'General', Number(b.amount),
     b.spent_on || new Date().toISOString().slice(0, 10), b.note || '']);
  ok(res, { message: 'Expense recorded' });
}));

router.delete('/expenses/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM expenses WHERE id=?', [req.params.id]);
  ok(res, { message: 'Expense deleted' });
}));

router.get('/reviews', wrap(async (_req, res) => {
  const [rows] = await pool.query(`
    SELECT r.*, p.name AS product_name FROM reviews r
    LEFT JOIN products p ON p.id=r.product_id ORDER BY r.created_at DESC LIMIT 200`);
  ok(res, { reviews: rows });
}));

router.patch('/reviews/:id', wrap(async (req, res) => {
  const { is_approved, reply } = req.body;
  await pool.query('UPDATE reviews SET is_approved=COALESCE(?,is_approved), reply=COALESCE(?,reply) WHERE id=?',
    [is_approved === undefined ? null : (is_approved ? 1 : 0), reply ?? null, req.params.id]);
  ok(res, { message: 'Review updated' });
}));

router.delete('/reviews/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM reviews WHERE id=?', [req.params.id]);
  ok(res, { message: 'Review deleted' });
}));

router.get('/audit', allowRoles('owner', 'manager'), wrap(async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 300');
  ok(res, { log: rows });
}));

router.get('/staff', allowRoles('owner'), wrap(async (_req, res) => {
  const [rows] = await pool.query("SELECT id,name,email,phone,role,is_active,created_at FROM users WHERE role<>'customer'");
  ok(res, { staff: rows });
}));

router.patch('/staff/:id', allowRoles('owner'), wrap(async (req, res) => {
  const { role, is_active } = req.body;
  if (role && !['staff', 'manager', 'owner'].includes(role)) return bad(res, 400, 'Invalid role');
  await pool.query('UPDATE users SET role=COALESCE(?,role), is_active=COALESCE(?,is_active) WHERE id=?',
    [role ?? null, is_active === undefined ? null : (is_active ? 1 : 0), req.params.id]);
  await audit(req.user.email, 'staff_update', 'user', req.params.id, JSON.stringify(req.body));
  ok(res, { message: 'Staff updated' });
}));

router.get('/reports/:type', wrap(async (req, res) => {
  const { type } = req.params;
  const { from, to } = req.query;
  const start = from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const end = to || new Date().toISOString().slice(0, 10);
  let rows = [];
  if (type === 'sales' || type === 'orders') {
    [rows] = await pool.query(
      `SELECT order_no,created_at,customer_name,customer_phone,order_type,subtotal,discount,delivery_charge,distance_km,total,payment_method,payment_status,status
       FROM orders WHERE DATE(created_at) BETWEEN ? AND ? ORDER BY created_at DESC`, [start, end]);
  } else if (type === 'products') {
    [rows] = await pool.query('SELECT name,category,price,offer_price,cost_price,stock,total_sold,is_available FROM products ORDER BY total_sold DESC');
  } else if (type === 'gst') {
    [rows] = await pool.query(`
      SELECT order_no, DATE(created_at) AS date, total AS gross, ROUND(total/1.05,2) AS taxable_value,
        ROUND(total-(total/1.05),2) AS gst_5_percent
      FROM orders WHERE status<>'cancelled' AND DATE(created_at) BETWEEN ? AND ?`, [start, end]);
  } else if (type === 'customers') {
    [rows] = await pool.query(`
      SELECT MAX(customer_name) AS customer_name, customer_phone, COUNT(*) AS orders,
        SUM(total) AS total_spent, MAX(created_at) AS last_order
      FROM orders GROUP BY customer_phone ORDER BY total_spent DESC`);
  } else return bad(res, 400, 'Unknown report type');
  if (!rows.length) return bad(res, 404, 'No data for the selected range');
  const headers = Object.keys(rows[0]);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
  res.send('\uFEFF' + csv);
}));

router.get('/backup', allowRoles('owner'), wrap(async (_req, res) => {
  const tables = ['users','products','orders','coupons','banners','reviews','expenses','categories'];
  const dump = { generated_at: new Date().toISOString() };
  for (const t of tables) {
    const [rows] = await pool.query(`SELECT * FROM ${t}`);
    if (t === 'users') rows.forEach(r => delete r.password);
    dump[t] = rows;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="pb-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.send(JSON.stringify(dump, null, 2));
}));

module.exports = router;
