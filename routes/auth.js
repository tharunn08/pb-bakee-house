'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { sign, protect } = require('../middleware/auth');
const { uuid, ok, bad, wrap, audit } = require('../utils/helpers');

router.post('/register', wrap(async (req, res) => {
  const { name, email, password, phone = '' } = req.body;
  if (!name || !email || !password) return bad(res, 400, 'Name, email and password are required');
  if (String(password).length < 6) return bad(res, 400, 'Password must be at least 6 characters');
  const [exists] = await pool.query('SELECT id FROM users WHERE email=?', [email.toLowerCase()]);
  if (exists.length) return bad(res, 409, 'An account with this email already exists');
  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (id,name,email,phone,password,role) VALUES (?,?,?,?,?,?)',
    [id, name, email.toLowerCase(), phone, hash, 'customer']);
  const user = { id, name, email: email.toLowerCase(), phone, role: 'customer' };
  ok(res, { token: sign(user), user });
}));

router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return bad(res, 400, 'Email and password are required');
  const [rows] = await pool.query('SELECT * FROM users WHERE email=? LIMIT 1', [email.toLowerCase()]);
  if (!rows.length) return bad(res, 401, 'Invalid email or password');
  const u = rows[0];
  if (!u.is_active) return bad(res, 403, 'This account has been disabled');
  if (!(await bcrypt.compare(password, u.password))) return bad(res, 401, 'Invalid email or password');
  const user = { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role };
  await pool.query('UPDATE users SET last_login_at=NOW() WHERE id=?', [u.id]).catch(() => {});
  if (u.role !== 'customer') await audit(u.email, 'login', 'user', u.id);
  ok(res, { token: sign(user), user });
}));

router.get('/me', protect, wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id,name,email,phone,role,address_line,city,pincode,lat,lng FROM users WHERE id=?', [req.user.id]);
  ok(res, { user: rows[0] });
}));

router.put('/me', protect, wrap(async (req, res) => {
  const { name, phone, address_line, city, pincode, lat, lng } = req.body;
  await pool.query(
    `UPDATE users SET name=COALESCE(?,name), phone=COALESCE(?,phone),
       address_line=COALESCE(?,address_line), city=COALESCE(?,city),
       pincode=COALESCE(?,pincode), lat=COALESCE(?,lat), lng=COALESCE(?,lng) WHERE id=?`,
    [name ?? null, phone ?? null, address_line ?? null, city ?? null, pincode ?? null, lat ?? null, lng ?? null, req.user.id]);
  const [rows] = await pool.query(
    'SELECT id,name,email,phone,role,address_line,city,pincode,lat,lng FROM users WHERE id=?', [req.user.id]);
  ok(res, { user: rows[0] });
}));

router.put('/password', protect, wrap(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 6) return bad(res, 400, 'New password must be at least 6 characters');
  const [rows] = await pool.query('SELECT password FROM users WHERE id=?', [req.user.id]);
  if (!(await bcrypt.compare(current_password || '', rows[0].password)))
    return bad(res, 401, 'Current password is incorrect');
  await pool.query('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(new_password, 10), req.user.id]);
  ok(res, { message: 'Password updated' });
}));

module.exports = router;
