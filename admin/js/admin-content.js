'use strict';
/* ============================================================================
   ADMIN — CONTENT MODULES  (added)

   Registers four new pages on the existing admin shell:
     • Categories    — artwork upload, shown on the storefront category cards
     • Site Images   — Razorpay payment image, About-page imagery
     • Custom Cakes  — customer enquiries + status pipeline

   And extends the existing Banners page with addressable slots.

   Loaded AFTER admin.js, so it reuses api(), toast(), openModal(), esc(),
   rupee(), fmtDate(), NAV, RENDER and go() rather than redefining them.
   Nothing in admin.js is modified.
   ========================================================================== */

/* ---------- BANNER SLOTS ---------- */
const BANNER_SLOTS = [
  { id: 'hero',        label: 'Hero',           hint: 'Large arch carousel at the top of the homepage' },
  { id: 'new_arrivals',label: 'New Arrivals',   hint: 'Strip above the newest products' },
  { id: 'offers',      label: 'Offers & Deals', hint: 'Promotional strip near the coupon row' },
  { id: 'promo',       label: 'Promotional',    hint: 'Wide banner lower down the homepage' },
];
const slotLabel = id => (BANNER_SLOTS.find(s => s.id === id) || {}).label || id || 'Hero';

/* ══════════════════════════════════════════════════════════════════
   CATEGORIES
   ══════════════════════════════════════════════════════════════════ */
RENDER.categories = async function () {
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="card-h">
        <div>
          <h3>Categories</h3>
          <p style="font-size:12.5px;color:var(--ink-faint);margin-top:4px">
            Upload artwork for each category. These appear on the homepage category cards.
          </p>
        </div>
        <button class="btn btn-primary" onclick="categoryModal()">+ Add category</button>
      </div>
      <div class="card-b flush t-wrap" id="catTable"><div class="empty">Loading…</div></div>
    </div>`;
  loadCategories();
};

async function loadCategories() {
  const host = document.getElementById('catTable');
  try {
    const { categories } = await api('/categories/all');
    if (!categories.length) {
      host.innerHTML = '<div class="empty"><div class="ei">&#127874;</div>No categories yet</div>';
      return;
    }
    host.innerHTML = `<table><thead><tr>
        <th>Image</th><th>Category</th><th>Products</th><th>Order</th><th>Active</th><th></th>
      </tr></thead><tbody>
      ${categories.map(c => `<tr>
        <td>${c.image
          ? `<img src="${esc(c.image)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:12px;border:1px solid var(--line)">`
          : '<span class="thumb">&#127838;</span>'}</td>
        <td>
          <b>${esc(c.name)}</b>
          ${c.description ? `<br><span style="font-size:12px;color:var(--ink-faint)">${esc(c.description)}</span>` : ''}
          ${c.id ? '' : '<br><span style="font-size:11px;color:var(--warn)">no record yet — upload art to create one</span>'}
        </td>
        <td>${c.count}</td>
        <td>${c.sort_order ?? 0}</td>
        <td>${c.is_active ? '<span class="badge b-delivered">Live</span>' : '<span class="badge b-cancelled">Hidden</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-outline btn-sm" onclick="categoryModal('${esc(c.name).replace(/'/g, '')}')">
            ${c.image ? 'Change image' : 'Add image'}
          </button>
          ${c.id ? `<button class="btn btn-ghost btn-sm" onclick="toggleCategory('${c.id}',${c.is_active ? 0 : 1})">${c.is_active ? 'Hide' : 'Show'}</button>` : ''}
        </td>
      </tr>`).join('')}
      </tbody></table>`;
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function categoryModal(name = '') {
  openModal(name ? `Category — ${name}` : 'Add category', `
    <div class="field">
      <label>Category name</label>
      <input id="ccName" value="${esc(name)}" ${name ? 'readonly' : ''} placeholder="e.g. Celebration Cakes">
    </div>
    <div class="field">
      <label>Short description (optional)</label>
      <input id="ccDesc" placeholder="Shown under the name on collection pages">
    </div>
    <div class="field">
      <label>Sort order</label>
      <input id="ccSort" type="number" value="0">
    </div>
    <div class="field">
      <label>Category image</label>
      <input id="ccImage" type="file" accept="image/*" onchange="previewPick(this,'ccPrev')">
      <div id="ccPrev" style="margin-top:12px"></div>
      <div style="font-size:12px;color:var(--ink-faint);margin-top:8px">
        A square-ish photo works best. Leave blank to keep the current image.
      </div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" onclick="saveCategory()">Save</button>`);
}

