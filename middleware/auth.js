'use strict';
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const SECRET = () => process.env.JWT_SECRET || 'dev_secret_change_me';

function sign(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    SECRET(),
    { expiresIn: process.env.JWT_EXPIRY || '7d' }
  );
}

async function protect(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, SECRET());
    const [rows] = await pool.query(
      'SELECT id,name,email,phone,role,is_active FROM users WHERE id=? LIMIT 1', [decoded.id]);
    if (!rows.length || !rows[0].is_active)
      return res.status(401).json({ success: false, message: 'Account unavailable' });
    req.user = rows[0];
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired session' });
  }
}

const STAFF_ROLES = ['staff', 'manager', 'owner'];

function adminOnly(req, res, next) {
  if (!req.user || !STAFF_ROLES.includes(req.user.role))
    return res.status(403).json({ success: false, message: 'Admin access required' });
  next();
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    next();
  };
}

async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const decoded = jwt.verify(token, SECRET());
      const [rows] = await pool.query('SELECT id,name,email,phone,role FROM users WHERE id=?', [decoded.id]);
      if (rows.length) req.user = rows[0];
    } catch { /* ignore */ }
  }
  next();
}

module.exports = { sign, protect, adminOnly, allowRoles, optionalAuth, STAFF_ROLES };
