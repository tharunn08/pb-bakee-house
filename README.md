# PB Bake House

A bakery ordering platform: customer storefront, admin control center, Node/Express
backend, MySQL database. Everything lives in **one deployable project root** — there is
exactly one `package.json` and one `server.js`, and `frontend/` and `admin/` are served
as static folders directly beside them.

```
pb-bake-house/
├── server.js            # single entry point
├── package.json
├── .env.example          # copy to .env and fill in
├── config/
│   ├── db.js              # single mysql2/promise pool
│   └── schema.js          # creates/updates tables on boot, never drops data
├── middleware/
│   ├── auth.js             # JWT verification, role checks
│   └── upload.js           # multer: type + size validated uploads
├── routes/                 # auth, products, orders, admin, content, misc
├── utils/                  # delivery pricing, email, helpers, seed data
├── uploads/                 # product/banner/category images (created for you)
├── frontend/                # customer-facing site (served at /)
└── admin/                    # control center (served at /admin)
```

## 1. Install

```bash
npm install
```

## 2. Environment variables

Copy `.env.example` to `.env` and fill in real values. Nothing is hardcoded in the
code — every credential, business detail, and toggle comes from this file.

| Group | Keys |
|---|---|
| Server | `PORT`, `NODE_ENV`, `FRONTEND_URL`, `SITE_URL` |
| Database | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` |
| Auth | `JWT_SECRET`, `JWT_EXPIRY` |
| Admin account | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `ADMIN_NOTIFY_EMAIL` |
| Bakery / SEO | `BAKERY_NAME`, `BAKERY_ADDRESS`, `BAKERY_LAT`, `BAKERY_LNG`, `BAKERY_MAPS_URL`, `BAKERY_PLUS_CODE` |
| Delivery | `DELIVERY_BASE_FARE`, `DELIVERY_BASE_KM`, `DELIVERY_PER_EXTRA_KM`, `DELIVERY_MAX_KM`, `FREE_DELIVERY_ABOVE`, `FREE_DELIVERY_WITHIN_KM`, `DEFAULT_DELIVERY_MINUTES` |
| Payments | `PAYMENT_MODE`, `RAZORPAY_PAYMENT_LINK`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` |
| Social | `CONTACT_WHATSAPP`, `CONTACT_PHONE`, `CONTACT_INSTAGRAM`, `INSTAGRAM_HANDLE`, `INSTAGRAM_FOLLOW_DISCOUNT` |
| Legal | `FSSAI_LICENSE`, `GST_NUMBER` |
| Misc | `GOOGLE_MAPS_API_KEY`, `DEVELOPER_NAME`, `DEVELOPER_URL` |

**Never commit `.env`.** It's already in `.gitignore`.

## 3. Database

Create an empty MySQL database matching `DB_NAME`. You don't need to create any
tables yourself — the app does it on boot.

Startup order, every time the server starts:

```
Load .env → Connect to MySQL → Run/verify schema → Ensure admin account exists → Start listening
```

If the database connection fails, the process logs the error and **exits** — it will
never boot into a broken half-working state. The schema step only creates tables/columns
that are missing; it never drops or overwrites existing data, so it's safe to restart
against a database that already has orders/products in it.

## 4. Run locally

```bash
npm start          # production
npm run dev         # auto-restarts on file changes
```

Then open:
- Storefront: `http://localhost:5000`
- Control Center: `http://localhost:5000/admin` (sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`)

## 5. Deploying to Hostinger (shared/Business hosting, Node.js Web App)

1. **hPanel → Websites → Add Website → Deploy Web App → Node.js.** Either connect
   your GitHub repo, or upload this whole folder as a ZIP (minus `node_modules` —
   Hostinger installs dependencies itself).
2. Set the **startup file** to `server.js` (it's at the project root, not inside a
   subfolder — this is what fixes the `ENOENT .../admin/index.html` / `Cannot GET /`
   errors from earlier deploys, where the backend was uploaded separately from
   `frontend`/`admin`).
3. **hPanel → Databases → MySQL Databases** — create a database and user, note the
   host/name/user/password.
4. In the Node.js app's **Environment Variables** panel, set every key from
   `.env.example` with real values (safer than uploading `.env` directly). Set
   `NODE_ENV=production` and `SITE_URL=https://yourdomain.com`. Don't set `PORT` —
   Hostinger assigns it and the app already reads `process.env.PORT`.
5. Point the app at your domain and enable the free SSL certificate in hPanel.
6. Verify: visit `/`, `/admin`, `/sitemap.xml`, and `/robots.txt` on your live domain —
   all four should load without errors.

**Two things to watch on shared hosting specifically:**
- Uploaded product/banner images live in `uploads/` on disk. If a redeploy ever
  resets the app directory, back up that folder first via the File Manager.
- Live order alerts use Socket.io with a polling fallback, so they should work even
  if raw WebSocket upgrades aren't proxied — but test the admin notification bell
  after your first deploy.

## 6. Deploying via GitHub (auto-deploy)

Push this repository to GitHub, then in hPanel's Node.js Web App setup choose
**Connect GitHub** instead of ZIP upload. Every push to your chosen branch triggers
a redeploy automatically — no manual file moving required, because the whole app
(backend + frontend + admin) already lives in one repo root.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot GET /` | Static folders not found relative to `server.js` | Confirm `frontend/` and `admin/` are siblings of `server.js` in the deployed root — this is the layout this project now uses by default |
| `ENOENT ... admin/index.html` | Same as above — backend was deployed without its sibling folders | Redeploy the full project root, not just a `backend` subfolder |
| Server exits immediately on boot | Database unreachable | Check `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` in your environment variables |
| Admin login fails after first boot | `ADMIN_EMAIL`/`ADMIN_PASSWORD` not set before first run | Set them in `.env` (or hosting env vars) before the very first boot — that's when the owner account is created |
| Images uploaded in admin disappear | Redeploy wiped `uploads/` | Back up `uploads/` before redeploying on managed hosting |
| Search Console can't find pages | Sitemap not submitted | Submit `https://yourdomain.com/sitemap.xml` in Google Search Console |

## 8. Security already built in

Helmet (secure HTTP headers), CORS restricted to `FRONTEND_URL`, rate limiting
(global API, stricter on login and order placement), bcrypt password hashing, JWT
auth with expiry, parameterized SQL everywhere (`mysql2` placeholders — no string-built
queries), and file upload validation (type + size limit) in `middleware/upload.js`.

## 9. What's preserved

Every existing feature is unchanged: customer storefront, admin dashboard, orders,
products, categories, login/registration, checkout, order tracking, custom cake
requests, reviews, Razorpay payment link integration, real-time order notifications,
and all admin CRUD screens. This restructuring only changed *where files live on
disk* and *how the server finds them* — no UI, no API contract, no database schema
was altered.
