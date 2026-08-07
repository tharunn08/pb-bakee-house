'use strict';
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pb_bake_house',
  waitForConnections: true,
  // Raised from 10 -> configurable (default 25). At ~500 members browsing/
  // ordering, most requests are short SELECTs that finish in a few ms, so a
  // pool this size comfortably serves that traffic without exhausting the
  // DB server's own max_connections (shared MySQL on Hostinger is typically
  // capped around 50-100 per database). Override with DB_POOL_LIMIT if your
  // plan allows more, or you see "Too many connections" during a load spike.
  connectionLimit: parseInt(process.env.DB_POOL_LIMIT, 10) || 25,
  // Requests wait in a queue instead of failing outright when every
  // connection is briefly busy (e.g. a burst of orders at once).
  queueLimit: 0,
  // Kill a query that hangs instead of holding a pool slot forever and
  // slowly starving every other request behind it.
  connectTimeout: 10000,
  // Keeps idle connections alive through shared-hosting NAT/proxy timeouts
  // so the pool doesn't silently degrade to reconnecting on every request.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // Use the FULL collation name (not just 'utf8mb4', which silently defaults to
  // utf8mb4_general_ci and clashes with our utf8mb4_unicode_ci tables ->
  // "Illegal mix of collations" on every string comparison / JOIN).
  charset: 'utf8mb4_unicode_ci',
  dateStrings: true,
  multipleStatements: false,
});

/** Creates the database if it does not exist, then verifies the pool. */
async function testConnection() {
  const boot = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });
  await boot.query(
    `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'pb_bake_house'}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await boot.end();

  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
  console.log('✅ MySQL connected');
}

// Every fresh pool connection re-declares its collation so string literals and
// columns always compare under the same rule.
pool.on('connection', c => {
  c.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
});

module.exports = { pool, testConnection };
