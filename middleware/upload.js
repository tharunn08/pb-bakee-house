'use strict';
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function makeStorage(folder) {
  const dir = path.join(__dirname, '..', 'uploads', folder);
  fs.mkdirSync(dir, { recursive: true });
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  });
}

const imageFilter = (_req, file, cb) => {
  if (/^image\/(jpeg|jpg|png|webp|gif|svg\+xml)$/.test(file.mimetype)) return cb(null, true);
  cb(new Error('Only image files are allowed'));
};

const productUpload = multer({ storage: makeStorage('products'), fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const bannerUpload  = multer({ storage: makeStorage('banners'),  fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });

/* Added: separate folders so category art, About imagery, site assets and
   customer reference photos never collide with product or banner uploads. */
const categoryUpload = multer({ storage: makeStorage('categories'), fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const aboutUpload    = multer({ storage: makeStorage('about'),      fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const siteUpload     = multer({ storage: makeStorage('site'),       fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const customUpload   = multer({ storage: makeStorage('custom'),     fileFilter: imageFilter, limits: { fileSize: 8 * 1024 * 1024 } });

module.exports = { productUpload, bannerUpload, categoryUpload, aboutUpload, siteUpload, customUpload };
