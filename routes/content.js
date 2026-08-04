'use strict';
/* ============================================================================
   CONTENT ROUTES  (added — nothing in this file modifies existing behaviour)

   Everything here is new surface area:
     • /api/categories…      category records + admin-managed artwork
     • /api/settings…        key/value site settings (Razorpay, About imagery)
     • /api/custom-cakes…    customer enquiries + admin management

   Mounted at /api by server.js AFTER the existing routers, so no existing
   path can be shadowed.
   ========================================================================== */
const router = require('express').Router();
const { pool } = require('../config/db');
const { protect, adminOnly } = require('../middleware/auth');
const { categoryUpload, aboutUpload, siteUpload, customUpload } = require('../middleware/upload');
const { uuid, slugify, ok, bad, wrap, pushNotification, audit } = require('../utils/helpers');

/* ══════════════════════════════════════════════════════════════════════
   SETTINGS  — generic key/value store, already in the schema
   ══════════════════════════════════════════════════════════════════════ */

/* Booleans arrive as '1'/'0' from multipart forms and as true/false/0/1 from
   JSON bodies. Strict comparisons miss the numeric zero case, so normalise once
   here and use it everywhere. Returns null when the field was not supplied,
   which the COALESCE in each UPDATE reads as "leave unchanged". */
function boolish(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v === false || v === 0) return 0;
  const s = String(v).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return 0;
  return 1;
}

/* Keys the storefront is allowed to read. Anything not listed stays private. */
const PUBLIC_SETTING_KEYS = [
  'razorpay_qr_image',        // optional payment image on the checkout modal
  'razorpay_show_image',      // '1' | '0'
  'razorpay_note',
  'about_hero_image',
  'about_story_image',
  'about_kitchen_image',
  'custom_cake_image',
  'custom_cake_enabled',      // '1' | '0'
];

async function readSettings(keys = null) {
  const [rows] = keys && keys.length
    ? await pool.query(`SELECT skey, svalue FROM settings WHERE skey IN (${keys.map(() => '?').join(',')})`, keys)
    : await pool.query('SELECT skey, svalue FROM settings');
  const out = {};
  rows.forEach(r => { out[r.skey] = r.svalue; });
  return out;
}
module.exports.readSettings = readSettings;
module.exports.PUBLIC_SETTING_KEYS = PUBLIC_SETTING_KEYS;

/* PUBLIC: the subset of settings the storefront needs */
router.get('/settings/public', wrap(async (_req, res) => {
  ok(res, { settings: await readSettings(PUBLIC_SETTING_KEYS) });
}));

/* ADMIN: read everything */
router.get('/settings', protect, adminOnly, wrap(async (_req, res) => {
  ok(res, { settings: await readSettings() });
}));

/* ADMIN: write one or many settings */
router.put('/settings', protect, adminOnly, wrap(async (req, res) => {
  const body = req.body || {};
  const entries = Object.entries(body).filter(([k]) => /^[a-z0-9_]{2,60}$/i.test(k));
  if (!entries.length) return bad(res, 400, 'Nothing to save');
  for (const [k, v] of entries) {
    await pool.query(
      'INSERT INTO settings (skey, svalue) VALUES (?,?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue)',
      [k, String(v ?? '').slice(0, 500)]);
  }
  await audit(req.user.email, 'settings_update', 'settings', '', entries.map(([k]) => k).join(', '));
  ok(res, { message: 'Settings saved', saved: entries.length });
}));

/* ADMIN: upload an image and store its path against a setting key */
router.post('/settings/image', protect, adminOnly, siteUpload.single('image'), wrap(async (req, res) => {
  const key = String(req.body.key || '').trim();
  if (!/^[a-z0-9_]{2,60}$/i.test(key)) return bad(res, 400, 'A valid setting key is required');
  if (!req.file) return bad(res, 400, 'No image received');
  const path = `/uploads/site/${req.file.filename}`;
  await pool.query(
    'INSERT INTO settings (skey, svalue) VALUES (?,?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue)',
    [key, path]);
  await audit(req.user.email, 'settings_image', 'settings', key, path);
  ok(res, { message: 'Image uploaded', key, path });
}));

