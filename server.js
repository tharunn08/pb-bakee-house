'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const { pool, testConnection } = require('./config/db');
const { runSchema } = require('./config/schema');
const { uuid } = require('./utils/helpers');
const { UPLOAD_ROOT } = require('./config/paths');

const app = express();
const server = http.createServer(app);

// Hostinger (and most hosts) sit behind a reverse proxy. Without this,
// express-rate-limit can't reliably read the real client IP from
// X-Forwarded-For and throws/misbehaves. '1' = trust exactly one hop
// (the platform's proxy) in front of the app.
app.set('trust proxy', 1);

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
app.set('io', io);

io.on('connection', socket => {
  socket.on('join_admin', token => {
    try {
      const d = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
      if (['staff', 'manager', 'owner'].includes(d.role)) {
        socket.join('admin');
        socket.emit('joined', { room: 'admin' });
        console.log(`Admin socket connected: ${d.email}`);
      }
    } catch { /* ignore */ }
  });
  socket.on('track_order', order_no => socket.join(`order_${order_no}`));
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.disable('x-powered-by');
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
}));
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
}));
// Stricter limits on order placement and payment confirmation (abuse / fraud protection).
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30,
  message: { success: false, message: 'Too many order attempts. Please wait a few minutes.' },
});
app.use('/api/orders', (req, res, next) => {
  if (req.method === 'POST') return orderLimiter(req, res, next);
  next();
});

app.use('/uploads', express.static(UPLOAD_ROOT));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(express.static(path.join(__dirname, 'frontend'), {
  maxAge: '1d',            // browser caching for CSS/JS/images
  setHeaders(res, filePath) {
    if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Explicit root route — serves the storefront home page directly instead of
// relying only on express.static's implicit index.html resolution, so a
// misconfigured deploy fails loudly here rather than as a silent 404 elsewhere.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/misc'));
app.use('/api', require('./routes/content'));   // added: categories, settings, custom cakes

app.get('/api/health', (_req, res) => res.json({ success: true, status: 'running', time: new Date().toISOString() }));

// SEO: sitemap.xml — static pages plus every in-stock/available product,
// generated live from the database so it never goes stale.
const SITE_URL = (process.env.SITE_URL || 'https://pbbakehouse.com').replace(/\/$/, '');
app.get('/sitemap.xml', async (_req, res) => {
  try {
    const staticPages = [
      { loc: '/', priority: '1.0', changefreq: 'daily' },
      { loc: '/menu.html', priority: '0.9', changefreq: 'daily' },
      { loc: '/custom-cakes.html', priority: '0.8', changefreq: 'weekly' },
      { loc: '/about.html', priority: '0.7', changefreq: 'monthly' },
      { loc: '/track.html', priority: '0.3', changefreq: 'monthly' },
    ];
    let productUrls = [];
    try {
      const [rows] = await pool.query(
        'SELECT id, updated_at FROM products WHERE is_available = 1 ORDER BY updated_at DESC'
      );
      productUrls = rows.map(r => ({
        loc: `/product.html?id=${r.id}`,
        lastmod: new Date(r.updated_at).toISOString().slice(0, 10),
        priority: '0.7',
        changefreq: 'weekly',
      }));
    } catch { /* DB not reachable — ship the static pages only */ }

    const urlXml = (u) => `  <url>\n    <loc>${SITE_URL}${u.loc}</loc>\n${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''}    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...staticPages, ...productUrls].map(urlXml).join('\n')}\n</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
});

app.get('/admin*', (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

// Final fallback for anything unmatched: JSON 404 for API calls, a plain
// (still on-brand) 404 page for everything else on the storefront.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, message: 'Endpoint not found' });
  res.status(404).type('html').send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<title>Page not found — PB Bake House</title>' +
    '<meta name="robots" content="noindex">' +
    '<style>body{font-family:system-ui,sans-serif;background:#FFF8F2;color:#2D1B12;' +
    'display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}' +
    'a{color:#8B4513;font-weight:600}</style></head><body><div>' +
    '<h1 style="font-size:56px;margin:0">404</h1>' +
    '<p style="margin:12px 0 20px">That page doesn\'t exist.</p>' +
    '<a href="/">Back to the homepage</a></div></body></html>'
  );
});

app.use((err, _req, res, _next) => {
  console.error('ERROR:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: 'Image is too large (max 5 MB)' });
  res.status(err.status || 500).json({ success: false, message: err.message || 'Something went wrong on our end' });
});

async function ensureOwner() {
  const email = (process.env.ADMIN_EMAIL || 'admin@pbbakehouse.com').toLowerCase();
  const [rows] = await pool.query('SELECT id FROM users WHERE email=?', [email]);
  if (rows.length) return;
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin@123', 10);
  await pool.query('INSERT INTO users (id,name,email,password,role) VALUES (?,?,?,?,?)',
    [uuid(), process.env.ADMIN_NAME || 'Owner', email, hash, 'owner']);
  // Never log the password itself — only confirm the account exists and where to sign in.
  console.log(`Owner account created -> ${email}`);
  console.log('   Sign in with the ADMIN_PASSWORD set in your environment, then change it.');
}

const PORT = process.env.PORT || 5000;

(async () => {
  try {
    await testConnection();
    await runSchema();
    await ensureOwner();
    server.listen(PORT, () => {
      console.log('');
      console.log('  PB BAKE HOUSE');
      console.log(`  Storefront      http://localhost:${PORT}`);
      console.log(`  Control Center  http://localhost:${PORT}/admin`);
      console.log('  Real-time alerts active');
      console.log('');
    });
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
})();
