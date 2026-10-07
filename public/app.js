'use strict';
const CART_KEY = 'codeweb-cart-v2';
const state = { cat: 'all', q: '', sort: 'new', products: [], mode: 'demo', cart: [], email: '', tsKey: null, ts: '', tsId: null };
const idx = new Map(); // رقم الفئة -> { p, o }
try {
  const s = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  if (Array.isArray(s)) state.cart = s.filter(i => i && Number.isInteger(i.opt) && i.q >= 1 && i.q <= 5);
} catch { /* تجاهل */ }
const save = () => { try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* تجاهل */ } };
const minPrice = p => Math.min(...p.opts.map(o => o.price));
const inStock = p => p.opts.some(o => o.max > 0);
const cap = o => Math.min(5, o.max);
const qtyAll = () => state.cart.reduce((s, i) => s + i.q, 0);

/* ---------- تحميل المنتجات ---------- */
async function load() {
  try {
    const r = await api('/api/products');
    state.products = r.products; state.mode = r.mode; state.tsKey = r.turnstile || null;
    if (state.tsKey) loadTurnstile();
    idx.clear();
    for (const p of state.products) for (const o of p.opts) idx.set(o.id, { p, o });
    // تنظيف السلة من فئات اختفت أو نفدت
    state.cart = state.cart.filter(i => idx.has(i.opt) && cap(idx.get(i.opt).o) > 0).map(i => ({ opt: i.opt, q: Math.min(i.q, cap(idx.get(i.opt).o)) }));
    save();
    renderGrid(); refresh();
  } catch (e) {
    $('#grid').innerHTML = '<div class="empty"><p>تعذّر تحميل المنتجات.</p><button id="retry">إعادة المحاولة</button></div>';
    $('#retry').onclick = load;
  }
}

/* ---------- التصفية ---------- */
$('#tabs').innerHTML = Object.entries(CATS).map(([k, v]) => `<button data-cat="${k}" aria-pressed="${k === 'all'}">${v}</button>`).join('');
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-cat]'); if (!b) return;
  state.cat = b.dataset.cat;
  document.querySelectorAll('#tabs button').forEach(x => x.setAttribute('aria-pressed', x === b));
  renderGrid();
});
$('#sort').addEventListener('change', e => { state.sort = e.target.value; renderGrid(); });
$('#q').addEventListener('input', e => { state.q = e.target.value.trim(); renderGrid(); });

function list() {
  const q = state.q.toLowerCase();
  const l = state.products.filter(p => (state.cat === 'all' || p.cat === state.cat) && (!q || (p.title + ' ' + p.label + ' ' + CATS[p.cat]).toLowerCase().includes(q)));
  if (state.sort === 'low') l.sort((a, b) => minPrice(a) - minPrice(b));
  else if (state.sort === 'high') l.sort((a, b) => minPrice(b) - minPrice(a));
  else l.sort((a, b) => b.id - a.id);
  return l;
}
function card(p) {
  const ok = inStock(p);
  return `<article class="item"><button class="cover" data-open="${p.id}" aria-label="اختيار فئة ${esc(p.title)}">${cover(p)}<span class="chip${ok ? '' : ' out'}">${ok ? 'تسليم فوري' : 'نفدت الكمية'}</span></button>
  <div class="meta"><h3>${esc(p.title)}</h3><p class="cat">${esc(CATS[p.cat] || '')}</p>
  <div class="buy"><span class="price"><small>ابتداءً من</small>${money(minPrice(p))}</span><button class="add" data-open="${p.id}">اختر الفئة</button></div></div></article>`;
}
function renderGrid() {
  const l = list();
  $('#result').textContent = n(l.length) + (l.length === 1 ? ' منتج' : ' منتجات');
  if (!l.length) {
    $('#grid').innerHTML = '<div class="empty"><p id="emptyMsg"></p><button id="resetF">عرض كل المنتجات</button></div>';
    $('#emptyMsg').textContent = state.q ? `لا توجد نتائج لـ «${state.q}». جرّب كلمة أخرى أو غيّر النوع.` : 'لا توجد منتجات في هذا النوع بعد.';
    $('#resetF').onclick = () => { state.q = ''; state.cat = 'all'; $('#q').value = ''; document.querySelectorAll('#tabs button').forEach(x => x.setAttribute('aria-pressed', x.dataset.cat === 'all')); renderGrid(); };
    return;
  }
  $('#grid').innerHTML = l.map(card).join('');
}
$('#grid').addEventListener('click', e => { const o = e.target.closest('[data-open]'); if (o) openDlg(+o.dataset.open); });

