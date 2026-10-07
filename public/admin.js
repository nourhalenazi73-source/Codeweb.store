'use strict';
const app = $('#app'), pdlg = $('#pdlg'), cdlg = $('#cdlg');
const ST = { paid: 'مدفوع', pending: 'بانتظار الدفع', expired: 'منتهي', failed: 'فشل', needs_refund: 'يلزم استرجاع' };
const CATN = { cards: 'بطاقات المتاجر', topup: 'شحن الألعاب', subs: 'الاشتراكات' };
const when = t => t ? new Date(t).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }) : '—';
let tab = 'summary', meta = {}, products = [];

async function boot() {
  try { meta = await api('/api/admin/me'); shell(); }
  catch { loginView(); }
}

async function loginView() {
  let totp = false;
  try { totp = (await api('/api/admin/login-info')).totp; } catch { /* تجاهل */ }
  app.innerHTML = `<form class="login" id="lf"><h1>لوحة تحكم Codeweb</h1>
  <div class="fld"><label for="pw">كلمة المرور</label><input id="pw" type="password" autocomplete="current-password" required></div>
  ${totp ? '<div class="fld"><label for="code">رمز التحقق (٦ أرقام من تطبيق المصادقة)</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" dir="ltr" required></div>' : ''}
  <div class="err" id="err" role="alert"></div><button class="btn" style="width:100%">دخول</button></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value, code: totp ? $('#code').value : undefined } }); boot(); }
    catch (er) { $('#err').textContent = er.message; }
  };
}

function shell() {
  const warn = [];
  if (meta.mode === 'demo') warn.push('الدفع تجريبي');
  if (meta.mail === 'console') warn.push('البريد تجريبي');
  app.innerHTML = `<div class="adm"><div class="head"><h1>لوحة التحكم</h1><div>
    ${warn.map(w => `<span class="stat pending">${w}</span> `).join('')}<button class="sm" id="out">خروج</button></div></div>
  <div class="atabs" role="group" aria-label="الأقسام">${[['summary', 'الملخص'], ['products', 'المنتجات والأكواد'], ['orders', 'الطلبات'], ['security', 'الأمان'], ['audit', 'سجل النشاط']].map(([k, v]) => `<button data-tab="${k}" aria-pressed="${k === tab}">${v}</button>`).join('')}</div>
  ${meta.totp ? '' : '<div class="box demo" style="margin-bottom:16px"><b>حسابك غير محمي بخطوتين.</b> إن سُرقت كلمة المرور فسيُسرق مخزونك. <button class="sm" id="go2fa">فعّل التحقق بخطوتين الآن</button></div>'}
  <div id="view"></div></div>`;
  $('#out').onclick = async () => { await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); loginView(); };
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; shell(); });
  const g2 = $('#go2fa'); if (g2) g2.onclick = () => { tab = 'security'; shell(); };
  ({ summary: viewSummary, products: viewProducts, orders: viewOrders, security: viewSecurity, audit: viewAudit })[tab]();
}

async function guard(fn) {
  try { return await fn(); }
  catch (e) { if (e.status === 401) loginView(); else toast(e.message); }
}

/* ---------- الملخص ---------- */
function viewSummary() {
  guard(async () => {
    const s = await api('/api/admin/summary');
    $('#view').innerHTML = `<div class="cards">
      <div class="card"><small>مبيعات آخر ٢٤ ساعة</small><b>${money(s.dayRevenue)}</b></div>
      <div class="card"><small>طلبات مدفوعة (٢٤ ساعة)</small><b>${n(s.dayCount)}</b></div>
      <div class="card"><small>إجمالي المبيعات</small><b>${money(s.revenue)}</b></div>
      <div class="card"><small>إجمالي الطلبات المدفوعة</small><b>${n(s.paidCount)}</b></div>
      <div class="card"><small>بانتظار الدفع</small><b>${n(s.pending)}</b></div>
      ${s.needsRefund ? `<div class="card" style="border-color:var(--err)"><small>يلزم استرجاع مبلغها</small><b style="color:var(--err)">${n(s.needsRefund)}</b></div>` : ''}</div>
      <h3 style="margin-bottom:8px">مخزون قليل</h3>
      ${s.low.length ? `<div class="pcard">${s.low.map(l => `<div class="orow"><span>${esc(l.title)} (${esc(l.label)})</span><b style="color:${l.avail ? 'var(--warn)' : 'var(--err)'}">${l.avail ? 'متبقٍ ' + n(l.avail) : 'نفد'}</b></div>`).join('')}</div>` : '<p class="note">لا توجد فئات قاربت على النفاد.</p>'}`;
  });
}

/* ---------- المنتجات ---------- */
function viewProducts() {
  guard(async () => {
    products = (await api('/api/admin/products')).products;
    $('#view').innerHTML = `<div class="head"><h3>المنتجات</h3><button class="btn" id="np" style="min-height:44px">منتج جديد</button></div><div class="plist">` +
      products.map(p => `<div class="pcard${p.active ? '' : ' off'}"><div class="phead"><h3>${esc(p.title)} <span class="stat">${esc(CATN[p.cat] || p.cat)}</span>${p.active ? '' : ' <span class="stat expired">مخفي</span>'}</h3><button class="sm" data-edit="${p.id}">تعديل</button></div>
      ${p.opts.map(o => `<div class="orow"><span>${esc(o.label)} · ${money(o.price)}${o.active ? '' : ' <span class="stat expired">متوقفة</span>'}</span>
        <span class="st">متاح ${n(o.avail)} · محجوز ${n(o.reserved)} · مباع ${n(o.sold)}</span><button class="sm" data-codes="${o.id}">إضافة أكواد</button></div>`).join('')}</div>`).join('') + '</div>';
    $('#np').onclick = () => editProduct(null);
    $('#view').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editProduct(products.find(p => p.id === +b.dataset.edit)));
    $('#view').querySelectorAll('[data-codes]').forEach(b => b.onclick = () => codesDialog(+b.dataset.codes));
  });
}

function optRow(o) {
  return `<div class="optedit" data-id="${o.id || ''}"><input class="ol" placeholder="اسم الفئة (مثال: ١٠ دولار)" value="${esc(o.label || '')}" aria-label="اسم الفئة">
  <input class="op" type="number" step="0.01" min="1" placeholder="السعر ر.س" value="${o.price ? o.price / 100 : ''}" aria-label="السعر بالريال">
  <label style="margin:0"><input type="checkbox" class="oa" ${o.active === false ? '' : 'checked'}> فعّالة</label><button type="button" class="sm orm">حذف</button></div>`;
}

function editProduct(p) {
  const d = p || { title: '', cat: 'cards', label: '', region: '', desc: '', c: ['#3B30F5', '#9B5CFF'], active: true, opts: [{ label: '', price: 0 }] };
  pdlg.innerHTML = `<form class="dpad" id="pf"><h3>${p ? 'تعديل المنتج' : 'منتج جديد'}</h3>
  <div class="fld"><label for="f-title">اسم المنتج</label><input id="f-title" maxlength="80" required value="${esc(d.title)}"></div>
  <div class="fld two"><div><label for="f-cat">النوع</label><select id="f-cat">${Object.entries(CATN).map(([k, v]) => `<option value="${k}" ${k === d.cat ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div><label for="f-label">الاسم القصير على الغلاف</label><input id="f-label" maxlength="14" required dir="ltr" placeholder="PSN" value="${esc(d.label)}"></div></div>
  <div class="fld"><label for="f-region">المنطقة (اختياري)</label><input id="f-region" maxlength="40" value="${esc(d.region)}"></div>
  <div class="fld"><label for="f-desc">الوصف</label><textarea id="f-desc" maxlength="400">${esc(d.desc)}</textarea></div>
  <div class="fld two"><div><label for="f-c1">لون الغلاف الأول</label><input id="f-c1" type="color" value="${esc(d.c[0])}"></div><div><label for="f-c2">لون الغلاف الثاني</label><input id="f-c2" type="color" value="${esc(d.c[1])}"></div></div>
  <div class="fld"><label>الفئات والأسعار</label><div id="opts">${d.opts.map(optRow).join('')}</div><button type="button" class="sm" id="addopt">إضافة فئة</button></div>
  <div class="fld"><label><input type="checkbox" id="f-active" style="width:auto;min-height:0" ${d.active ? 'checked' : ''}> ظاهر في المتجر</label></div>
  <div class="err" id="perr" role="alert"></div>
  <div class="dact"><button type="button" class="btn ghost" id="pc">إلغاء</button><button class="btn" id="ps">حفظ</button></div></form>`;
  pdlg.showModal();
  $('#pc').onclick = () => pdlg.close();
  $('#addopt').onclick = () => $('#opts').insertAdjacentHTML('beforeend', optRow({ label: '', price: 0 }));
  $('#opts').onclick = e => { if (e.target.classList.contains('orm')) e.target.closest('.optedit').remove(); };
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    const body = {
      id: p ? p.id : undefined, title: $('#f-title').value, cat: $('#f-cat').value, label: $('#f-label').value, region: $('#f-region').value,
      descr: $('#f-desc').value, c1: $('#f-c1').value, c2: $('#f-c2').value, active: $('#f-active').checked,
      opts: [...document.querySelectorAll('#opts .optedit')].map(r => ({ id: r.dataset.id || null, label: r.querySelector('.ol').value, price: r.querySelector('.op').value, active: r.querySelector('.oa').checked })),
    };
    $('#ps').disabled = true;
    try { await api('/api/admin/products', { method: 'POST', body }); pdlg.close(); toast('تم الحفظ'); viewProducts(); }
    catch (er) { $('#perr').textContent = er.message; $('#ps').disabled = false; if (er.status === 401) { pdlg.close(); loginView(); } }
  };
}
pdlg.addEventListener('click', e => { if (e.target === pdlg) pdlg.close(); });

function codesDialog(optId) {
  const p = products.find(x => x.opts.some(o => o.id === optId)), o = p.opts.find(x => x.id === optId);
  cdlg.innerHTML = `<form class="dpad" id="cf"><h3>إضافة أكواد</h3><p class="note" style="margin:0 0 12px">${esc(p.title)}، ${esc(o.label)}</p>
  <div class="fld"><label for="c-codes">الأكواد (كل كود في سطر)</label><textarea id="c-codes" dir="ltr" style="min-height:180px;text-align:left" placeholder="XXXX-XXXX-XXXX"></textarea></div>
  <p class="note">تُشفَّر الأكواد عند الحفظ ولا تظهر هنا مرة أخرى. الأكواد المكررة تُتجاهل تلقائيًا.</p>
  <div class="err" id="cerr" role="alert"></div>
  <div class="dact"><button type="button" class="btn ghost" id="cc">إلغاء</button><button class="btn" id="cs">حفظ الأكواد</button></div></form>`;
  cdlg.showModal();
  $('#cc').onclick = () => cdlg.close();
  $('#cf').onsubmit = async e => {
    e.preventDefault(); $('#cs').disabled = true;
    try {
      const r = await api('/api/admin/codes', { method: 'POST', body: { option_id: optId, codes: $('#c-codes').value } });
      cdlg.close(); toast(`أُضيف ${n(r.added)} كود${r.duplicates ? `، مكرر: ${n(r.duplicates)}` : ''}`); viewProducts();
    } catch (er) { $('#cerr').textContent = er.message; $('#cs').disabled = false; }
  };
}
cdlg.addEventListener('click', e => { if (e.target === cdlg) cdlg.close(); });

/* ---------- الطلبات ---------- */
function viewOrders() {
  guard(async () => {
    const { orders } = await api('/api/admin/orders');
    $('#view').innerHTML = orders.length ? `<div class="tblw"><table class="tbl"><thead><tr><th>#</th><th>البريد</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th><th>البريد أُرسل</th><th></th></tr></thead><tbody>` +
      orders.map(o => `<tr><td>${n(o.id)}</td><td dir="ltr" style="text-align:right">${esc(o.email)}</td><td>${money(o.total)}</td><td><span class="stat ${esc(o.status)}">${esc(ST[o.status] || o.status)}</span></td><td>${when(o.paid_at || o.created_at)}</td><td>${o.mailed_at ? 'نعم' : '—'}</td><td>${o.status === 'paid' ? `<button class="sm" data-resend="${o.id}">إعادة إرسال</button>` : ''}</td></tr>`).join('') + '</tbody></table></div>'
      : '<p class="note">لا توجد طلبات بعد.</p>';
    $('#view').querySelectorAll('[data-resend]').forEach(b => b.onclick = () => guard(async () => {
      b.disabled = true; await api(`/api/admin/orders/${b.dataset.resend}/resend`, { method: 'POST', body: {} }); toast('أُعيد إرسال الأكواد'); viewOrders();
    }));
  });
}

/* ---------- الأمان ---------- */
function viewSecurity() {
  guard(async () => {
    meta = await api('/api/admin/me');
    const ck = (ok, t, hint) => `<div class="orow"><span>${ok ? '✓' : '✗'} ${t}</span><span class="st" style="color:${ok ? 'var(--ok)' : 'var(--warn)'}">${ok ? 'مفعّل' : hint}</span></div>`;
    $('#view').innerHTML = `<div class="pcard"><h3 style="margin-bottom:4px">قائمة الأمان</h3>
      ${ck(meta.totp, 'التحقق بخطوتين للوحة التحكم', 'غير مفعّل')}
      ${ck(meta.turnstile, 'حماية الشراء من البوتات (Turnstile)', 'غير مفعّلة: أضف مفاتيح Turnstile')}
      ${ck(meta.https, 'اتصال HTTPS', 'BASE_URL ليس https')}
      ${ck(meta.mode === 'moyasar', 'الدفع الحقيقي', 'الدفع تجريبي')}
      ${ck(meta.mail !== 'console', 'إرسال البريد الحقيقي', 'البريد تجريبي')}</div>
      <div class="pcard" id="tfa" style="margin-top:12px"></div>`;
    renderTfa();
  });
}
function renderTfa() {
  const box = $('#tfa');
  if (meta.totp) {
    box.innerHTML = `<h3>التحقق بخطوتين</h3><p class="note" style="margin:4px 0 12px">مفعّل. لإلغائه اكتب رمزًا حاليًا من التطبيق.</p>
      <form id="tf-off"><div class="fld"><label for="off-code">رمز التحقق</label><input id="off-code" inputmode="numeric" maxlength="7" dir="ltr" required></div><div class="err" id="tf-err" role="alert"></div><button class="sm">إلغاء التفعيل</button></form>`;
    $('#tf-off').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/admin/2fa/disable', { method: 'POST', body: { code: $('#off-code').value } }); toast('أُلغي التحقق بخطوتين'); meta.totp = false; shell(); }
      catch (er) { $('#tf-err').textContent = er.message; }
    };
    return;
  }
  box.innerHTML = `<h3>التحقق بخطوتين</h3><p class="note" style="margin:4px 0 12px">يحميك حتى لو سُرقت كلمة المرور. تحتاج تطبيق مصادقة مثل Google Authenticator أو Microsoft Authenticator أو Authy.</p><button class="btn" id="tf-start" style="min-height:44px">ابدأ الإعداد</button>`;
  $('#tf-start').onclick = () => guard(async () => {
    const r = await api('/api/admin/2fa/setup', { method: 'POST', body: {} });
    box.innerHTML = `<h3>التحقق بخطوتين</h3>
      <ol style="padding-inline-start:20px;color:var(--muted)"><li>في تطبيق المصادقة اختر «إضافة حساب» ثم «إدخال مفتاح الإعداد يدويًا».</li><li>اكتب هذا المفتاح (الاسم: Codeweb، النوع: مبني على الوقت):</li></ol>
      <div class="codebox" style="margin:8px 0"><code id="tsec">${esc(r.secret.match(/.{1,4}/g).join(' '))}</code><button type="button" id="tcopy">نسخ</button></div>
      <p class="note">على الجوال يمكنك أيضًا الضغط على <a href="${esc(r.uri)}" style="color:var(--blue)">هذا الرابط</a> ليفتح تطبيق المصادقة مباشرة.</p>
      <form id="tf-on"><div class="fld"><label for="on-code">ثم اكتب الرمز المكوّن من ٦ أرقام الظاهر في التطبيق</label><input id="on-code" inputmode="numeric" maxlength="7" dir="ltr" required></div><div class="err" id="tf-err" role="alert"></div><button class="btn" style="min-height:44px">تفعيل</button></form>`;
    $('#tcopy').onclick = async () => { try { await navigator.clipboard.writeText(r.secret); toast('تم النسخ'); } catch { toast('حدّد المفتاح وانسخه'); } };
    $('#tf-on').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/admin/2fa/enable', { method: 'POST', body: { code: $('#on-code').value } }); toast('فُعّل التحقق بخطوتين'); meta.totp = true; shell(); }
      catch (er) { $('#tf-err').textContent = er.message; }
    };
  });
}

