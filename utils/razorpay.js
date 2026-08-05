'use strict';
const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

/* True only when the site is deliberately switched to live payments AND both
   Razorpay keys are actually configured. Everywhere else in the app falls
   back to the old mock/manual-confirm flow so checkout never breaks just
   because a key is missing. */
function isLive() {
  return String(process.env.PAYMENT_MODE || 'mock').toLowerCase() === 'live'
    && !!KEY_ID && !!KEY_SECRET;
}

/* Create a Razorpay order via their REST API (no SDK dependency needed —
   Node 18+ has fetch built in). Amount is rupees; Razorpay wants paise. */
async function createOrder({ amount, receipt, notes }) {
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  const resp = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      amount: Math.round(Number(amount) * 100),
      currency: 'INR',
      receipt,
      notes: notes || {},
      payment_capture: 1,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.description || 'Could not create Razorpay order');
  return data; // { id, amount, currency, ... }
}

/* Razorpay signs order_id|payment_id with the key secret (HMAC SHA-256).
   Recomputing it server-side is the only way to know a payment is real —
   never trust payment_id/signature sent by the browser without this check. */
function verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  const expected = crypto.createHmac('sha256', KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  return expected === razorpay_signature;
}

module.exports = { isLive, createOrder, verifySignature, KEY_ID };
