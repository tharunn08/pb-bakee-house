'use strict';
const path = require('path');
const fs = require('fs');

/*
 * Persistent upload root.
 *
 * WHY THIS FILE EXISTS:
 * Hostinger's Node.js hosting deploys each build into a brand-new folder
 * (e.g. .../hbuilds/versions/<uuid>/nodejs/...) and then points the app at
 * that folder. Anything written under the app's own directory (like the old
 * `./uploads` folder) lives inside that per-deploy folder, so the very next
 * deploy starts from a fresh copy and every previously uploaded image is
 * gone even though nothing about your code changed.
 *
 * Fix: store uploads at an absolute path OUTSIDE the versioned build
 * directory, set once via the UPLOAD_DIR environment variable. That folder
 * is never touched by the deploy/build process, so files survive redeploys
 * forever - 1 time or 1000 times.
 *
 * Set UPLOAD_DIR in Hostinger hPanel -> your Node.js app -> Environment
 * variables, to something like:
 *   /home/u740669061/domains/pbbakehouse.com/persistent_uploads
 * (a sibling of the `hbuilds` folder - NOT inside it).
 *
 * If UPLOAD_DIR is not set, this falls back to ./uploads next to the app
 * (fine for local development, but NOT safe on Hostinger).
 */
const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

module.exports = { UPLOAD_ROOT };