/* ---------- سجل النشاط ---------- */
const AL = { login: 'دخول', login_failed: 'محاولة دخول فاشلة', logout: 'خروج', product_created: 'إنشاء منتج', product_updated: 'تعديل منتج', codes_added: 'إضافة أكواد', order_resend: 'إعادة إرسال أكواد', '2fa_enabled': 'تفعيل التحقق بخطوتين', '2fa_disabled': 'إلغاء التحقق بخطوتين', '2fa_reset_cli': 'إلغاء التحقق بخطوتين من الخادم' };
function viewAudit() {
  guard(async () => {
    const { log } = await api('/api/admin/audit');
    $('#view').innerHTML = `<p class="note" style="margin:0 0 10px">آخر ٢٠٠ حدث. «البصمة» رمز مختصر للعنوان وليس العنوان نفسه. لا تُسجَّل كلمات المرور ولا الأكواد.</p>` + (log.length
      ? `<div class="tblw"><table class="tbl"><thead><tr><th>الوقت</th><th>الحدث</th><th>التفاصيل</th><th>البصمة</th></tr></thead><tbody>${log.map(l => `<tr><td>${when(l.ts)}</td><td><span class="stat ${l.action === 'login_failed' ? 'failed' : ''}">${esc(AL[l.action] || l.action)}</span></td><td>${esc(l.detail)}</td><td dir="ltr" style="text-align:right">${esc(l.ip_hash || '—')}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="note">لا أحداث بعد.</p>');
  });
}

boot();
