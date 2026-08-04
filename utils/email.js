'use strict';
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP not configured - emails will be logged to console only.');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) { console.log(`[DEV EMAIL] To: ${to} | ${subject}`); return { ok: false, dev: true }; }
  try {
    await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html });
    console.log(`Email sent "${subject}" -> ${to}`);
    return { ok: true };
  } catch (err) {
    console.error('Email failed:', err.message);
    return { ok: false, error: err.message };
  }
}

const BLUE = '#1554d1', RED = '#d32030';

const shell = (heading, accent, inner) => `
<div style="font-family:Segoe UI,Arial,sans-serif;background:#f4f6fb;padding:24px">
  <div style="max-width:640px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e3e8f2">
    <div style="background:${accent};color:#fff;padding:20px 24px">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">PB BAKE HOUSE</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${heading}</div>
    </div>
    <div style="padding:24px">${inner}</div>
    <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#7b869c;border-top:1px solid #e3e8f2">
      Automated message from your PB Bake House control center.
    </div>
  </div>
</div>`;

const row = (k, v) => `
<tr>
  <td style="padding:8px 0;color:#6b7689;font-size:13px;width:150px">${k}</td>
  <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:600">${v}</td>
</tr>`;

const itemRows = items => (items || []).map(i => `
<tr>
  <td style="padding:8px;border-bottom:1px solid #eef1f6">${i.name}${i.weight ? ` <span style="color:#8b95a8">(${i.weight})</span>` : ''}</td>
  <td style="padding:8px;border-bottom:1px solid #eef1f6;text-align:center">x ${i.qty}</td>
  <td style="padding:8px;border-bottom:1px solid #eef1f6;text-align:right">Rs.${(i.price * i.qty).toFixed(2)}</td>
</tr>`).join('');

async function notifyAdminNewOrder(order) {
  const to = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL;
  if (!to) return;
  const inner = `
  <div style="background:#fff5f5;border-left:4px solid ${RED};padding:12px 16px;margin-bottom:20px">
    <div style="font-size:20px;font-weight:800;color:${RED}">ORDER #${order.order_no}</div>
    <div style="color:#6b7689;font-size:13px;margin-top:2px">Placed ${new Date(order.created_at || Date.now()).toLocaleString('en-IN')}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    ${row('Customer', order.customer_name)}
    ${row('Phone', `<a href="tel:${order.customer_phone}" style="color:${BLUE}">${order.customer_phone}</a>`)}
    ${order.customer_email ? row('Email', order.customer_email) : ''}
    ${row('Type', order.order_type === 'pickup' ? 'PICKUP' : 'DELIVERY')}
    ${order.order_type !== 'pickup' ? row('Address', `${order.address_line}, ${order.city} ${order.pincode}`) : ''}
    ${order.delivery_date ? row('Delivery date', order.delivery_date) : ''}
    ${order.delivery_slot ? row('Slot', order.delivery_slot) : ''}
    ${row('Payment', `${String(order.payment_method).toUpperCase()} - ${order.payment_status}`)}
    ${order.notes ? row('Notes', order.notes) : ''}
  </table>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="background:#f4f6fb">
      <th style="padding:8px;text-align:left">Item</th>
      <th style="padding:8px;text-align:center">Qty</th>
      <th style="padding:8px;text-align:right">Amount</th>
    </tr></thead>
    <tbody>${itemRows(order.items)}</tbody>
  </table>
  <table style="width:100%;margin-top:16px;font-size:14px">
    ${row('Subtotal', `Rs.${Number(order.subtotal).toFixed(2)}`)}
    ${Number(order.discount) > 0 ? row('Discount', `- Rs.${Number(order.discount).toFixed(2)}`) : ''}
    ${row('Delivery', `Rs.${Number(order.delivery_charge).toFixed(2)} <span style="font-weight:400;color:#8b95a8">(${order.distance_km} km)</span>`)}
    <tr><td colspan="2" style="border-top:2px solid #111827;padding-top:10px">
      <div style="font-size:20px;font-weight:800;color:${BLUE}">TOTAL Rs.${Number(order.total).toFixed(2)}</div>
    </td></tr>
  </table>`;
  return sendMail({
    to,
    subject: `NEW ORDER #${order.order_no} - Rs.${Number(order.total).toFixed(2)} - ${order.customer_name}`,
    html: shell('New Order Received', RED, inner),
  });
}