/* ---------- السلة ---------- */
function addItem(opt) {
  const { o } = idx.get(opt) || {}; if (!o) return false;
  const it = state.cart.find(i => i.opt === opt), max = cap(o);
  if (!max) { toast('نفدت الكمية'); return false; }
  if (it && it.q >= max) { toast('وصلت إلى الحد المتاح من هذه الفئة'); return false; }
  if (it) it.q++; else state.cart.push({ opt, q: 1 });
  save(); refresh(); toast('أُضيف إلى السلة'); return true;
}
function changeQty(opt, d) {
  const it = state.cart.find(i => i.opt === opt); if (!it) return;
  const max = cap(idx.get(opt).o);
  it.q = Math.min(max, it.q + d);
  if (it.q < 1) state.cart = state.cart.filter(i => i !== it);
  save(); refresh();
}
function removeItem(opt) { state.cart = state.cart.filter(i => i.opt !== opt); save(); refresh(); }
function refresh() { $('#count').textContent = n(qtyAll()); renderCart(); }

function renderCart() {
  const body = $('#cartBody'), foot = $('#cartFoot');
  foot.hidden = !state.cart.length;
  if (!state.cart.length) {
    body.innerHTML = '<div class="msg"><h3>السلة فارغة</h3><p>اختر بطاقة أو شحنة أو اشتراكًا وأضفه هنا.</p><button class="btn" id="backShop">تصفّح المنتجات</button></div>';
    $('#backShop').onclick = () => { closeCart(); location.hash = '#shop'; };
    return;
  }
  body.innerHTML = state.cart.map(i => {
    const { p, o } = idx.get(i.opt);
    return `<div class="row"><div class="th">${cover(p)}</div><div class="t"><b>${esc(p.title)}</b><small>${esc(o.label)}، ${money(o.price)}</small>
    <div class="qty"><button data-q="-1" data-opt="${i.opt}" aria-label="إنقاص الكمية">−</button><span>${n(i.q)}</span><button data-q="1" data-opt="${i.opt}" aria-label="زيادة الكمية" ${i.q >= cap(o) ? 'disabled' : ''}>+</button></div></div>
    <button class="rm" data-rm="${i.opt}" aria-label="إزالة ${esc(p.title)}">إزالة</button></div>`;
  }).join('');
  const total = state.cart.reduce((s, i) => s + idx.get(i.opt).o.price * i.q, 0);
  const demo = state.mode === 'demo';
  if (state.tsId != null && window.turnstile) { try { turnstile.remove(state.tsId); } catch { /* تجاهل */ } }
  state.tsId = null; state.ts = '';
  foot.innerHTML = `<div class="tot"><span>المجموع</span><span>${money(total)}</span></div>
  <label for="email">بريدك لاستلام الأكواد</label><input id="email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" value="${esc(state.email)}">
  ${state.tsKey ? '<div id="ts" style="margin:8px 0;min-height:65px"></div>' : ''}<div class="err" id="err" role="alert"></div><button class="btn" id="pay">إتمام الشراء</button>
  <p class="note">${demo ? 'وضع تجريبي: لا يوجد دفع حقيقي.' : 'ستنتقل إلى صفحة الدفع الآمنة لإتمام الطلب.'}</p>`;
  $('#email').addEventListener('input', e => { state.email = e.target.value; });
  $('#pay').onclick = pay;
  mountTs();
}
$('#cartBody').addEventListener('click', e => {
  const q = e.target.closest('[data-q]'); if (q) return changeQty(+q.dataset.opt, +q.dataset.q);
  const r = e.target.closest('[data-rm]'); if (r) removeItem(+r.dataset.rm);
});

