'use strict';
require('dotenv').config();
const { pool, testConnection } = require('../config/db');
const { runSchema } = require('../config/schema');
const { uuid, slugify } = require('./helpers');

const PRODUCTS = [
  { name: 'Chocolate Truffle Cake', category: 'Cakes', price: 650, offer_price: 599, weight: '1 Kg', stock: 15, prep_minutes: 60, is_featured: 1, is_trending: 1, description: 'Rich Belgian chocolate layers with silky truffle ganache.' },
  { name: 'Black Forest Cake', category: 'Cakes', price: 600, offer_price: null, weight: '1 Kg', stock: 12, prep_minutes: 60, is_featured: 1, description: 'Classic cherry and cream layered chocolate sponge.' },
  { name: 'Red Velvet Cake', category: 'Cakes', price: 750, offer_price: 699, weight: '1 Kg', stock: 10, prep_minutes: 60, is_trending: 1, description: 'Velvety cocoa sponge with cream cheese frosting.' },
  { name: 'Butterscotch Cake', category: 'Cakes', price: 620, offer_price: null, weight: '1 Kg', stock: 8, prep_minutes: 60, description: 'Caramel crunch folded through fresh cream.' },
  { name: 'Pineapple Cake', category: 'Cakes', price: 550, offer_price: null, weight: '1 Kg', stock: 14, prep_minutes: 60, is_eggless: 1, description: 'Light sponge with pineapple chunks and cream.' },
  { name: 'Vanilla Cupcakes', category: 'Cupcakes', price: 180, offer_price: 149, weight: '6 pcs', stock: 30, prep_minutes: 25, is_trending: 1, description: 'Soft vanilla cupcakes with buttercream swirls.' },
  { name: 'Chocolate Cupcakes', category: 'Cupcakes', price: 200, offer_price: null, weight: '6 pcs', stock: 24, prep_minutes: 25, description: 'Fudgy cupcakes topped with chocolate frosting.' },
  { name: 'Garlic Bread', category: 'Breads', price: 120, offer_price: null, weight: '250 g', stock: 40, prep_minutes: 20, description: 'Oven-baked with herb garlic butter.' },
  { name: 'Whole Wheat Bread', category: 'Breads', price: 60, offer_price: null, weight: '400 g', stock: 35, prep_minutes: 15, is_eggless: 1, description: 'Daily-baked wholesome wheat loaf.' },
  { name: 'Butter Croissant', category: 'Pastries', price: 90, offer_price: null, weight: '1 pc', stock: 25, prep_minutes: 15, is_featured: 1, description: 'Flaky, buttery, laminated to perfection.' },
  { name: 'Chocolate Pastry', category: 'Pastries', price: 80, offer_price: 70, weight: '1 pc', stock: 28, prep_minutes: 15, description: 'Single-serve slice of chocolate indulgence.' },
  { name: 'Choco Chip Cookies', category: 'Cookies', price: 220, offer_price: null, weight: '250 g', stock: 20, prep_minutes: 20, description: 'Crisp edges, chewy centre, loaded with chips.' },
  { name: 'Butter Cookies', category: 'Cookies', price: 180, offer_price: null, weight: '250 g', stock: 22, prep_minutes: 20, is_eggless: 1, description: 'Melt-in-mouth traditional butter biscuits.' },
  { name: 'Blueberry Muffins', category: 'Muffins', price: 160, offer_price: 139, weight: '4 pcs', stock: 18, prep_minutes: 25, description: 'Bursting with real blueberries.' },
  { name: 'Brownie Box', category: 'Brownies', price: 280, offer_price: 249, weight: '6 pcs', stock: 16, prep_minutes: 30, is_trending: 1, description: 'Dense, fudgy walnut brownies.' },
];

const COUPONS = [
  { code: 'WELCOME10', type: 'percent', value: 10, min_order: 500, max_discount: 150 },
  { code: 'SWEET50', type: 'flat', value: 50, min_order: 400, max_discount: 0 },
];

(async () => {
  await testConnection();
  await runSchema();
  const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM products');
  if (n > 0) {
    console.log(`${n} products already exist - skipping product seed.`);
  } else {
    for (const p of PRODUCTS) {
      const id = uuid();
      await pool.query(
        `INSERT INTO products (id,name,slug,description,category,price,offer_price,cost_price,weight,unit,
           stock,low_stock_at,prep_minutes,image,is_available,is_featured,is_trending,is_eggless)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'',1,?,?,?)`,
        [id, p.name, slugify(p.name), p.description, p.category, p.price, p.offer_price,
         Math.round(p.price * 0.55), p.weight, 'piece', p.stock, 5, p.prep_minutes,
         p.is_featured || 0, p.is_trending || 0, p.is_eggless || 0]);
      await pool.query('INSERT INTO stock_log (id,product_id,change_qty,reason,balance) VALUES (?,?,?,?,?)',
        [uuid(), id, p.stock, 'Seed stock', p.stock]);
    }
    console.log(`Seeded ${PRODUCTS.length} products (images left blank for you to upload)`);
  }
  for (const c of COUPONS) {
    await pool.query(
      `INSERT IGNORE INTO coupons (id,code,type,value,min_order,max_discount,is_active) VALUES (?,?,?,?,?,?,1)`,
      [uuid(), c.code, c.type, c.value, c.min_order, c.max_discount]);
  }
  console.log('Seeded coupons');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