/* ADMIN: clear a setting (used by "remove image") */
router.delete('/settings/:key', protect, adminOnly, wrap(async (req, res) => {
  await pool.query('UPDATE settings SET svalue=? WHERE skey=?', ['', req.params.key]);
  await audit(req.user.email, 'settings_clear', 'settings', req.params.key, '');
  ok(res, { message: 'Cleared' });
}));

/* ADMIN: About-page imagery lands in its own folder */
router.post('/settings/about-image', protect, adminOnly, aboutUpload.single('image'), wrap(async (req, res) => {
  const key = String(req.body.key || '').trim();
  if (!/^about_[a-z0-9_]{2,50}$/i.test(key)) return bad(res, 400, 'Key must start with about_');
  if (!req.file) return bad(res, 400, 'No image received');
  const path = `/uploads/about/${req.file.filename}`;
  await pool.query(
    'INSERT INTO settings (skey, svalue) VALUES (?,?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue)',
    [key, path]);
  await audit(req.user.email, 'about_image', 'settings', key, path);
  ok(res, { message: 'Image uploaded', key, path });
}));

/* ══════════════════════════════════════════════════════════════════════
   CATEGORIES  — the table already existed with an `image` column but was
   never read. These routes finally connect it.
   ══════════════════════════════════════════════════════════════════════ */

/* PUBLIC: category records with artwork, merged with live product counts.
   Categories that exist only on products (never inserted into the table)
   still appear, so nothing disappears from the storefront. */
router.get('/categories', wrap(async (_req, res) => {
  const [counts] = await pool.query(
    `SELECT category AS name, COUNT(*) AS count FROM products
      WHERE is_available=1 GROUP BY category`);
  const [saved] = await pool.query(
    'SELECT id, name, slug, image, description, sort_order, is_active FROM categories');

  const byName = new Map(saved.map(c => [String(c.name).toLowerCase(), c]));
  const merged = counts.map(c => {
    const rec = byName.get(String(c.name).toLowerCase());
    return {
      name: c.name,
      count: Number(c.count),
      id: rec?.id || null,
      slug: rec?.slug || slugify(c.name),
      image: rec?.image || '',
      description: rec?.description || '',
      sort_order: rec?.sort_order ?? 0,
      is_active: rec?.is_active ?? 1,
    };
  }).filter(c => c.is_active);

  merged.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
  ok(res, { categories: merged });
}));

/* ADMIN: full list, including categories with no products yet */
router.get('/categories/all', protect, adminOnly, wrap(async (_req, res) => {
  const [saved] = await pool.query('SELECT * FROM categories ORDER BY sort_order, name');
  const [counts] = await pool.query(
    'SELECT category AS name, COUNT(*) AS count FROM products GROUP BY category');
  const countMap = new Map(counts.map(c => [String(c.name).toLowerCase(), Number(c.count)]));

  const rows = saved.map(c => ({ ...c, count: countMap.get(String(c.name).toLowerCase()) || 0 }));
  // Surface product categories that have no record yet, so admin can add art.
  const known = new Set(saved.map(c => String(c.name).toLowerCase()));
  counts.forEach(c => {
    if (!known.has(String(c.name).toLowerCase())) {
      rows.push({ id: null, name: c.name, slug: slugify(c.name), image: '',
                  description: '', sort_order: 0, is_active: 1, count: Number(c.count) });
    }
  });
  ok(res, { categories: rows });
}));