async function pay() {
  const err = $('#err'), btn = $('#pay'), em = state.email.trim();
  err.textContent = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) { err.textContent = 'اكتب بريدًا صحيحًا، مثل name@example.com'; $('#email').focus(); return; }
  if (state.tsKey && !state.ts) { err.textContent = 'أكمل التحقق الأمني أعلاه ثم أعد الضغط'; return; }
  btn.disabled = true; btn.textContent = 'جارٍ تجهيز طلبك…';
  try {
    const r = await api('/api/checkout', { method: 'POST', body: { email: em, turnstile: state.ts, items: state.cart.map(i => ({ opt: i.opt, qty: i.q })) } });
    location.href = r.url;
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false; btn.textContent = 'إتمام الشراء';
    if (state.tsKey && window.turnstile && state.tsId != null) { try { turnstile.reset(state.tsId); } catch { /* تجاهل */ } state.ts = ''; }
    if (e.status === 409 || e.status === 400) load();   // حدّث المخزون
  }
}

/* ---------- التحقق الأمني (Cloudflare Turnstile، اختياري) ---------- */
function loadTurnstile() {
  if (window.turnstile || document.getElementById('ts-script')) return;
  const sc = document.createElement('script');
  sc.id = 'ts-script'; sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true; sc.defer = true;
  sc.onload = mountTs;
  document.head.appendChild(sc);
}
function mountTs() {
  const el = $('#ts');
  if (!el || !window.turnstile || !state.tsKey || state.tsId != null) return;
  try {
    state.tsId = turnstile.render(el, {
      sitekey: state.tsKey, theme: 'dark', language: 'ar',
      callback: t => { state.ts = t; },
      'expired-callback': () => { state.ts = ''; },
      'error-callback': () => { state.ts = ''; },
    });
  } catch { /* تجاهل */ }
}

/* ---------- نافذة المنتج ---------- */
const dlg = $('#dlg');
function openDlg(id) {
  const p = state.products.find(x => x.id === id); if (!p) return;
  const firstOk = p.opts.find(o => o.max > 0);
  dlg.innerHTML = `<div class="dg"><div class="pic"><div class="in">${cover(p)}</div></div><div class="tx"><button class="x" id="dx" aria-label="إغلاق">✕</button><h3>${esc(p.title)}</h3><p>${esc(p.desc)}</p>
  <fieldset><legend>اختر الفئة</legend><div class="opts">${p.opts.map(o => `<label class="opt"><input type="radio" name="opt" value="${o.id}" ${o === firstOk ? 'checked' : ''} ${o.max > 0 ? '' : 'disabled'}><span>${esc(o.label)}<small>${o.max > 0 ? money(o.price) : 'نفدت الكمية'}</small></span></label>`).join('')}</div></fieldset>
  <dl>${p.region ? `<dt>المنطقة</dt><dd>${esc(p.region)}</dd>` : ''}<dt>التسليم</dt><dd>يصل الكود إلى بريدك وتجده في صفحة طلبك بعد تأكيد الدفع.</dd></dl>
  <div class="buy"><span class="tp" id="tp">${firstOk ? money(firstOk.price) : '—'}</span><button class="btn" id="dadd" ${firstOk ? '' : 'disabled'}>${firstOk ? 'أضف إلى السلة' : 'نفدت الكمية'}</button></div></div></div>`;
  dlg.showModal();
  const sel = () => { const c = dlg.querySelector('input[name=opt]:checked'); return c ? +c.value : null; };
  dlg.querySelectorAll('input[name=opt]').forEach(r => r.addEventListener('change', () => { $('#tp').textContent = money(idx.get(sel()).o.price); }));
  $('#dx').onclick = () => dlg.close();
  $('#dadd').onclick = () => { const s = sel(); if (s != null && addItem(s)) dlg.close(); };
}
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

/* ---------- درج السلة ---------- */
let lastFocus = null;
function openCart() { lastFocus = document.activeElement; if (dlg.open) dlg.close(); $('#drawer').classList.add('open'); $('#scrim').classList.add('on'); $('#closeCart').focus(); }
function closeCart() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('on'); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
$('#openCart').onclick = openCart; $('#closeCart').onclick = closeCart; $('#scrim').onclick = closeCart;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#drawer').classList.contains('open')) closeCart(); });

$('#count').textContent = n(qtyAll());
load();
