'use strict';
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const { UPLOAD_ROOT } = require('../config/paths');
const { protect, adminOnly } = require('../middleware/auth');
const { productUpload } = require('../middleware/upload');
const { uuid, slugify, ok, bad, wrap, audit, adjustStock } = require('../utils/helpers');
const { notifyLowStock } = require('../utils/email');

/* PUBLIC: list */
router.get('/', wrap(async (req, res) => {
  const { category, search, featured, trending, sort = 'new', limit = 100, page = 1 } = req.query;
  const where = [], args = [];
  if (req.query.all !== '1') where.push('is_available=1');
  if (category && category !== 'all') { where.push('category=?'); args.push(category); }
  if (search) { where.push('(name LIKE ? OR description LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  if (featured === '1') where.push('is_featured=1');
  if (trending === '1') where.push('is_trending=1');
  // Added: optional occasion filter. `occasions` is a comma-separated tag list.
  // Omitting the param leaves the query exactly as it was.
  if (req.query.occasion) { where.push('FIND_IN_SET(?, occasions)'); args.push(req.query.occasion); }
  const orderBy = { new: 'created_at DESC', price_low: 'COALESCE(offer_price,price) ASC',
    price_high: 'COALESCE(offer_price,price) DESC', popular: 'total_sold DESC', name: 'name ASC'
  }[sort] || 'created_at DESC';
  const lim = Math.min(parseInt(limit, 10) || 100, 200);
  const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await pool.query(`SELECT * FROM products ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...args, lim, off]);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM products ${clause}`, args);
  ok(res, { products: rows, total, page: Number(page), pages: Math.ceil(total / lim) });
}));

/* PUBLIC: categories */
router.get('/categories', wrap(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT category AS name, COUNT(*) AS count FROM products WHERE is_available=1 GROUP BY category ORDER BY category`);
  ok(res, { categories: rows });
}));

/* PUBLIC: single */
router.get('/:id', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products WHERE id=? OR slug=? LIMIT 1', [req.params.id, req.params.id]);
  if (!rows.length) return bad(res, 404, 'Product not found');
  const [images] = await pool.query(
    'SELECT id,filename,sort_order FROM product_images WHERE product_id=? ORDER BY sort_order', [rows[0].id]);
  ok(res, { product: { ...rows[0], gallery: images } });
}));

/* ADMIN */
router.use(protect, adminOnly);
const toNum  = (v, d = 0) => (v === '' || v == null ? d : Number(v));
const toBool = v => (v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0);

router.post('/', productUpload.single('image'), wrap(async (req, res) => {
  const b = req.body;
  if (!b.name) return bad(res, 400, 'Product name is required');
  const id = uuid();
  const image = req.file ? `/uploads/products/${req.file.filename}` : (b.image || '');
  await pool.query(
    `INSERT INTO products (id,name,slug,description,category,price,offer_price,cost_price,weight,unit,
       stock,low_stock_at,prep_minutes,image,is_available,is_featured,is_trending,is_eggless)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.name, slugify(b.name), b.description || '', b.category || 'General',
     toNum(b.price), b.offer_price ? toNum(b.offer_price) : null, toNum(b.cost_price),
     b.weight || '', b.unit || 'piece', toNum(b.stock), toNum(b.low_stock_at, 5), toNum(b.prep_minutes, 30),
     image, b.is_available === undefined ? 1 : toBool(b.is_available),
     toBool(b.is_featured), toBool(b.is_trending), toBool(b.is_eggless)]);
  if (toNum(b.stock) > 0)
    await pool.query('INSERT INTO stock_log (id,product_id,change_qty,reason,balance) VALUES (?,?,?,?,?)',
      [uuid(), id, toNum(b.stock), 'Initial stock', toNum(b.stock)]);
  await audit(req.user.email, 'create', 'product', id, b.name);
  const [rows] = await pool.query('SELECT * FROM products WHERE id=?', [id]);
  ok(res, { product: rows[0], message: 'Product added' });
}));

