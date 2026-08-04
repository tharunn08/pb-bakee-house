'use strict';
const router = require('express').Router();
const { pool } = require('../config/db');
const { protect, adminOnly, optionalAuth } = require('../middleware/auth');
const { bannerUpload } = require('../middleware/upload');
const { uuid, ok, bad, wrap, pushNotification } = require('../utils/helpers');

// Public site configuration — social links, payment, promos, business IDs.
// Everything here is safe to expose to the storefront.
// Public active coupons — for display on the storefront (menu banner).
router.get('/coupons/active', wrap(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT code, type, value, min_order, max_discount, expires_on FROM coupons
     WHERE is_active=1 AND (expires_on IS NULL OR expires_on >= CURDATE())
       AND (usage_limit=0 OR used_count < usage_limit)
     ORDER BY value DESC LIMIT 12`);
  ok(res, { coupons: rows });
}));

router.get('/site-config', wrap(async (_req, res) => {
  const n = (v, d) => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : d; };
  ok(res, { config: {
    bakery_name: process.env.BAKERY_NAME || 'PB Bake House',
    bakery_address: process.env.BAKERY_ADDRESS || '',
    bakery_lat: n(process.env.BAKERY_LAT, 12.943563),
    bakery_lng: n(process.env.BAKERY_LNG, 77.540188),
    maps_url: process.env.BAKERY_MAPS_URL || 'https://maps.app.goo.gl/uCmgvwRvf5yHFfgb6',
    plus_code: process.env.BAKERY_PLUS_CODE || 'WGVR+C3 Bengaluru',
    whatsapp: process.env.CONTACT_WHATSAPP || '918971727805',
    // Added: the number the Call button dials. Falls back to the WhatsApp
    // number with the country code stripped so it is never empty.
    contact_phone: process.env.CONTACT_PHONE
      || (process.env.CONTACT_WHATSAPP || '918971727805').replace(/^91/, ''),
    instagram: process.env.CONTACT_INSTAGRAM || 'https://www.instagram.com/pb_bake_house',
    instagram_handle: process.env.INSTAGRAM_HANDLE || 'pb_bake_house',
    instagram_discount: n(process.env.INSTAGRAM_FOLLOW_DISCOUNT, 10),
    razorpay_link: process.env.RAZORPAY_PAYMENT_LINK || 'https://razorpay.me/@pbbakehouse',
    razorpay_key_id: process.env.RAZORPAY_KEY_ID || '',
    delivery: {
      base_fare: n(process.env.DELIVERY_BASE_FARE, 40),
      base_km: n(process.env.DELIVERY_BASE_KM, 2),
      per_extra_km: n(process.env.DELIVERY_PER_EXTRA_KM, 10),
      max_km: n(process.env.DELIVERY_MAX_KM, 25),
      free_above: n(process.env.FREE_DELIVERY_ABOVE, 500),
      free_within_km: n(process.env.FREE_DELIVERY_WITHIN_KM, 2),
      eta_minutes: n(process.env.DEFAULT_DELIVERY_MINUTES, 30),
    },
    developer_name: process.env.DEVELOPER_NAME || 'TrionCode Solutions',
    developer_url: process.env.DEVELOPER_URL || '#',
    fssai: process.env.FSSAI_LICENSE || '',
    gst: process.env.GST_NUMBER || '',
    // Added: admin-managed settings. Every key above keeps its env default;
    // these are extra fields, so existing consumers are unaffected.
    ...(await (async () => {
      try {
        const { readSettings, PUBLIC_SETTING_KEYS } = require('./content');
        return { settings: await readSettings(PUBLIC_SETTING_KEYS) };
      } catch { return { settings: {} }; }
    })()),
  } });
}));

router.get('/banners', wrap(async (req, res) => {
  // Optional ?slot= filter (added). Without it the response is exactly as before.
  const slot = String(req.query.slot || '').trim();
  const [rows] = slot
    ? await pool.query('SELECT * FROM banners WHERE is_active=1 AND slot=? ORDER BY sort_order, created_at', [slot])
    : await pool.query('SELECT * FROM banners WHERE is_active=1 ORDER BY sort_order, created_at');
  ok(res, { banners: rows });
}));

router.get('/banners/all', protect, adminOnly, wrap(async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM banners ORDER BY sort_order, created_at');
  ok(res, { banners: rows });
}));

router.post('/banners', protect, adminOnly, bannerUpload.single('image'), wrap(async (req, res) => {
  const b = req.body;
  const image = req.file ? `/uploads/banners/${req.file.filename}` : (b.image || '');
  const id = uuid();
  await pool.query(
    'INSERT INTO banners (id,title,subtitle,image,link,is_active,sort_order,slot,cta_label) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, b.title || '', b.subtitle || '', image, b.link || '', b.is_active === 'false' ? 0 : 1,
     Number(b.sort_order || 0), b.slot || 'hero', b.cta_label || '']);
  ok(res, { message: 'Banner added', id });
}));

router.patch('/banners/:id', protect, adminOnly, wrap(async (req, res) => {
  const { is_active, sort_order, title, subtitle, link, slot, cta_label } = req.body;
  await pool.query(
    `UPDATE banners SET is_active=COALESCE(?,is_active), sort_order=COALESCE(?,sort_order),
       title=COALESCE(?,title), subtitle=COALESCE(?,subtitle), link=COALESCE(?,link),
       slot=COALESCE(?,slot), cta_label=COALESCE(?,cta_label) WHERE id=?`,
    [is_active === undefined ? null : (is_active ? 1 : 0), sort_order ?? null, title ?? null,
     subtitle ?? null, link ?? null, slot ?? null, cta_label ?? null, req.params.id]);
  ok(res, { message: 'Banner updated' });
}));

router.delete('/banners/:id', protect, adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM banners WHERE id=?', [req.params.id]);
  ok(res, { message: 'Banner deleted' });
}));

router.get('/reviews/:productId', wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id,name,rating,comment,reply,created_at FROM reviews WHERE product_id=? AND is_approved=1 ORDER BY created_at DESC',
    [req.params.productId]);
  ok(res, { reviews: rows });
}));

router.post('/reviews', optionalAuth, wrap(async (req, res) => {
  const { product_id, name, rating, comment } = req.body;
  const r = parseInt(rating, 10);
  if (!name || !r || r < 1 || r > 5) return bad(res, 400, 'Name and a rating from 1 to 5 are required');
  const id = uuid();
  await pool.query('INSERT INTO reviews (id,product_id,user_id,name,rating,comment) VALUES (?,?,?,?,?,?)',
    [id, product_id || '', req.user?.id || '', name, r, comment || '']);
  await pushNotification(req.app.get('io'), { type: 'review',
    title: `New ${r} star review from ${name}`, body: (comment || '').slice(0, 120), ref_id: id });
  ok(res, { message: 'Thank you! Your review will appear once approved.' });
}));

router.post('/contact', wrap(async (req, res) => {
  const { name, email, phone, message } = req.body;
  if (!name || !message) return bad(res, 400, 'Name and message are required');
  if (!/^[6-9]\d{9}$/.test(String(phone || '').replace(/\D/g, '')))
    return bad(res, 400, 'A valid 10-digit phone number is required');
  if (email && !/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(String(email).trim().toLowerCase()))
    return bad(res, 400, 'Email must be a valid @gmail.com address');
  await pushNotification(req.app.get('io'), {
    type: 'system',
    title: `Message from ${name} (${phone})`,
    body: `${email ? email + ' — ' : ''}${String(message).slice(0, 200)}`,
  });
  ok(res, { message: "Thanks for reaching out. We'll get back to you shortly." });
}));

module.exports = router;
