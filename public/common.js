'use strict';
/* أدوات مشتركة بين المتجر وصفحة الطلب ولوحة التحكم */
const CATS = { all: 'الكل', cards: 'بطاقات المتاجر', topup: 'شحن الألعاب', subs: 'الاشتراكات' };
const KIND = { cards: 'GIFT CARD', topup: 'TOP-UP', subs: 'SUBSCRIPTION' };
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = v => Number(v).toLocaleString('ar-EG');
const money = h => (h / 100).toLocaleString('ar-EG', { minimumFractionDigits: h % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' ر.س';

let _uid = 0;
function cover(p) {
  const g = 'g' + (++_uid), L = String(p.label), fs = L.length > 7 ? 30 : L.length > 5 ? 38 : 48;
  const lines = [[28, 110], [50, 80], [72, 140], [94, 60]].map(([y, x]) =>
    `<line x1="0" y1="${y}" x2="${x}" y2="${y}" stroke="#fff" stroke-opacity=".55" stroke-width="2"/><circle cx="${x + 6}" cy="${y}" r="5" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2"/>`).join('');
  return `<svg viewBox="0 0 300 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${esc(p.c[0])}"/><stop offset="1" stop-color="${esc(p.c[1])}"/></linearGradient></defs><rect width="300" height="190" fill="url(#${g})"/><rect width="300" height="190" fill="#05040C" opacity=".4"/>${lines}<text x="276" y="118" text-anchor="end" direction="ltr" font-family="Saira,Tahoma,sans-serif" font-weight="700" font-size="84" fill="#fff" fill-opacity=".13">&lt;/&gt;</text><text x="24" y="142" direction="ltr" font-family="Saira,Tahoma,sans-serif" font-weight="700" font-size="${fs}" fill="#fff">${esc(L)}</text><text x="24" y="168" direction="ltr" font-family="Saira,Tahoma,sans-serif" font-size="12" letter-spacing="3" fill="#fff" fill-opacity=".8">${KIND[p.cat] || ''}</text></svg>`;
}

async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', ...opts };
  if (opts.body && typeof opts.body !== 'string') { init.body = JSON.stringify(opts.body); init.headers = { 'Content-Type': 'application/json' }; }
  else if (opts.body) init.headers = { 'Content-Type': 'application/json' };
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'حدث خطأ، حاول مرة أخرى'), { status: r.status });
  return j;
}

function toast(t) {
  const el = $('#toast'); if (!el) return;
  el.textContent = t; el.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2000);
}