router.put('/:id', productUpload.single('image'), wrap(async (req, res) => {
  const [existing] = await pool.query('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!existing.length) return bad(res, 404, 'Product not found');
  const old = existing[0], b = req.body;
  const image = req.file ? `/uploads/products/${req.file.filename}` : (b.image ?? old.image);
  const newStock = b.stock === undefined ? old.stock : toNum(b.stock);
  await pool.query(
    `UPDATE products SET name=?, slug=?, description=?, category=?, price=?, offer_price=?, cost_price=?,
       weight=?, unit=?, stock=?, low_stock_at=?, prep_minutes=?, image=?,
       is_available=?, is_featured=?, is_trending=?, is_eggless=? WHERE id=?`,
    [b.name ?? old.name, slugify(b.name ?? old.name), b.description ?? old.description, b.category ?? old.category,
     b.price === undefined ? old.price : toNum(b.price),
     b.offer_price === undefined ? old.offer_price : (b.offer_price === '' ? null : toNum(b.offer_price)),
     b.cost_price === undefined ? old.cost_price : toNum(b.cost_price),
     b.weight ?? old.weight, b.unit ?? old.unit, newStock,
     b.low_stock_at === undefined ? old.low_stock_at : toNum(b.low_stock_at),
     b.prep_minutes === undefined ? old.prep_minutes : toNum(b.prep_minutes), image,
     b.is_available === undefined ? old.is_available : toBool(b.is_available),
     b.is_featured === undefined ? old.is_featured : toBool(b.is_featured),
     b.is_trending === undefined ? old.is_trending : toBool(b.is_trending),
     b.is_eggless === undefined ? old.is_eggless : toBool(b.is_eggless), req.params.id]);
  if (newStock !== old.stock)
    await pool.query('INSERT INTO stock_log (id,product_id,change_qty,reason,balance) VALUES (?,?,?,?,?)',
      [uuid(), req.params.id, newStock - old.stock, 'Manual adjustment by admin', newStock]);
  if (b.price !== undefined && Number(b.price) !== Number(old.price))
    await audit(req.user.email, 'price_change', 'product', req.params.id, `${old.price} -> ${b.price}`);
  await audit(req.user.email, 'update', 'product', req.params.id, b.name ?? old.name);
  const [rows] = await pool.query('SELECT * FROM products WHERE id=?', [req.params.id]);
  ok(res, { product: rows[0], message: 'Product updated' });
}));

router.patch('/:id/toggle', wrap(async (req, res) => {
  const field = req.body.field;
  if (!['is_available', 'is_featured', 'is_trending'].includes(field)) return bad(res, 400, 'Invalid field');
  await pool.query(`UPDATE products SET ${field} = IF(${field}=1,0,1) WHERE id=?`, [req.params.id]);
  const [rows] = await pool.query('SELECT * FROM products WHERE id=?', [req.params.id]);
  await audit(req.user.email, 'toggle', 'product', req.params.id, `${field}=${rows[0][field]}`);
  ok(res, { product: rows[0] });
}));

router.patch('/:id/stock', wrap(async (req, res) => {
  const delta = Number(req.body.change_qty);
  if (!Number.isFinite(delta) || delta === 0) return bad(res, 400, 'change_qty must be a non-zero number');
  const balance = await adjustStock(req.params.id, delta, req.body.reason || 'Admin adjustment');
  if (delta > 0) await pool.query('UPDATE products SET is_available=1 WHERE id=? AND stock>0', [req.params.id]);
  await audit(req.user.email, 'stock', 'product', req.params.id, `${delta > 0 ? '+' : ''}${delta} -> ${balance}`);
  const [rows] = await pool.query('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (rows[0].stock <= rows[0].low_stock_at) notifyLowStock(rows[0]).catch(() => {});
  ok(res, { product: rows[0], balance });
}));

router.delete('/:id', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!rows.length) return bad(res, 404, 'Product not found');
  const img = rows[0].image;
  if (img && img.startsWith('/uploads/')) {
    const p = path.join(UPLOAD_ROOT, img.replace(/^\/uploads\//, ''));
    fs.existsSync(p) && fs.unlink(p, () => {});
  }
  await pool.query('DELETE FROM products WHERE id=?', [req.params.id]);
  await audit(req.user.email, 'delete', 'product', req.params.id, rows[0].name);
  ok(res, { message: 'Product deleted' });
}));

router.get('/:id/stock-log', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM stock_log WHERE product_id=? ORDER BY created_at DESC LIMIT 100', [req.params.id]);
  ok(res, { log: rows });
}));

module.exports = router;