/* ADMIN: create or update a category (upsert by name) with optional artwork */
router.post('/categories', protect, adminOnly, categoryUpload.single('image'), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return bad(res, 400, 'Category name is required');

  const image = req.file ? `/uploads/categories/${req.file.filename}` : (b.image || '');
  const [existing] = await pool.query('SELECT id, image FROM categories WHERE LOWER(name)=LOWER(?)', [name]);

  if (existing.length) {
    const id = existing[0].id;
    await pool.query(
      `UPDATE categories SET
         image       = COALESCE(NULLIF(?, ''), image),
         description = COALESCE(?, description),
         sort_order  = COALESCE(?, sort_order),
         is_active   = COALESCE(?, is_active)
       WHERE id=?`,
      [image, b.description ?? null,
       b.sort_order === undefined ? null : Number(b.sort_order),
       boolish(b.is_active),
       id]);
    await audit(req.user.email, 'category_update', 'category', name, image || '(no new image)');
    return ok(res, { message: 'Category updated', id });
  }

  const id = uuid();
  await pool.query(
    'INSERT INTO categories (id,name,slug,image,description,sort_order,is_active) VALUES (?,?,?,?,?,?,?)',
    [id, name, slugify(name), image, b.description || '', Number(b.sort_order || 0),
     boolish(b.is_active) === 0 ? 0 : 1]);
  await audit(req.user.email, 'category_create', 'category', name, image);
  ok(res, { message: 'Category created', id });
}));

router.patch('/categories/:id', protect, adminOnly, wrap(async (req, res) => {
  const { description, sort_order, is_active } = req.body || {};
  await pool.query(
    `UPDATE categories SET description=COALESCE(?,description),
       sort_order=COALESCE(?,sort_order), is_active=COALESCE(?,is_active) WHERE id=?`,
    [description ?? null, sort_order ?? null, boolish(is_active), req.params.id]);
  ok(res, { message: 'Category updated' });
}));

/* Removes the artwork/record only — products keep their category string. */
router.delete('/categories/:id', protect, adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM categories WHERE id=?', [req.params.id]);
  await audit(req.user.email, 'category_delete', 'category', req.params.id, '');
  ok(res, { message: 'Category record removed. Products are unaffected.' });
}));

/* ══════════════════════════════════════════════════════════════════════
   OCCASION TAGGING  — writes only the new products.occasions column
   ══════════════════════════════════════════════════════════════════════ */

const OCCASIONS = ['Birthday', 'Anniversary', 'Wedding', 'Baby shower', 'Congrats', 'Thank you'];

router.get('/occasions', wrap(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, category, image, occasions FROM products
      WHERE is_available=1 ORDER BY category, name`);
  ok(res, { options: OCCASIONS, products: rows });
}));

router.patch('/occasions/:id', protect, adminOnly, wrap(async (req, res) => {
  const list = Array.isArray(req.body.occasions) ? req.body.occasions : [];
  const clean = list.filter(o => OCCASIONS.includes(o));
  // Only this one column is written — nothing else on the product is touched.
  await pool.query('UPDATE products SET occasions=? WHERE id=?', [clean.join(','), req.params.id]);
  await audit(req.user.email, 'occasion_tag', 'product', req.params.id, clean.join(', ') || '(none)');
  ok(res, { message: 'Tags saved', occasions: clean.join(',') });
}));

/* ══════════════════════════════════════════════════════════════════════
   CUSTOM CAKE DESIGN GALLERY
   Sample designs the admin uploads; customers browse then customise one.
   ══════════════════════════════════════════════════════════════════════ */

/* PUBLIC: active designs, in display order */
router.get('/custom-cake-designs', wrap(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT id, title, description, image, base_price, flavours, weights, occasion, tags
       FROM custom_cake_designs WHERE is_active=1
      ORDER BY sort_order, created_at DESC`);
  ok(res, { designs: rows });
}));

/* ADMIN: everything, including hidden entries */
router.get('/custom-cake-designs/all', protect, adminOnly, wrap(async (_req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM custom_cake_designs ORDER BY sort_order, created_at DESC');
  ok(res, { designs: rows });
}));

