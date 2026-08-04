'use strict';
const crypto = require('crypto');
const { pool } = require('../config/db');

const uuid = () => crypto.randomUUID();

const slugify = s => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');

function makeOrderNo() {
  const d = new Date();
  const y = String(d.getFullYear()).slice(2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const r = Math.floor(1000 + Math.random() * 9000);
  return `PB${y}${m}${day}${r}`;
}

async function pushNotification(io, { type, title, body = '', ref_id = '' }) {
  const id = uuid();
  await pool.query(
    'INSERT INTO notifications (id,type,title,body,ref_id) VALUES (?,?,?,?,?)',
    [id, type, title, body, ref_id]
  );
  const payload = { id, type, title, body, ref_id, is_read: 0, created_at: new Date().toISOString() };
  if (io) io.to('admin').emit('notification', payload);
  return payload;
}

async function audit(actor, action, entity, entity_id, details = '') {
  try {
    await pool.query(
      'INSERT INTO audit_log (id,actor,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)',
      [uuid(), actor, action, entity, String(entity_id), String(details).slice(0, 600)]
    );
  } catch (e) { console.warn('audit failed:', e.message); }
}

async function adjustStock(product_id, change_qty, reason, ref_order = '') {
  await pool.query(
    'UPDATE products SET stock = GREATEST(0, stock + ?) WHERE id=?',
    [change_qty, product_id]
  );
  const [[p]] = await pool.query('SELECT stock FROM products WHERE id=?', [product_id]);
  const balance = p ? p.stock : 0;
  await pool.query(
    'INSERT INTO stock_log (id,product_id,change_qty,reason,ref_order,balance) VALUES (?,?,?,?,?,?)',
    [uuid(), product_id, change_qty, reason, ref_order, balance]
  );
  if (balance <= 0) {
    await pool.query('UPDATE products SET is_available=0 WHERE id=?', [product_id]);
  }
  return balance;
}

const money = n => Math.round(Number(n || 0) * 100) / 100;
const ok  = (res, data = {}) => res.json({ success: true, ...data });
const bad = (res, code, message) => res.status(code).json({ success: false, message });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The `items` column is a MySQL JSON type, which mysql2 may return EITHER as a
// parsed array/object OR as a raw string depending on driver/config. This
// normalises both cases safely (calling JSON.parse on an already-parsed value
// throws the classic `"[object Object]" is not valid JSON`).
function safeItems(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return []; }
}

module.exports = { uuid, slugify, makeOrderNo, pushNotification, audit, adjustStock, money, ok, bad, wrap, safeItems };