/* Shared inline image preview used by every upload field on this page. */
function previewPick(input, targetId) {
  const t = document.getElementById(targetId);
  const f = input.files && input.files[0];
  if (!t) return;
  if (!f) { t.innerHTML = ''; return; }
  const url = URL.createObjectURL(f);
  t.innerHTML = `<img src="${url}" alt="preview"
    style="max-width:180px;max-height:180px;object-fit:cover;border-radius:12px;border:1px solid var(--line)">`;
}

async function saveCategory() {
  const name = document.getElementById('ccName').value.trim();
  if (!name) return toast('Category name is required', 'err');
  const fd = new FormData();
  fd.append('name', name);
  fd.append('description', document.getElementById('ccDesc').value.trim());
  fd.append('sort_order', document.getElementById('ccSort').value || '0');
  const file = document.getElementById('ccImage').files[0];
  if (file) fd.append('image', file);
  try {
    await api('/categories', { method: 'POST', body: fd });
    toast('Category saved', 'ok');
    closeModal();
    loadCategories();
  } catch (e) { toast(e.message, 'err'); }
}

async function toggleCategory(id, active) {
  try {
    await api('/categories/' + id, { method: 'PATCH', body: { is_active: active } });
    loadCategories();
  } catch (e) { toast(e.message, 'err'); }
}

/* ══════════════════════════════════════════════════════════════════
   SITE IMAGES  — Razorpay payment image + About-page artwork
   ══════════════════════════════════════════════════════════════════ */
const SITE_IMAGE_SLOTS = [
  { key: 'razorpay_qr_image',  label: 'Payment image',      hint: 'Shown on the checkout payment popup. Optional — leave empty to hide it.', about: false },
  { key: 'about_hero_image',   label: 'About — hero',       hint: 'Top of the About page', about: true },
  { key: 'about_story_image',  label: 'About — our story',  hint: 'Beside the story text', about: true },
  { key: 'about_kitchen_image',label: 'About — the kitchen',hint: 'Inside-the-kitchen section', about: true },
  { key: 'custom_cake_image',  label: 'Custom cakes banner',hint: 'Header of the custom cake enquiry page', about: false },
];