async function sendOrderConfirmation(order) {
  if (!order.customer_email) return;
  const inner = `
  <p style="font-size:15px;color:#111827">Hi ${order.customer_name}, we've received your order.</p>
  <div style="background:#eef4ff;border-left:4px solid ${BLUE};padding:12px 16px;margin:16px 0">
    <div style="font-size:18px;font-weight:800;color:${BLUE}">Order #${order.order_no}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${itemRows(order.items)}</tbody></table>
  <table style="width:100%;margin-top:14px;font-size:14px">
    ${row('Subtotal', `Rs.${Number(order.subtotal).toFixed(2)}`)}
    ${row('Delivery', `Rs.${Number(order.delivery_charge).toFixed(2)}`)}
    ${row('Total', `<span style="font-size:18px;color:${BLUE}">Rs.${Number(order.total).toFixed(2)}</span>`)}
  </table>
  <p style="color:#6b7689;font-size:13px;margin-top:18px">We'll notify you as your order progresses. Thank you!</p>`;
  return sendMail({
    to: order.customer_email,
    subject: `Order Confirmed #${order.order_no} - PB Bake House`,
    html: shell('Thank You For Your Order', BLUE, inner),
  });
}

const STATUS_TEXT = {
  accepted: 'Your order has been accepted and is queued.',
  preparing: 'Our bakers are preparing your order right now.',
  ready: 'Your order is ready!',
  out_for_delivery: 'Your order is out for delivery.',
  delivered: 'Your order has been delivered. Enjoy!',
  cancelled: 'Your order has been cancelled. Contact us for any questions.',
};

async function sendStatusUpdate(order, status) {
  if (!order.customer_email) return;
  const msg = STATUS_TEXT[status] || `Order status updated to ${status}.`;
  const inner = `
  <p style="font-size:15px">Hi ${order.customer_name},</p>
  <div style="background:#eef4ff;border-left:4px solid ${BLUE};padding:14px 16px;margin:14px 0">
    <div style="font-size:12px;letter-spacing:1px;color:#6b7689">ORDER #${order.order_no}</div>
    <div style="font-size:19px;font-weight:800;color:${BLUE};margin-top:4px">${status.replace(/_/g, ' ').toUpperCase()}</div>
  </div>
  <p style="font-size:15px;color:#111827">${msg}</p>`;
  return sendMail({
    to: order.customer_email,
    subject: `Order #${order.order_no} - ${status.replace(/_/g, ' ').toUpperCase()}`,
    html: shell('Order Update', BLUE, inner),
  });
}

async function notifyLowStock(product) {
  const to = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL;
  if (!to) return;
  const out = product.stock <= 0;
  const inner = `
  <div style="background:#fff8e6;border-left:4px solid #e0a800;padding:14px 16px">
    <div style="font-size:18px;font-weight:800;color:#8a6100">${product.name}</div>
    <div style="margin-top:6px;font-size:15px">
      ${out ? 'is now <b>OUT OF STOCK</b> and hidden from the store.' : `has only <b>${product.stock}</b> unit(s) left.`}
    </div>
  </div>
  <p style="color:#6b7689;font-size:13px;margin-top:16px">Restock it from Admin -> Products.</p>`;
  return sendMail({
    to,
    subject: out ? `OUT OF STOCK: ${product.name}` : `LOW STOCK: ${product.name} (${product.stock} left)`,
    html: shell(out ? 'Out Of Stock' : 'Low Stock Alert', '#e0a800', inner),
  });
}

module.exports = { sendMail, notifyAdminNewOrder, sendOrderConfirmation, sendStatusUpdate, notifyLowStock };
