// The shop's small browser script. The pages work with plain forms; this adds the calls a real storefront makes from the page (wallet, order detail, quick refund,
// password reset, image import, cart preview). Every call is an ordinary request that shows up in the browser's Network panel. Everything the server sends is put on
// the page as text, never as markup.
(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const $ = (sel, root = document) => root.querySelector(sel);
  const say = (el, text, kind) => { if (!el) return; el.textContent = text; el.className = `note ${kind || ''}`.trim(); el.hidden = !text; };
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

  // form-encoded like the shop's own forms, with the CSRF token; the answer is JSON
  async function call(method, url, fields) {
    const init = { method, headers: { accept: 'application/json' } };
    if (method !== 'GET') { init.headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams({ ...(fields || {}), csrf }).toString(); }
    const res = await fetch(url, init);
    let data = null; try { data = await res.json(); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, data };
  }
  const problem = (r) => (r.data?.error || r.data?.message || `The shop answered ${r.status}.`);

  // ---- C02: the gift-card wallet ----
  const wallet = $('[data-widget="wallet"]');
  if (wallet) {
    const list = $('#receipts', wallet); const out = $('#wallet-msg', wallet); const credit = $('#credit', wallet);
    const KEY = 'vm-receipts';
    const saved = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { return []; } };
    const draw = () => {
      list.replaceChildren();
      for (const c of saved()) {
        const li = el('li'); li.append(el('b', `Card ${c.serial}`), ` ${money(c.amount_cents)}, code `, el('code', c.code));
        list.append(li);
      }
      $('#no-receipts', wallet).hidden = saved().length > 0;
    };
    draw();
    $('#buy-form', wallet).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = await call('POST', '/api/wallet/buy', { amount_cents: new FormData(ev.target).get('amount_cents') });
      if (!r.ok) return say(out, problem(r), 'bad');
      sessionStorage.setItem(KEY, JSON.stringify([...saved(), r.data]));
      say(out, `Card ${r.data.serial} bought. Keep the code: it is shown once on the receipt below.`, 'ok'); draw();
    });
    $('#redeem-form', wallet).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = await call('POST', '/api/wallet/redeem', { code: new FormData(ev.target).get('code') });
      if (!r.ok) return say(out, problem(r), 'bad');
      const added = Number(r.data.amount_cents || 0);
      credit.textContent = money(Number(credit.dataset.cents || 0) + added); credit.dataset.cents = String(Number(credit.dataset.cents || 0) + added);
      say(out, `Redeemed card ${r.data.serial}: ${money(added)} added.${r.data.message ? ` Card message: ${r.data.message}` : ''}`, 'ok');
    });
  }

  // ---- C01: the order detail of a seller ----
  const detail = $('[data-widget="seller-order"]');
  if (detail) {
    const out = $('#order-msg', detail); const body = $('#order-body', detail);
    call('GET', `/api/seller/orders/${encodeURIComponent(detail.dataset.orderNo)}`).then((r) => {
      if (!r.ok) return say(out, r.status === 404 ? 'This order was not found in your store.' : problem(r), 'bad');
      $('#order-status', detail).textContent = r.data.status;
      const tbody = $('#order-items', detail); tbody.replaceChildren();
      for (const it of r.data.items || []) { const tr = el('tr'); for (const v of [it.title, String(it.qty), money(it.unit_price_cents), it.status]) tr.append(el('td', v)); tbody.append(tr); }
      $('#order-note', detail).textContent = r.data.buyer_note || 'No note from the buyer.';
      body.hidden = false;
    });
  }

  // ---- C04: quick refund and the refund statement of an order ----
  const refund = $('[data-widget="refund"]');
  if (refund) {
    const id = refund.dataset.orderId; const out = $('#refund-msg', refund); const stmt = $('#statement', refund);
    const show = async () => {
      const r = await call('GET', `/api/orders/${encodeURIComponent(id)}/refund-statement`);
      if (!r.ok) { stmt.textContent = r.status === 404 ? '' : problem(r); return; }
      stmt.replaceChildren(); const dl = el('dl', undefined, 'kv-list');
      dl.append(el('dt', 'Paid'), el('dd', money(r.data.paid_cents)), el('dt', 'Refunded so far'), el('dd', money(r.data.refunded_cents)));
      for (const q of r.data.quick_refunds || []) dl.append(el('dt', 'Quick refund'), el('dd', `${money(q.amount_cents)} (${q.path}, ${q.created_at})`));
      for (const g of r.data.goodwill || []) dl.append(el('dt', 'Goodwill adjustment'), el('dd', `${g.reference}: ${money(g.amount_cents)}`));
      stmt.append(dl);
    };
    show();
    $('#quick-refund', refund).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = await call('POST', `/api/orders/${encodeURIComponent(id)}/refunds`, { amount: new FormData(ev.target).get('amount') });
      say(out, r.ok ? `Refunded ${money(r.data.refunded_cents)}.` : problem(r), r.ok ? 'ok' : 'bad'); show();
    });
  }

  // ---- C07: forgotten password ----
  const reset = $('[data-widget="reset"]');
  if (reset) {
    const out = $('#reset-msg', reset); const step2 = $('#reset-confirm', reset);
    $('#reset-request', reset).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = new FormData(ev.target).get('email');
      const r = await call('POST', '/auth/forgot', { email });
      if (!r.ok) return say(out, problem(r), 'bad');
      $('#confirm-email', reset).value = String(email); step2.hidden = false;
      say(out, 'If that address has an account, we sent it a code. Enter the code and a new password below.', 'ok');
    });
    step2.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const r = await call('POST', '/auth/reset/confirm', { email: f.get('email'), code: f.get('code'), password: f.get('password') });
      say(out, r.ok ? 'Your password was changed. You can log in now.' : problem(r), r.ok ? 'ok' : 'bad');
    });
  }

  // ---- C10: import a product image from a URL ----
  const imp = $('[data-widget="import-image"]');
  if (imp) {
    const out = $('#import-msg', imp); const view = $('#import-result', imp);
    $('#import-form', imp).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = await call('POST', '/seller/import-image', { url: new FormData(ev.target).get('url') });
      view.textContent = JSON.stringify(r.data, null, 2); view.hidden = false;
      say(out, r.ok ? 'The importer fetched the image.' : problem(r), r.ok ? 'ok' : 'bad');
    });
  }

  // ---- C05: the cart preview. The page tells the cart service what is being added before the form goes through. ----
  const add = $('[data-widget="add-to-cart"]');
  if (add) {
    add.addEventListener('submit', async (ev) => {
      if (add.dataset.sent) return;
      ev.preventDefault();
      const f = new FormData(add);
      try {
        await fetch('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ product_id: Number(f.get('product_id')), qty: Number(f.get('qty') || 1) }] }) });
      } catch { /* the preview is best effort */ }
      add.dataset.sent = '1'; add.requestSubmit();
    });
  }
})();
