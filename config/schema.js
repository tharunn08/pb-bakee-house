'use strict';
const { pool } = require('./db');

const TABLES = [

/* ── Users ───────────────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS users (
  id           VARCHAR(36)  PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  email        VARCHAR(150) NOT NULL UNIQUE,
  phone        VARCHAR(20)  DEFAULT '',
  password     VARCHAR(255) NOT NULL,
  role         ENUM('customer','staff','manager','owner') DEFAULT 'customer',
  address_line VARCHAR(300) DEFAULT '',
  city         VARCHAR(100) DEFAULT '',
  pincode      VARCHAR(12)  DEFAULT '',
  lat          DECIMAL(10,7) NULL,
  lng          DECIMAL(10,7) NULL,
  is_active    TINYINT(1)   DEFAULT 1,
  created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_role (role),
  INDEX idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Categories ──────────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS categories (
  id         VARCHAR(36)  PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  slug       VARCHAR(120) NOT NULL UNIQUE,
  image      VARCHAR(255) DEFAULT '',
  sort_order INT          DEFAULT 0,
  is_active  TINYINT(1)   DEFAULT 1,
  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Products ────────────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS products (
  id            VARCHAR(36)   PRIMARY KEY,
  name          VARCHAR(200)  NOT NULL,
  slug          VARCHAR(220)  DEFAULT '',
  description   TEXT,
  category      VARCHAR(100)  NOT NULL DEFAULT 'General',
  price         DECIMAL(10,2) NOT NULL DEFAULT 0,
  offer_price   DECIMAL(10,2) NULL,
  cost_price    DECIMAL(10,2) DEFAULT 0,
  weight        VARCHAR(50)   DEFAULT '',
  unit          VARCHAR(20)   DEFAULT 'piece',
  stock         INT           DEFAULT 0,
  low_stock_at  INT           DEFAULT 5,
  prep_minutes  INT           DEFAULT 30,
  image         VARCHAR(255)  DEFAULT '',
  is_available  TINYINT(1)    DEFAULT 1,
  is_featured   TINYINT(1)    DEFAULT 0,
  is_trending   TINYINT(1)    DEFAULT 0,
  is_eggless    TINYINT(1)    DEFAULT 0,
  total_sold    INT           DEFAULT 0,
  rating        DECIMAL(3,1)  DEFAULT 0,
  review_count  INT           DEFAULT 0,
  created_at    DATETIME      DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_cat (category),
  INDEX idx_avail (is_available),
  INDEX idx_stock (stock),
  INDEX idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Product extra images ────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS product_images (
  id         VARCHAR(36)  PRIMARY KEY,
  product_id VARCHAR(36)  NOT NULL,
  filename   VARCHAR(255) NOT NULL,
  sort_order INT          DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_p (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Orders ──────────────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS orders (
  id                VARCHAR(36)   PRIMARY KEY,
  order_no          VARCHAR(30)   NOT NULL UNIQUE,
  user_id           VARCHAR(36)   NULL,
  customer_name     VARCHAR(120)  NOT NULL,
  customer_phone    VARCHAR(20)   NOT NULL,
  customer_email    VARCHAR(150)  DEFAULT '',
  items             JSON          NOT NULL,
  subtotal          DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount          DECIMAL(10,2) NOT NULL DEFAULT 0,
  coupon_code       VARCHAR(50)   DEFAULT '',
  delivery_charge   DECIMAL(10,2) NOT NULL DEFAULT 0,
  distance_km       DECIMAL(6,2)  DEFAULT 0,
  total             DECIMAL(10,2) NOT NULL DEFAULT 0,
  order_type        ENUM('delivery','pickup') DEFAULT 'delivery',
  address_line      VARCHAR(400)  DEFAULT '',
  city              VARCHAR(100)  DEFAULT '',
  pincode           VARCHAR(12)   DEFAULT '',
  lat               DECIMAL(10,7) NULL,
  lng               DECIMAL(10,7) NULL,
  delivery_date     DATE          NULL,
  delivery_slot     VARCHAR(50)   DEFAULT '',
  status            ENUM('pending','accepted','preparing','ready','out_for_delivery','delivered','cancelled') DEFAULT 'pending',
  payment_method    ENUM('cod','online') DEFAULT 'cod',
  payment_status    ENUM('pending','paid','failed','refunded') DEFAULT 'pending',
  notes             TEXT,
  created_at        DATETIME      DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_created (created_at),
  INDEX idx_phone (customer_phone),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Order status history ────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS order_status_history (
  id         VARCHAR(36) PRIMARY KEY,
  order_id   VARCHAR(36) NOT NULL,
  status     VARCHAR(40) NOT NULL,
  changed_by VARCHAR(120) DEFAULT 'system',
  created_at DATETIME    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_o (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Stock movement log ──────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS stock_log (
  id         VARCHAR(36) PRIMARY KEY,
  product_id VARCHAR(36) NOT NULL,
  change_qty INT         NOT NULL,
  reason     VARCHAR(120) DEFAULT '',
  ref_order  VARCHAR(30)  DEFAULT '',
  balance    INT          DEFAULT 0,
  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_p (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Notifications ───────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS notifications (
  id         VARCHAR(36)  PRIMARY KEY,
  type       ENUM('new_order','payment_failed','low_stock','review','custom_order','system') DEFAULT 'system',
  title      VARCHAR(200) NOT NULL,
  body       VARCHAR(500) DEFAULT '',
  ref_id     VARCHAR(60)  DEFAULT '',
  is_read    TINYINT(1)   DEFAULT 0,
  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_read (is_read),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Coupons ─────────────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS coupons (
  id           VARCHAR(36)  PRIMARY KEY,
  code         VARCHAR(50)  NOT NULL UNIQUE,
  type         ENUM('percent','flat') DEFAULT 'percent',
  value        DECIMAL(10,2) NOT NULL,
  min_order    DECIMAL(10,2) DEFAULT 0,
  max_discount DECIMAL(10,2) DEFAULT 0,
  expires_on   DATE          NULL,
  usage_limit  INT           DEFAULT 0,
  used_count   INT           DEFAULT 0,
  is_active    TINYINT(1)    DEFAULT 1,
  created_at   DATETIME      DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Banners ─────────────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS banners (
  id         VARCHAR(36)  PRIMARY KEY,
  title      VARCHAR(200) DEFAULT '',
  subtitle   VARCHAR(300) DEFAULT '',
  image      VARCHAR(255) DEFAULT '',
  link       VARCHAR(500) DEFAULT '',
  is_active  TINYINT(1)   DEFAULT 1,
  sort_order INT          DEFAULT 0,
  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Reviews ─────────────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS reviews (
  id          VARCHAR(36)  PRIMARY KEY,
  product_id  VARCHAR(36)  DEFAULT '',
  user_id     VARCHAR(36)  DEFAULT '',
  name        VARCHAR(100) NOT NULL,
  rating      TINYINT      NOT NULL,
  comment     TEXT,
  reply       TEXT,
  is_approved TINYINT(1)   DEFAULT 0,
  created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_p (product_id),
  INDEX idx_a (is_approved)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Expenses (for profit report) ────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS expenses (
  id         VARCHAR(36)   PRIMARY KEY,
  title      VARCHAR(200)  NOT NULL,
  category   VARCHAR(80)   DEFAULT 'General',
  amount     DECIMAL(10,2) NOT NULL,
  spent_on   DATE          NOT NULL,
  note       VARCHAR(300)  DEFAULT '',
  created_at DATETIME      DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_date (spent_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Audit log ───────────────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS audit_log (
  id         VARCHAR(36)  PRIMARY KEY,
  actor      VARCHAR(150) DEFAULT '',
  action     VARCHAR(100) NOT NULL,
  entity     VARCHAR(60)  DEFAULT '',
  entity_id  VARCHAR(60)  DEFAULT '',
  details    VARCHAR(600) DEFAULT '',
  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Settings (key/value) ────────────────────────────────────────── */
`CREATE TABLE IF NOT EXISTS settings (
  skey       VARCHAR(60)  PRIMARY KEY,
  svalue     VARCHAR(500) DEFAULT '',
  updated_at DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Custom cake enquiries (added) ───────────────────────────────── */
`CREATE TABLE IF NOT EXISTS custom_cake_requests (
  id            VARCHAR(36)  PRIMARY KEY,
  ref_no        VARCHAR(20)  NOT NULL UNIQUE,
  customer_name VARCHAR(100) NOT NULL,
  phone         VARCHAR(20)  NOT NULL,
  email         VARCHAR(150) DEFAULT '',
  flavour       VARCHAR(80)  DEFAULT '',
  weight        VARCHAR(40)  DEFAULT '',
  occasion      VARCHAR(80)  DEFAULT '',
  needed_on     DATE         NULL,
  message_on_cake VARCHAR(200) DEFAULT '',
  instructions  TEXT,
  reference_image VARCHAR(255) DEFAULT '',
  budget        DECIMAL(10,2) NULL,
  status        ENUM('new','contacted','quoted','confirmed','completed','cancelled') DEFAULT 'new',
  admin_note    TEXT,
  quoted_price  DECIMAL(10,2) NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

/* ── Custom cake design gallery (added) ──────────────────────────── */
`CREATE TABLE IF NOT EXISTS custom_cake_designs (
  id           VARCHAR(36)  PRIMARY KEY,
  title        VARCHAR(120) NOT NULL,
  description  VARCHAR(400) DEFAULT '',
  image        VARCHAR(255) DEFAULT '',
  base_price   DECIMAL(10,2) NULL,
  flavours     VARCHAR(300) DEFAULT '',
  weights      VARCHAR(200) DEFAULT '',
  occasion     VARCHAR(80)  DEFAULT '',
  tags         VARCHAR(200) DEFAULT '',
  sort_order   INT          DEFAULT 0,
  is_active    TINYINT(1)   DEFAULT 1,
  created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sort (sort_order),
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

];

/* ── Additive column migrations ──────────────────────────────────────
   Each entry is checked against information_schema first, so running this
   repeatedly is safe and nothing existing is ever modified or dropped. */
const COLUMNS = [
  // Split the single banner pool into addressable homepage slots.
  // Existing rows default to 'hero', so the current carousel is unchanged.
  { table: 'banners', column: 'slot',
    ddl: "ALTER TABLE banners ADD COLUMN slot VARCHAR(40) NOT NULL DEFAULT 'hero'" },
  { table: 'banners', column: 'cta_label',
    ddl: "ALTER TABLE banners ADD COLUMN cta_label VARCHAR(60) DEFAULT ''" },
  // Occasion tagging for products (Birthday, Anniversary, Wedding, …)
  { table: 'products', column: 'occasions',
    ddl: "ALTER TABLE products ADD COLUMN occasions VARCHAR(255) DEFAULT ''" },
  // Categories get a description to sit under the name on collection pages.
  { table: 'custom_cake_requests', column: 'design_id',
    ddl: "ALTER TABLE custom_cake_requests ADD COLUMN design_id VARCHAR(36) DEFAULT ''" },
  { table: 'custom_cake_requests', column: 'design_title',
    ddl: "ALTER TABLE custom_cake_requests ADD COLUMN design_title VARCHAR(120) DEFAULT ''" },
  { table: 'categories', column: 'description',
    ddl: "ALTER TABLE categories ADD COLUMN description VARCHAR(300) DEFAULT ''" },
  // Binds an order to the Razorpay order created for it, so confirm-payment
  // can check the signature belongs to THIS order and not a replayed one.
  { table: 'orders', column: 'razorpay_order_id',
    ddl: "ALTER TABLE orders ADD COLUMN razorpay_order_id VARCHAR(64) DEFAULT ''" },
  // Tracks when a customer account last signed in — powers the Registered
  // Accounts view in Admin -> Customers, used for marketing outreach.
  { table: 'users', column: 'last_login_at',
    ddl: "ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL" },
];

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]);
  return rows[0].n > 0;
}

async function runSchema() {
  for (const stmt of TABLES) {
    await pool.query(stmt);
  }
  for (const c of COLUMNS) {
    try {
      if (!(await columnExists(c.table, c.column))) {
        await pool.query(c.ddl);
        console.log(`   + ${c.table}.${c.column}`);
      }
    } catch (e) {
      // Never let an optional column block boot.
      console.warn(`   ! ${c.table}.${c.column}: ${e.message}`);
    }
  }
  console.log('✅ Schema ready');
}

module.exports = { runSchema };