router.post('/custom-cake-designs', protect, adminOnly, customUpload.single('image'), wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return bad(res, 400, 'A title is required');

  const image = req.file ? `/uploads/custom/${req.file.filename}` : (b.image || '');
  const id = uuid();
  const [[{ next }]] = await pool.query(
    'SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM custom_cake_designs');

  await pool.query(
    `INSERT INTO custom_cake_designs
       (id,title,description,image,base_price,flavours,weights,occasion,tags,sort_order,is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, title, String(b.description || '').slice(0, 400), image,
     b.base_price ? Number(b.base_price) : null,
     String(b.flavours || '').slice(0, 300), String(b.weights || '').slice(0, 200),
     String(b.occasion || '').slice(0, 80), String(b.tags || '').slice(0, 200),
     b.sort_order === undefined ? next : Number(b.sort_order),
     boolish(b.is_active) === 0 ? 0 : 1]);

  await audit(req.user.email, 'design_create', 'custom_cake_design', id, title);
  ok(res, { message: 'Design added', id });
}));

router.patch('/custom-cake-designs/:id', protect, adminOnly, customUpload.single('image'), wrap(async (req, res) => {
  const b = req.body || {};
  const image = req.file ? `/uploads/custom/${req.file.filename}` : '';
  await pool.query(
    `UPDATE custom_cake_designs SET
       title       = COALESCE(NULLIF(?, ''), title),
       description = COALESCE(?, description),
       image       = COALESCE(NULLIF(?, ''), image),
       base_price  = COALESCE(?, base_price),
       flavours    = COALESCE(?, flavours),
       weights     = COALESCE(?, weights),
       occasion    = COALESCE(?, occasion),
       tags        = COALESCE(?, tags),
       sort_order  = COALESCE(?, sort_order),
       is_active   = COALESCE(?, is_active)
     WHERE id=?`,
    [String(b.title || ''), b.description ?? null, image,
     b.base_price === undefined || b.base_price === '' ? null : Number(b.base_price),
     b.flavours ?? null, b.weights ?? null, b.occasion ?? null, b.tags ?? null,
     b.sort_order === undefined || b.sort_order === '' ? null : Number(b.sort_order),
     boolish(b.is_active),
     req.params.id]);

  await audit(req.user.email, 'design_update', 'custom_cake_design', req.params.id, b.title || '');
  ok(res, { message: 'Design updated' });
}));

/* ADMIN: bulk reorder — accepts an array of ids in the desired order */
router.put('/custom-cake-designs/order', protect, adminOnly, wrap(async (req, res) => {
  const ids = Array.isArray(req.body.order) ? req.body.order : [];
  if (!ids.length) return bad(res, 400, 'No order supplied');
  for (let i = 0; i < ids.length; i++) {
    await pool.query('UPDATE custom_cake_designs SET sort_order=? WHERE id=?', [i + 1, ids[i]]);
  }
  await audit(req.user.email, 'design_reorder', 'custom_cake_design', '', `${ids.length} items`);
  ok(res, { message: 'Order saved' });
}));

router.delete('/custom-cake-designs/:id', protect, adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM custom_cake_designs WHERE id=?', [req.params.id]);
  await audit(req.user.email, 'design_delete', 'custom_cake_design', req.params.id, '');
  ok(res, { message: 'Design deleted' });
}));

/* ══════════════════════════════════════════════════════════════════════
   CUSTOM CAKE ENQUIRIES
   ══════════════════════════════════════════════════════════════════════ */

const CC_STATUSES = ['new', 'contacted', 'quoted', 'confirmed', 'completed', 'cancelled'];

function refNo() {
  const d = new Date();
  const stamp = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `CC${stamp}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/* PUBLIC: submit an enquiry (reference photo optional) */
router.post('/custom-cakes', customUpload.single('reference_image'), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.customer_name || '').trim();
  const phone = String(b.phone || '').replace(/\D/g, '');

  if (name.length < 2) return bad(res, 400, 'Please enter your name');
  if (!/^[6-9]\d{9}$/.test(phone)) return bad(res, 400, 'Phone number must be a valid 10-digit mobile');
  // Email stays optional, matching how orders behave.
  const email = String(b.email || '').trim().toLowerCase();
  if (email && !/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email))
    return bad(res, 400, 'Email must be a valid @gmail.com address');

  let neededOn = null;
  if (b.needed_on && /^\d{4}-\d{2}-\d{2}$/.test(b.needed_on)) neededOn = b.needed_on;

  const id = uuid();
  const ref = refNo();
  const image = req.file ? `/uploads/custom/${req.file.filename}` : '';

  await pool.query(
    `INSERT INTO custom_cake_requests
       (id, ref_no, customer_name, phone, email, flavour, weight, occasion, needed_on,
        message_on_cake, instructions, reference_image, budget, design_id, design_title)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, ref, name, phone, email,
     String(b.flavour || '').slice(0, 80), String(b.weight || '').slice(0, 40),
     String(b.occasion || '').slice(0, 80), neededOn,
     String(b.message_on_cake || '').slice(0, 200), String(b.instructions || '').slice(0, 2000),
     image, b.budget ? Number(b.budget) : null,
     String(b.design_id || '').slice(0, 36), String(b.design_title || '').slice(0, 120)]);

  // Reuses the existing notification system — appears in the admin bell.
  await pushNotification(req.app.get('io'), {
    type: 'custom_order',   // existing ENUM value - no schema change needed
    title: 'New custom cake enquiry',
    body: `${name} · ${b.occasion || 'Custom cake'}${neededOn ? ' · needed ' + neededOn : ''}`,
    ref_id: ref,
  });

  ok(res, { message: 'Enquiry received', ref_no: ref, id });
}));

/* PUBLIC: check the status of your own enquiry by reference number */
router.get('/custom-cakes/track/:ref', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ref_no, customer_name, flavour, weight, occasion, needed_on,
            status, quoted_price, created_at
       FROM custom_cake_requests WHERE ref_no=?`, [req.params.ref]);
  if (!rows.length) return bad(res, 404, 'No enquiry found with that reference');
  ok(res, { request: rows[0] });
}));