RENDER.siteimages = async function () {
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="card-h">
        <div>
          <h3>Site images</h3>
          <p style="font-size:12.5px;color:var(--ink-faint);margin-top:4px">
            Upload or remove imagery used across the storefront.
          </p>
        </div>
      </div>
      <div class="card-b"><div class="grid2" id="siteImgGrid"><div class="empty">Loading…</div></div></div>
    </div>

    <div class="card">
      <div class="card-h"><h3>Payment settings</h3></div>
      <div class="card-b">
        <label class="check" style="margin-bottom:16px">
          <input type="checkbox" id="rzShow"> Show the payment image on checkout
        </label>
        <div class="field">
          <label>Note under the Pay button (optional)</label>
          <input id="rzNote" placeholder="e.g. Scan with any UPI app">
        </div>
        <button class="btn btn-primary" onclick="savePaySettings()">Save payment settings</button>
      </div>
    </div>`;
  loadSiteImages();
};

async function loadSiteImages() {
  try {
    const { settings } = await api('/settings');
    document.getElementById('siteImgGrid').innerHTML = SITE_IMAGE_SLOTS.map(s => {
      const cur = settings[s.key] || '';
      return `<div style="padding:18px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)">
        <b style="display:block;margin-bottom:4px">${esc(s.label)}</b>
        <span style="font-size:12px;color:var(--ink-faint);display:block;margin-bottom:14px">${esc(s.hint)}</span>
        <div style="min-height:110px;display:grid;place-items:center;border-radius:12px;
                    background:var(--cream);border:1px dashed var(--line-strong);margin-bottom:14px">
          ${cur
            ? `<img src="${esc(cur)}" alt="" style="max-width:100%;max-height:150px;object-fit:contain;border-radius:10px">`
            : '<span style="font-size:12px;color:var(--ink-faint)">Not set</span>'}
        </div>
        <input type="file" accept="image/*" id="si_${s.key}" style="margin-bottom:10px;width:100%">
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="uploadSiteImage('${s.key}',${s.about})">Upload</button>
          ${cur ? `<button class="btn btn-red btn-sm" onclick="clearSiteImage('${s.key}')">Remove</button>` : ''}
        </div>
      </div>`;
    }).join('');

    const show = document.getElementById('rzShow');
    if (show) show.checked = settings.razorpay_show_image === '1';
    const note = document.getElementById('rzNote');
    if (note) note.value = settings.razorpay_note || '';
  } catch (e) {
    document.getElementById('siteImgGrid').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function uploadSiteImage(key, isAbout) {
  const input = document.getElementById('si_' + key);
  const file = input && input.files[0];
  if (!file) return toast('Choose an image first', 'err');
  const fd = new FormData();
  fd.append('key', key);
  fd.append('image', file);
  try {
    await api(isAbout ? '/settings/about-image' : '/settings/image', { method: 'POST', body: fd });
    toast('Image uploaded', 'ok');
    loadSiteImages();
  } catch (e) { toast(e.message, 'err'); }
}

async function clearSiteImage(key) {
  try {
    await api('/settings/' + key, { method: 'DELETE' });
    toast('Image removed', 'ok');
    loadSiteImages();
  } catch (e) { toast(e.message, 'err'); }
}

async function savePaySettings() {
  try {
    await api('/settings', { method: 'PUT', body: {
      razorpay_show_image: document.getElementById('rzShow').checked ? '1' : '0',
      razorpay_note: document.getElementById('rzNote').value.trim(),
    }});
    toast('Payment settings saved', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/* ══════════════════════════════════════════════════════════════════
   CUSTOM CAKES
   ══════════════════════════════════════════════════════════════════ */
const CC_STATUS = ['new', 'contacted', 'quoted', 'confirmed', 'completed', 'cancelled'];
const CC_BADGE = {
  new: 'b-pending', contacted: 'b-accepted', quoted: 'b-preparing',
  confirmed: 'b-ready', completed: 'b-delivered', cancelled: 'b-cancelled',
};

RENDER.customcakes = async function () {
  document.getElementById('content').innerHTML = `
    <div class="mini-stats" id="ccStats"></div>
    <div class="card">
      <div class="card-h">
        <h3>Custom cake enquiries</h3>
        <select class="status-select" id="ccFilter" onchange="loadCustomCakes()">
          <option value="">All statuses</option>
          ${CC_STATUS.map(s => `<option value="${s}">${s.replace(/^./, c => c.toUpperCase())}</option>`).join('')}
        </select>
      </div>
      <div class="card-b flush t-wrap" id="ccTable"><div class="empty">Loading…</div></div>
    </div>`;
  loadCustomCakes();
};

async function loadCustomCakes() {
  const host = document.getElementById('ccTable');
  const filter = (document.getElementById('ccFilter') || {}).value || '';
  try {
    const { requests, counts } = await api('/custom-cakes' + (filter ? '?status=' + filter : ''));

    document.getElementById('ccStats').innerHTML = `
      <div class="ms"><span>Total</span><b>${counts.total || 0}</b></div>
      <div class="ms"><span>New</span><b>${counts.new_count || 0}</b></div>
      <div class="ms"><span>Quoted</span><b>${counts.quoted || 0}</b></div>
      <div class="ms"><span>Confirmed</span><b>${counts.confirmed || 0}</b></div>
      <div class="ms"><span>Completed</span><b>${counts.completed || 0}</b></div>`;

    if (!requests.length) {
      host.innerHTML = '<div class="empty"><div class="ei">&#127874;</div>No enquiries yet</div>';
      return;
    }

    host.innerHTML = `<table><thead><tr>
        <th>Ref</th><th>Customer</th><th>Cake</th><th>Needed</th><th>Status</th><th></th>
      </tr></thead><tbody>
      ${requests.map(r => `<tr>
        <td><b>${esc(r.ref_no)}</b><br><span style="font-size:11px;color:var(--ink-faint)">${fmtDate(r.created_at)}</span></td>
        <td><b>${esc(r.customer_name)}</b><br><span style="font-size:12px;color:var(--ink-faint)">${esc(r.phone)}</span></td>
        <td>
          ${esc(r.occasion || 'Custom')}${r.flavour ? ' · ' + esc(r.flavour) : ''}${r.weight ? ' · ' + esc(r.weight) : ''}
          ${r.design_title ? `<br><span style="font-size:11px;color:var(--gold-deep)">design: ${esc(r.design_title)}</span>` : ''}
          ${r.reference_image ? '<br><span style="font-size:11px;color:var(--primary)">has reference photo</span>' : ''}
        </td>
        <td>${r.needed_on ? esc(r.needed_on) : '<span style="color:var(--ink-faint)">—</span>'}</td>
        <td><span class="badge ${CC_BADGE[r.status] || 'b-pending'}">${esc(r.status)}</span>
            ${r.quoted_price ? `<br><span style="font-size:12px">${rupee(r.quoted_price)}</span>` : ''}</td>
        <td><button class="btn btn-outline btn-sm" onclick="ccDetail('${r.id}')">Open</button></td>
      </tr>`).join('')}
      </tbody></table>`;
    window.__ccCache = requests;
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function ccDetail(id) {
  const r = (window.__ccCache || []).find(x => x.id === id);
  if (!r) return;
  openModal(`Enquiry ${r.ref_no}`, `
    ${r.design_title ? `<div class="dz-from">
      <span>Started from gallery design</span><b>${esc(r.design_title)}</b>
    </div>` : ''}
    ${r.reference_image ? `<div style="margin-bottom:18px">
      <a href="${esc(r.reference_image)}" target="_blank" rel="noopener">
        <img src="${esc(r.reference_image)}" alt="Reference"
             style="max-width:100%;max-height:280px;object-fit:contain;border-radius:14px;border:1px solid var(--line)">
      </a>
      <div style="font-size:12px;color:var(--ink-faint);margin-top:6px">Customer's reference photo — click to open full size</div>
    </div>` : ''}

    <div class="grid2" style="margin-bottom:18px">
      <div><span style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-faint)">Customer</span>
        <div><b>${esc(r.customer_name)}</b></div>
        <div><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></div>
        ${r.email ? `<div style="font-size:12.5px">${esc(r.email)}</div>` : ''}
      </div>
      <div><span style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-faint)">Cake</span>
        <div>${esc(r.occasion || '—')}</div>
        <div style="font-size:12.5px;color:var(--ink-soft)">${esc(r.flavour || '')} ${r.weight ? '· ' + esc(r.weight) : ''}</div>
        ${r.needed_on ? `<div style="font-size:12.5px">Needed: <b>${esc(r.needed_on)}</b></div>` : ''}
      </div>
    </div>

    ${r.message_on_cake ? `<div class="field"><label>Message on cake</label>
      <div style="padding:12px 14px;background:var(--cream);border-radius:12px">${esc(r.message_on_cake)}</div></div>` : ''}
    ${r.instructions ? `<div class="field"><label>Special instructions</label>
      <div style="padding:12px 14px;background:var(--cream);border-radius:12px;white-space:pre-wrap">${esc(r.instructions)}</div></div>` : ''}

    <div class="grid2">
      <div class="field"><label>Status</label>
        <select id="ccStatus" class="status-select" style="width:100%">
          ${CC_STATUS.map(s => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${s.replace(/^./, c => c.toUpperCase())}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Quoted price</label>
        <input id="ccPrice" type="number" value="${r.quoted_price || ''}" placeholder="0"></div>
    </div>
    <div class="field"><label>Internal note</label>
      <textarea id="ccNote" placeholder="Not shown to the customer">${esc(r.admin_note || '')}</textarea></div>`,
    `<button class="btn btn-red btn-sm" onclick="ccDelete('${r.id}')">Delete</button>
     <button class="btn btn-ghost" onclick="closeModal()">Close</button>
     <button class="btn btn-primary" onclick="ccSave('${r.id}')">Save</button>`);
}

async function ccSave(id) {
  try {
    await api('/custom-cakes/' + id, { method: 'PATCH', body: {
      status: document.getElementById('ccStatus').value,
      quoted_price: document.getElementById('ccPrice').value,
      admin_note: document.getElementById('ccNote').value,
    }});
    toast('Enquiry updated', 'ok');
    closeModal();
    loadCustomCakes();
  } catch (e) { toast(e.message, 'err'); }
}

async function ccDelete(id) {
  if (!confirm('Delete this enquiry permanently?')) return;
  try {
    await api('/custom-cakes/' + id, { method: 'DELETE' });
    toast('Enquiry deleted', 'ok');
    closeModal();
    loadCustomCakes();
  } catch (e) { toast(e.message, 'err'); }
}

/* ══════════════════════════════════════════════════════════════════
   BANNERS — extend the existing page with slots.
   The original RENDER.banners is kept and wrapped, not replaced.
   ══════════════════════════════════════════════════════════════════ */
RENDER.banners = async function () {
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="card-h">
        <div>
          <h3>Homepage banners</h3>
          <p style="font-size:12.5px;color:var(--ink-faint);margin-top:4px">
            Each slot renders in a different place on the homepage.
          </p>
        </div>
        <button class="btn btn-primary" onclick="bannerModal2()">+ New banner</button>
      </div>
      <div class="card-b">
        <div class="pill-row" id="slotLegend">
          ${BANNER_SLOTS.map(s => `<span class="pill" title="${esc(s.hint)}">
            <span class="d" style="background:var(--gold)"></span>${esc(s.label)}
            <b id="slotCount_${s.id}">0</b></span>`).join('')}
        </div>
      </div>
      <div class="card-b flush t-wrap" id="banTable"><div class="empty">Loading…</div></div>
    </div>`;
  loadBanners2();
};

async function loadBanners2() {
  const host = document.getElementById('banTable');
  try {
    const { banners } = await api('/banners/all');
    BANNER_SLOTS.forEach(s => {
      const el = document.getElementById('slotCount_' + s.id);
      if (el) el.textContent = banners.filter(b => (b.slot || 'hero') === s.id).length;
    });

    if (!banners.length) {
      host.innerHTML = '<div class="empty"><div class="ei">&#128444;</div>No banners yet</div>';
      return;
    }
    host.innerHTML = `<table><thead><tr>
        <th>Image</th><th>Title</th><th>Slot</th><th>Active</th><th></th>
      </tr></thead><tbody>
      ${banners.map(b => `<tr>
        <td>${b.image
          ? `<img src="${esc(b.image)}" alt="" style="width:110px;height:56px;object-fit:cover;border-radius:10px;border:1px solid var(--line)">`
          : '<span class="thumb">&#128444;</span>'}</td>
        <td><b>${esc(b.title || '(untitled)')}</b>
            <br><span style="font-size:12px;color:var(--ink-faint)">${esc(b.subtitle || '')}</span></td>
        <td>
          <select class="status-select" onchange="moveBannerSlot('${b.id}',this.value)">
            ${BANNER_SLOTS.map(s => `<option value="${s.id}" ${(b.slot || 'hero') === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
          </select>
        </td>
        <td><label class="check" style="padding:0">
          <input type="checkbox" ${b.is_active ? 'checked' : ''} onchange="toggleBanner('${b.id}',this.checked)">
        </label></td>
        <td><button class="btn btn-red btn-sm" onclick="deleteBanner2('${b.id}')">Delete</button></td>
      </tr>`).join('')}
      </tbody></table>`;
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function bannerModal2() {
  openModal('New banner', `
    <div class="field"><label>Slot</label>
      <select id="bSlot" class="status-select" style="width:100%">
        ${BANNER_SLOTS.map(s => `<option value="${s.id}">${s.label} — ${s.hint}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Title</label><input id="bTitle" placeholder="Festive collection"></div>
    <div class="field"><label>Subtitle</label><input id="bSub" placeholder="Hand-finished centrepieces"></div>
    <div class="field"><label>Button label (optional)</label><input id="bCta" placeholder="Shop now"></div>
    <div class="field"><label>Link (optional)</label><input id="bLink" placeholder="/menu.html?category=Cakes"></div>
    <div class="field"><label>Image</label>
      <input id="bImage" type="file" accept="image/*" onchange="previewPick(this,'bPrev')">
      <div id="bPrev" style="margin-top:12px"></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" onclick="saveBanner2()">Create</button>`);
}

async function saveBanner2() {
  const fd = new FormData();
  fd.append('slot', document.getElementById('bSlot').value);
  fd.append('title', document.getElementById('bTitle').value.trim());
  fd.append('subtitle', document.getElementById('bSub').value.trim());
  fd.append('cta_label', document.getElementById('bCta').value.trim());
  fd.append('link', document.getElementById('bLink').value.trim());
  const file = document.getElementById('bImage').files[0];
  if (file) fd.append('image', file);
  try {
    await api('/banners', { method: 'POST', body: fd });
    toast('Banner added', 'ok');
    closeModal();
    loadBanners2();
  } catch (e) { toast(e.message, 'err'); }
}

async function moveBannerSlot(id, slot) {
  try {
    await api('/banners/' + id, { method: 'PATCH', body: { slot } });
    toast('Moved to ' + slotLabel(slot), 'ok');
    loadBanners2();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteBanner2(id) {
  if (!confirm('Delete this banner?')) return;
  try {
    await api('/banners/' + id, { method: 'DELETE' });
    toast('Banner deleted', 'ok');
    loadBanners2();
  } catch (e) { toast(e.message, 'err'); }
}


/* ══════════════════════════════════════════════════════════════════
   OCCASIONS — tag products so the homepage collections fill up
   ══════════════════════════════════════════════════════════════════ */
let OCC_OPTIONS = [];

RENDER.occasions = async function () {
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="card-h">
        <div>
          <h3>Occasion tags</h3>
          <p style="font-size:12.5px;color:var(--ink-faint);margin-top:4px">
            Tag a product and it appears in that collection on the homepage.
            Collections with nothing tagged stay hidden.
          </p>
        </div>
      </div>
      <div class="card-b flush t-wrap" id="occTable"><div class="empty">Loading…</div></div>
    </div>`;
  loadOccasions();
};

async function loadOccasions() {
  const host = document.getElementById('occTable');
  try {
    const { options, products } = await api('/occasions');
    OCC_OPTIONS = options;
    if (!products.length) {
      host.innerHTML = '<div class="empty"><div class="ei">&#127874;</div>No products yet</div>';
      return;
    }
    host.innerHTML = `<table><thead><tr>
        <th>Product</th><th>Category</th><th>Occasions</th>
      </tr></thead><tbody>
      ${products.map(p => {
        const tags = String(p.occasions || '').split(',').filter(Boolean);
        return `<tr>
          <td style="display:flex;align-items:center;gap:12px">
            ${p.image ? `<img src="${esc(p.image)}" alt="" class="thumb">` : '<span class="thumb">&#127874;</span>'}
            <b>${esc(p.name)}</b>
          </td>
          <td>${esc(p.category || '')}</td>
          <td><div style="display:flex;flex-wrap:wrap;gap:7px">
            ${options.map(o => `<label class="check" style="padding:6px 12px;font-size:12px">
              <input type="checkbox" data-pid="${p.id}" value="${esc(o)}"
                     ${tags.includes(o) ? 'checked' : ''} onchange="saveOccasions('${p.id}')">
              ${esc(o)}
            </label>`).join('')}
          </div></td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function saveOccasions(pid) {
  const picked = [...document.querySelectorAll(`input[data-pid="${pid}"]:checked`)].map(i => i.value);
  try {
    await api('/occasions/' + pid, { method: 'PATCH', body: { occasions: picked } });
    toast(picked.length ? 'Tagged: ' + picked.join(', ') : 'Tags cleared', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}


/* ══════════════════════════════════════════════════════════════════
   CUSTOM CAKE GALLERY — sample designs customers browse first
   ══════════════════════════════════════════════════════════════════ */
let DESIGNS = [];

RENDER.designs = async function () {
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="card-h">
        <div>
          <h3>Custom cake gallery</h3>
          <p style="font-size:12.5px;color:var(--ink-faint);margin-top:4px">
            These are the sample designs customers browse before sending an enquiry.
            Drag the arrows to change the order they appear in.
          </p>
        </div>
        <button class="btn btn-primary" onclick="designModal()">+ Add design</button>
      </div>
      <div class="card-b" id="designGrid"><div class="empty">Loading…</div></div>
    </div>`;
  loadDesigns();
};

async function loadDesigns() {
  const host = document.getElementById('designGrid');
  try {
    const { designs } = await api('/custom-cake-designs/all');
    DESIGNS = designs;
    if (!designs.length) {
      host.innerHTML = `<div class="empty"><div class="ei">&#127874;</div>
        <p>No designs yet.<br>Add a few so customers have something to browse.</p></div>`;
      return;
    }
    host.innerHTML = `<div class="dz-grid">${designs.map((d, i) => `
      <div class="dz-card${d.is_active ? '' : ' dz-off'}">
        <div class="dz-img">
          ${d.image ? `<img src="${esc(d.image)}" alt="${esc(d.title)}">`
                    : '<span style="font-size:34px;opacity:.4">&#127874;</span>'}
          <div class="dz-order">
            <button title="Move up" onclick="moveDesign(${i},-1)" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
            <span>${i + 1}</span>
            <button title="Move down" onclick="moveDesign(${i},1)" ${i === designs.length - 1 ? 'disabled' : ''}>&darr;</button>
          </div>
          ${d.is_active ? '' : '<div class="dz-hidden">Hidden</div>'}
        </div>
        <div class="dz-body">
          <b>${esc(d.title)}</b>
          ${d.occasion ? `<span class="dz-tag">${esc(d.occasion)}</span>` : ''}
          ${d.base_price ? `<span class="dz-price">from ${rupee(d.base_price)}</span>` : ''}
          ${d.description ? `<p>${esc(d.description)}</p>` : ''}
        </div>
        <div class="dz-actions">
          <button class="btn btn-outline btn-sm" onclick="designModal('${d.id}')">Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="toggleDesign('${d.id}',${d.is_active ? 0 : 1})">
            ${d.is_active ? 'Hide' : 'Show'}
          </button>
          <button class="btn btn-red btn-sm" onclick="deleteDesign('${d.id}')">Delete</button>
        </div>
      </div>`).join('')}</div>`;
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function designModal(id = '') {
  const d = DESIGNS.find(x => x.id === id) || {};
  openModal(id ? 'Edit design' : 'Add design', `
    <div class="field"><label>Title</label>
      <input id="dTitle" value="${esc(d.title || '')}" placeholder="e.g. Two-tier floral"></div>
    <div class="field"><label>Description</label>
      <textarea id="dDesc" rows="3" placeholder="What makes this one special">${esc(d.description || '')}</textarea></div>
    <div class="grid2">
      <div class="field"><label>Occasion</label>
        <input id="dOcc" value="${esc(d.occasion || '')}" placeholder="Birthday"></div>
      <div class="field"><label>Starting price</label>
        <input id="dPrice" type="number" value="${d.base_price || ''}" placeholder="1200"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Flavours offered</label>
        <input id="dFlav" value="${esc(d.flavours || '')}" placeholder="Chocolate, Red velvet, Vanilla"></div>
      <div class="field"><label>Weights offered</label>
        <input id="dWeight" value="${esc(d.weights || '')}" placeholder="1 kg, 2 kg, 3 kg"></div>
    </div>
    <div class="field"><label>Design photo</label>
      <input id="dImage" type="file" accept="image/*" onchange="previewPick(this,'dPrev')">
      <div id="dPrev" style="margin-top:12px">
        ${d.image ? `<img src="${esc(d.image)}" style="max-width:180px;max-height:180px;object-fit:cover;border-radius:12px;border:1px solid var(--line)">` : ''}
      </div>
      ${id ? '<div style="font-size:12px;color:var(--ink-faint);margin-top:8px">Leave blank to keep the current photo.</div>' : ''}
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" onclick="saveDesign('${id}')">${id ? 'Save changes' : 'Add design'}</button>`);
}

async function saveDesign(id) {
  const title = document.getElementById('dTitle').value.trim();
  if (!title) return toast('A title is required', 'err');
  const fd = new FormData();
  fd.append('title', title);
  fd.append('description', document.getElementById('dDesc').value.trim());
  fd.append('occasion', document.getElementById('dOcc').value.trim());
  fd.append('base_price', document.getElementById('dPrice').value);
  fd.append('flavours', document.getElementById('dFlav').value.trim());
  fd.append('weights', document.getElementById('dWeight').value.trim());
  const file = document.getElementById('dImage').files[0];
  if (file) fd.append('image', file);
  try {
    await api(id ? '/custom-cake-designs/' + id : '/custom-cake-designs',
              { method: id ? 'PATCH' : 'POST', body: fd });
    toast(id ? 'Design updated' : 'Design added', 'ok');
    closeModal();
    loadDesigns();
  } catch (e) { toast(e.message, 'err'); }
}

async function moveDesign(index, dir) {
  const target = index + dir;
  if (target < 0 || target >= DESIGNS.length) return;
  const ids = DESIGNS.map(d => d.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  try {
    await api('/custom-cake-designs/order', { method: 'PUT', body: { order: ids } });
    loadDesigns();
  } catch (e) { toast(e.message, 'err'); }
}

async function toggleDesign(id, active) {
  try {
    await api('/custom-cake-designs/' + id, { method: 'PATCH', body: { is_active: active } });
    loadDesigns();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteDesign(id) {
  if (!confirm('Delete this design permanently?')) return;
  try {
    await api('/custom-cake-designs/' + id, { method: 'DELETE' });
    toast('Design deleted', 'ok');
    loadDesigns();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- REGISTER NAV ITEMS ----------
   Inserted next to the existing catalog entries without disturbing them. */
(function registerNav() {
  const addAfter = (afterId, item) => {
    const i = NAV.findIndex(n => n.id === afterId);
    if (i === -1) NAV.push(item); else NAV.splice(i + 1, 0, item);
  };
  if (!NAV.some(n => n.id === 'categories'))
    addAfter('products', { id: 'categories', icon: '\u{1F3F7}', label: 'Categories' });
  if (!NAV.some(n => n.id === 'occasions'))
    addAfter('categories', { id: 'occasions', icon: '\u{1F388}', label: 'Occasions' });
  if (!NAV.some(n => n.id === 'customcakes'))
    addAfter('banners', { id: 'customcakes', icon: '\u{1F382}', label: 'Custom Cakes' });
  if (!NAV.some(n => n.id === 'designs'))
    addAfter('customcakes', { id: 'designs', icon: '\u{1F3A8}', label: 'Cake Gallery' });
  if (!NAV.some(n => n.id === 'siteimages'))
    addAfter('designs', { id: 'siteimages', icon: '\u{1F5BC}', label: 'Site Images' });

  /* bootApp() awaits /auth/me before it calls buildNav(), so this file
     normally registers in time. If the sidebar was already painted (cached
     auth, slow parse, whatever), rebuild it so the new pages never go missing. */
  if (typeof buildNav === 'function' && document.querySelector('#navMenu .nav-item')) {
    try { buildNav(); } catch (e) { /* nav will build on next boot */ }
  }
})();