/* ADMIN: list with optional status filter */
router.get('/custom-cakes', protect, adminOnly, wrap(async (req, res) => {
  const params = [];
  let sql = 'SELECT * FROM custom_cake_requests';
  if (req.query.status && CC_STATUSES.includes(req.query.status)) {
    sql += ' WHERE status=?';
    params.push(req.query.status);
  }
  sql += ' ORDER BY created_at DESC LIMIT 300';
  const [rows] = await pool.query(sql, params);

  const [[counts]] = await pool.query(
    `SELECT
       SUM(status='new') AS new_count,
       SUM(status='contacted') AS contacted,
       SUM(status='quoted') AS quoted,
       SUM(status='confirmed') AS confirmed,
       SUM(status='completed') AS completed,
       SUM(status='cancelled') AS cancelled,
       COUNT(*) AS total
     FROM custom_cake_requests`);

  ok(res, { requests: rows, counts });
}));

/* ADMIN: update status, quote or internal note */
router.patch('/custom-cakes/:id', protect, adminOnly, wrap(async (req, res) => {
  const { status, admin_note, quoted_price } = req.body || {};
  if (status && !CC_STATUSES.includes(status)) return bad(res, 400, 'Unknown status');
  await pool.query(
    `UPDATE custom_cake_requests SET
       status       = COALESCE(?, status),
       admin_note   = COALESCE(?, admin_note),
       quoted_price = COALESCE(?, quoted_price)
     WHERE id=?`,
    [status ?? null, admin_note ?? null,
     quoted_price === undefined || quoted_price === '' ? null : Number(quoted_price),
     req.params.id]);
  await audit(req.user.email, 'custom_cake_update', 'custom_cake', req.params.id, status || 'note');
  ok(res, { message: 'Enquiry updated' });
}));

router.delete('/custom-cakes/:id', protect, adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM custom_cake_requests WHERE id=?', [req.params.id]);
  await audit(req.user.email, 'custom_cake_delete', 'custom_cake', req.params.id, '');
  ok(res, { message: 'Enquiry deleted' });
}));

module.exports = router;
module.exports.readSettings = readSettings;
module.exports.PUBLIC_SETTING_KEYS = PUBLIC_SETTING_KEYS;
