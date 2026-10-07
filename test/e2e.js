'use strict';
/* اختبار شامل: node test/e2e.js  (لا يحتاج أي اعتماديات ولا يلمس بياناتك الحقيقية) */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeweb-test-'));
Object.assign(process.env, {
  DB_PATH: path.join(tmp, 'test.db'), PAYMENT_MODE: 'demo', MAIL_MODE: 'console', NODE_ENV: 'development',
  ADMIN_PASSWORD: 'test-admin-pass', SESSION_SECRET: 'x'.repeat(40), CODES_SECRET: 'test-codes-secret-123', SEED_DEMO: '0', MAX_PENDING_IP: '100',
});
const U = require('../lib/util');
const { db, seedDemo, hashIp } = require('../lib/db');
const { server } = require('../server');

const mails = [];
const origLog = console.log;
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[بريد تجريبي]')) mails.push(s); else origLog(...a); };

let base, cookie = '';
const call = async (method, url, body, extra = {}) => {
  const r = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('cw_admin=') && !sc.startsWith('cw_admin=;')) cookie = sc.split(';')[0];
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, headers: r.headers };
};
const avail = optId => db.prepare("SELECT COUNT(*) n FROM codes WHERE option_id=? AND status='available'").get(optId).n;
const tokenOf = url => url.split('/').pop();
let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; origLog('  ✓', name); } catch (e) { origLog('  ✗', name, '\n   ', e.message); process.exitCode = 1; throw e; } };

(async () => {
  seedDemo();
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  const realFetch = global.fetch;

  const { products } = (await call('GET', '/api/products')).body;
  const opt = products[0].opts[0];

  await t('المنتجات تُعرض بدون أي أكواد أو بيانات حساسة', async () => {
    assert.ok(products.length >= 5);
    const raw = JSON.stringify(products);
    assert.ok(!raw.includes('DEMO-') && !raw.includes('code_enc'));
    assert.ok(opt.max > 0);
  });

  await t('الصفحات الثابتة تعمل وتمنع الوصول للملفات الخاصة', async () => {
    assert.equal((await call('GET', '/')).status, 200);
    assert.equal((await call('GET', '/admin')).status, 200);
    assert.equal((await call('GET', '/order/abcdefghijklmnopqrstuvwx')).status, 200);
    assert.equal((await call('GET', '/policies')).status, 200);
    assert.equal((await call('GET', '/..%2f..%2fserver.js')).status, 404);
    assert.equal((await call('GET', '/../lib/util.js')).status, 404);
    assert.equal((await call('GET', '/.env')).status, 404);
  });

  await t('التحقق من المدخلات: بريد خاطئ، كمية خارج الحد، فئة غير موجودة', async () => {
    assert.equal((await call('POST', '/api/checkout', { email: 'bad', items: [{ opt: opt.id, qty: 1 }] })).status, 400);
    assert.equal((await call('POST', '/api/checkout', { email: 'a@b.co', items: [{ opt: opt.id, qty: 6 }] })).status, 400);
    assert.equal((await call('POST', '/api/checkout', { email: 'a@b.co', items: [{ opt: 999999, qty: 1 }] })).status, 400);
    assert.equal((await call('POST', '/api/checkout', { email: 'a@b.co', items: [] })).status, 400);
    assert.equal((await call('POST', '/api/checkout', 'x', { 'Content-Type': 'text/plain' })).status, 415);
  });

  let tokenA;
  await t('الطلب يحجز الأكواد ولا يكشفها قبل الدفع', async () => {
    const before = avail(opt.id);
    const r = await call('POST', '/api/checkout', { email: 'buyer@example.com', items: [{ opt: opt.id, qty: 2 }] });
    assert.equal(r.status, 200);
    tokenA = tokenOf(r.body.url);
    assert.equal(avail(opt.id), before - 2);
    const v = (await call('GET', '/api/order/' + tokenA)).body;
    assert.equal(v.status, 'pending');
    assert.equal(v.total, opt.price * 2);
    assert.equal(v.items[0].codes, undefined);
    assert.ok(!JSON.stringify(v).includes('DEMO-'));
    assert.ok(v.email.includes('***'));
  });

  await t('الدفع يسلّم الأكواد مرة واحدة فقط ويرسل بريدًا واحدًا (حتى مع التكرار)', async () => {
    await call('POST', '/api/demo-pay/' + tokenA, {});
    await call('POST', '/api/demo-pay/' + tokenA, {});
    await Promise.all([call('POST', '/api/demo-pay/' + tokenA, {}), call('POST', '/api/demo-pay/' + tokenA, {})]);
    const v = (await call('GET', '/api/order/' + tokenA)).body;
    assert.equal(v.status, 'paid');
    assert.equal(v.items[0].codes.length, 2);
    assert.equal(new Set(v.items[0].codes).size, 2);
    assert.ok(v.items[0].codes.every(c => c.startsWith('DEMO-')));
    assert.equal(mails.length, 1);
    assert.ok(mails[0].includes('buyer@example.com'));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM codes WHERE order_id=(SELECT id FROM orders WHERE token=?) AND status='sold'").get(tokenA).n, 2);
  });

  await t('الأكواد مشفّرة في قاعدة البيانات', async () => {
    const row = db.prepare("SELECT code_enc FROM codes WHERE status='sold' LIMIT 1").get();
    assert.ok(!row.code_enc.includes('DEMO-'));
    assert.ok(U.decCode(row.code_enc).startsWith('DEMO-'));
  });

  await t('لا يمكن بيع كمية أكبر من المخزون (منع البيع الزائد)', async () => {
    const one = products[1].opts[0];             // ٦ أكواد
    const a = await call('POST', '/api/checkout', { email: 'a@b.co', items: [{ opt: one.id, qty: 5 }] });
    assert.equal(a.status, 200);
    const b = await call('POST', '/api/checkout', { email: 'c@d.co', items: [{ opt: one.id, qty: 5 }] });
    assert.equal(b.status, 409);
    assert.equal(avail(one.id), 1);              // فشل الطلب الثاني لم يحجز شيئًا
    assert.equal((await call('POST', '/api/checkout', { email: 'c@d.co', items: [{ opt: one.id, qty: 1 }] })).status, 200);
  });

  await t('انتهاء الحجز يعيد الأكواد للمخزون', async () => {
    const o = products[2].opts[0];
    const before = avail(o.id);
    const r = await call('POST', '/api/checkout', { email: 'x@y.co', items: [{ opt: o.id, qty: 3 }] });
    assert.equal(avail(o.id), before - 3);
    db.prepare('UPDATE codes SET reserved_until=1 WHERE order_id=(SELECT id FROM orders WHERE token=?)').run(tokenOf(r.body.url));
    db.prepare('UPDATE orders SET created_at=1 WHERE token=?').run(tokenOf(r.body.url));
    await call('POST', '/api/checkout', { email: 'x@y.co', items: [{ opt: o.id, qty: 1 }] }); // يشغّل التنظيف
    assert.equal(avail(o.id), before - 1);
    assert.equal((await call('GET', '/api/order/' + tokenOf(r.body.url))).body.status, 'expired');
  });

  await t('حد الطلبات المعلّقة: لكل بريد ولكل عنوان، مع دعم عنوان Cloudflare', async () => {
    const o = products[5].opts[0], em = 'limit@x.co';
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/checkout', { email: em, items: [{ opt: o.id, qty: 1 }] })).status, 200);
    assert.equal((await call('POST', '/api/checkout', { email: em, items: [{ opt: o.id, qty: 1 }] })).status, 429);
    assert.equal((await call('POST', '/api/checkout', { email: 'other@x.co', items: [{ opt: o.id, qty: 1 }] })).status, 200);
    const keep = U.cfg.maxPendingIp;
    U.cfg.maxPendingIp = 1;
    assert.equal((await call('POST', '/api/checkout', { email: 'third@x.co', items: [{ opt: products[6].opts[0].id, qty: 1 }] })).status, 429);
    U.cfg.trustCloudflare = true;           // عنوان آخر خلف Cloudflare لا يتأثر بحد غيره
    const r2 = await call('POST', '/api/checkout', { email: 'cf@x.co', items: [{ opt: products[6].opts[0].id, qty: 1 }] }, { 'cf-connecting-ip': '203.0.113.9' });
    assert.equal(r2.status, 200);
    assert.equal(db.prepare("SELECT ip_hash FROM orders WHERE email='cf@x.co'").get().ip_hash, hashIp('203.0.113.9'));
    U.cfg.trustCloudflare = false; U.cfg.maxPendingIp = keep;
  });

  await t('Turnstile: يرفض بلا رمز أو برمز مزوّر، ويقبل الصحيح، ولا يكشف السر', async () => {
    U.cfg.turnstileSecret = 'ts-secret'; U.cfg.turnstileSite = 'site-key';
    const realF = global.fetch, seen = []; let down = false;
    global.fetch = async (url, init = {}) => {
      if (!String(url).startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) return realF(url, init);
      assert.equal(init.method, 'POST');
      const b = new URLSearchParams(init.body.toString()); seen.push(b);
      if (down) throw new Error('net');
      return { ok: true, json: async () => ({ success: b.get('response') === 'good-token' && b.get('secret') === 'ts-secret' }) };
    };
    const o = products[6].opts[1], body = tk => ({ email: 'ts@x.co', turnstile: tk, items: [{ opt: o.id, qty: 1 }] });
    assert.equal((await call('POST', '/api/checkout', body(undefined))).status, 400);
    assert.equal((await call('POST', '/api/checkout', body('fake'))).status, 400);
    assert.equal((await call('POST', '/api/checkout', body('good-token'))).status, 200);
    down = true; const oe = console.error; console.error = () => {};
    assert.equal((await call('POST', '/api/checkout', body('good-token'))).status, 503);
    console.error = oe; down = false;
    const pub = await call('GET', '/api/products');
    assert.equal(pub.body.turnstile, 'site-key');
    assert.ok(!JSON.stringify(pub.body).includes('ts-secret'));
    assert.ok(seen.length >= 3 && seen.every(b => b.get('secret') === 'ts-secret'));
    U.cfg.turnstileSecret = ''; U.cfg.turnstileSite = ''; global.fetch = realF;
    assert.equal((await call('GET', '/api/products')).body.turnstile, null);
  });

  /* ---------- الدفع الحقيقي (Moyasar) بمحاكاة الشبكة ---------- */
  U.resetLimits();   // حد طلبات الشراء لكل عنوان (٢٠ كل ١٠ دقائق) تجاوزته الاختبارات السابقة
  U.cfg.payMode = 'moyasar'; U.cfg.moyasarKey = 'sk_test_fake';
  const invoices = new Map();
  global.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://api.moyasar.com/v1/')) return realFetch(url, init);
    assert.ok(init.headers.Authorization.startsWith('Basic '), 'يجب إرسال المفتاح السري');
    const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
    if (init.method === 'POST') {
      const b = JSON.parse(init.body);
      const id = 'inv_' + (invoices.size + 1);
      invoices.set(id, { id, status: 'initiated', amount: b.amount, currency: b.currency, ...b });
      return json({ id, url: 'https://checkout.moyasar.com/invoices/' + id, ...b });
    }
    const inv = invoices.get(decodeURIComponent(String(url).split('/').pop()));
    return inv ? json(inv) : json({}, 404);
  };

  let tokenB, invB;
  await t('Moyasar: إنشاء فاتورة بالمبلغ الصحيح (من الخادم لا من المتصفح)', async () => {
    const o = products[3].opts[0];
    const r = await call('POST', '/api/checkout', { email: 'm@e.co', items: [{ opt: o.id, qty: 2 }], total: 1, price: 1 });
    assert.equal(r.status, 200);
    assert.ok(r.body.url.startsWith('https://checkout.moyasar.com/invoices/'));
    tokenB = db.prepare('SELECT token FROM orders ORDER BY id DESC LIMIT 1').get().token;
    invB = invoices.get(r.body.url.split('/').pop());
    assert.equal(invB.amount, o.price * 2);
    assert.equal(invB.currency, 'SAR');
    assert.ok(invB.success_url.endsWith('/order/' + tokenB));
    assert.ok(invB.callback_url.endsWith('/api/pay/callback/' + tokenB));
  });

  await t('Moyasar: فاتورة غير مدفوعة أو مبلغ مختلف لا يسلّم الأكواد', async () => {
    assert.equal((await call('GET', '/api/order/' + tokenB)).body.status, 'pending');
    invB.status = 'paid'; invB.amount = 100;                 // محاولة غش: مدفوع بمبلغ أقل
    await call('POST', '/api/pay/callback/' + tokenB, { fake: true });
    assert.equal((await call('GET', '/api/order/' + tokenB)).body.status, 'pending');
    invB.amount = (await call('GET', '/api/order/' + tokenB)).body.total;
    invB.status = 'failed';
    assert.equal((await call('GET', '/api/order/' + tokenB)).body.status, 'pending');
  });

  await t('Moyasar: بعد دفع صحيح يتم التسليم عند الاستدعاء أو عند فتح الصفحة', async () => {
    invB.status = 'paid';
    const mailsBefore = mails.length;
    await call('POST', '/api/pay/callback/' + tokenB, {});
    const v = (await call('GET', '/api/order/' + tokenB)).body;
    assert.equal(v.status, 'paid');
    assert.equal(v.items[0].codes.length, 2);
    assert.equal(mails.length, mailsBefore + 1);
    assert.equal((await call('POST', '/api/demo-pay/' + tokenB, {})).status, 404);   // الدفع التجريبي معطّل
  });

  await t('دفع متأخر بعد انتهاء الحجز: يُسلَّم إن توفر المخزون، وإلا يُعلَّم للاسترجاع', async () => {
    // منتج بكود واحد فقط
    const pid = Number(db.prepare("INSERT INTO products(title,cat,label,created_at) VALUES('اختبار','cards','TEST',1)").run().lastInsertRowid);
    const oid = Number(db.prepare("INSERT INTO options(product_id,label,price) VALUES(?,'فئة',1000)").run(pid).lastInsertRowid);
    db.prepare("INSERT INTO codes(option_id,code_enc,code_hash,created_at) VALUES(?,?,?,1)").run(oid, U.encCode('ONLY-ONE-CODE'), U.hashCode('ONLY-ONE-CODE'));
    const a = await call('POST', '/api/checkout', { email: 'a@a.co', items: [{ opt: oid, qty: 1 }] });
    const tokA = db.prepare('SELECT token FROM orders ORDER BY id DESC LIMIT 1').get().token;
    const invA = invoices.get(a.body.url.split('/').pop());
    db.prepare('UPDATE codes SET reserved_until=1 WHERE option_id=?').run(oid);
    db.prepare('UPDATE orders SET created_at=1 WHERE token=?').run(tokA);
    const b = await call('POST', '/api/checkout', { email: 'b@b.co', items: [{ opt: oid, qty: 1 }] });   // يأخذ الكود المحرَّر
    assert.equal(b.status, 200);
    invA.status = 'paid';
    const v = (await call('GET', '/api/order/' + tokA)).body;
    assert.equal(v.status, 'needs_refund');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM codes WHERE option_id=? AND status='sold'").get(oid).n, 0);
  });

  await t('فشل إنشاء الفاتورة يحرّر الحجز ويرجع خطأ واضحًا', async () => {
    const o = products[4].opts[0], before = avail(o.id);
    const keep = global.fetch;
    global.fetch = async (u, i) => String(u).startsWith('https://api.moyasar.com') ? { ok: false, status: 500, json: async () => ({}) } : keep(u, i);
    const origErr = console.error; console.error = () => {};
    const r = await call('POST', '/api/checkout', { email: 'f@f.co', items: [{ opt: o.id, qty: 1 }] });
    console.error = origErr; global.fetch = keep;
    assert.equal(r.status, 502);
    assert.equal(avail(o.id), before);
  });
  U.cfg.payMode = 'demo'; global.fetch = realFetch;

  /* ---------- لوحة التحكم ---------- */
  await t('الإدارة: ترفض بدون تسجيل دخول وبكلمة مرور خاطئة', async () => {
    assert.equal((await call('GET', '/api/admin/summary')).status, 401);
    assert.equal((await call('GET', '/api/admin/products')).status, 401);
    assert.equal((await call('POST', '/api/admin/codes', { option_id: 1, codes: 'AAAA' })).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
    assert.equal((await call('GET', '/api/admin/summary', undefined, { Cookie: 'cw_admin=123.fake' })).status, 401);
  });

  await t('الإدارة: تسجيل الدخول ثم الملخص والطلبات', async () => {
    const r = await call('POST', '/api/admin/login', { password: 'test-admin-pass' });
    assert.equal(r.status, 200);
    assert.ok(/HttpOnly/i.test(r.headers.get('set-cookie')) && /SameSite=Strict/i.test(r.headers.get('set-cookie')));
    const s = (await call('GET', '/api/admin/summary')).body;
    assert.ok(s.paidCount >= 2 && s.revenue > 0);
    const { orders } = (await call('GET', '/api/admin/orders')).body;
    assert.ok(orders.length >= 5);
    assert.ok(orders.some(o => o.status === 'needs_refund'));
  });

  let newOpt;
  await t('الإدارة: إضافة منتج وفئات وأكواد مع كشف المكرر وتشفيرها', async () => {
    const bad = await call('POST', '/api/admin/products', { title: 'x', cat: 'zzz', label: 'X', c1: '#000000', c2: '#ffffff', opts: [{ label: 'a', price: 5 }] });
    assert.equal(bad.status, 400);
    const bad2 = await call('POST', '/api/admin/products', { title: 'x', cat: 'cards', label: 'X', c1: 'red', c2: '#ffffff', opts: [{ label: 'a', price: 5 }] });
    assert.equal(bad2.status, 400);
    const r = await call('POST', '/api/admin/products', { title: 'بطاقة اختبار <b>', cat: 'cards', label: 'TEST2', region: 'عالمي', descr: 'وصف', c1: '#112233', c2: '#445566', opts: [{ label: '١٠ ريال', price: 10 }, { label: '٢٠ ريال', price: 19.5 }] });
    assert.equal(r.status, 200);
    const list = (await call('GET', '/api/admin/products')).body.products;
    const p = list.find(x => x.id === r.body.id);
    assert.equal(p.opts.length, 2);
    assert.equal(p.opts[1].price, 1950);
    newOpt = p.opts[0].id;
    const c = await call('POST', '/api/admin/codes', { option_id: newOpt, codes: 'AAAA-1111\nBBBB-2222\n  AAAA-1111  \nxy\n\nCCCC-3333' });
    assert.deepEqual(c.body, { added: 3, duplicates: 0 });         // التكرار داخل الدفعة يُحذف قبل الإدخال
    const c2 = await call('POST', '/api/admin/codes', { option_id: newOpt, codes: 'AAAA-1111\nDDDD-4444' });
    assert.deepEqual(c2.body, { added: 1, duplicates: 1 });        // وتكرار الأكواد المخزنة سابقًا يُكتشف
    assert.equal(avail(newOpt), 4);
    const pub = (await call('GET', '/api/products')).body.products.find(x => x.id === r.body.id);
    assert.equal(pub.opts[0].max, 4);
    assert.equal(pub.opts[1].max, 0);                               // فئة بلا أكواد = نفدت
    assert.ok(!JSON.stringify(pub).includes('AAAA-1111'));
  });

  await t('الإدارة: تعطيل فئة ومنتج يخفيهما عن المتجر ويمنع شراءهما', async () => {
    const list = (await call('GET', '/api/admin/products')).body.products;
    const p = list.find(x => x.title.startsWith('بطاقة اختبار'));
    await call('POST', '/api/admin/products', { ...p, desc: undefined, descr: 'وصف', c1: p.c[0], c2: p.c[1], opts: [{ id: p.opts[0].id, label: p.opts[0].label, price: 10, active: false }, { id: p.opts[1].id, label: p.opts[1].label, price: 19.5 }] });
    const pub = (await call('GET', '/api/products')).body.products.find(x => x.id === p.id);
    assert.equal(pub.opts.length, 1);
    assert.equal((await call('POST', '/api/checkout', { email: 'a@b.co', items: [{ opt: newOpt, qty: 1 }] })).status, 400);
    await call('POST', '/api/admin/products', { ...p, c1: p.c[0], c2: p.c[1], active: false, opts: [{ id: p.opts[1].id, label: 'x', price: 19.5 }] });
    assert.ok(!(await call('GET', '/api/products')).body.products.some(x => x.id === p.id));
  });

  await t('الإدارة: إعادة إرسال الأكواد للطلب المدفوع فقط', async () => {
    const { orders } = (await call('GET', '/api/admin/orders')).body;
    const paid = orders.find(o => o.status === 'paid'), pend = orders.find(o => o.status === 'expired');
    const before = mails.length;
    assert.equal((await call('POST', `/api/admin/orders/${paid.id}/resend`, {})).status, 200);
    assert.equal(mails.length, before + 1);
    assert.equal((await call('POST', `/api/admin/orders/${pend.id}/resend`, {})).status, 400);
  });

  await t('التحقق بخطوتين: التفعيل، ثم الدخول يتطلب الرمز ولا يقبل الرمز مرتين', async () => {
    U.resetLimits();
    const setup = (await call('POST', '/api/admin/2fa/setup', {})).body;
    assert.ok(/^[A-Z2-7]{32}$/.test(setup.secret));
    assert.ok(setup.uri.startsWith('otpauth://totp/') && setup.uri.includes(setup.secret));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM settings').all()).includes(setup.secret), 'السر يجب أن يُخزَّن مشفّرًا');
    const now = Math.floor(Date.now() / 30000), code = s => U.totpCode(setup.secret, now + s);
    assert.equal((await call('POST', '/api/admin/2fa/enable', { code: 'abc' })).status, 400);
    assert.equal((await call('POST', '/api/admin/2fa/enable', { code: code(-1) })).status, 200);
    assert.equal((await call('GET', '/api/admin/login-info')).body.totp, true);
    assert.equal((await call('GET', '/api/admin/me')).body.totp, true);

    cookie = '';
    assert.equal((await call('POST', '/api/admin/login', { password: 'test-admin-pass' })).status, 401);          // بلا رمز
    assert.equal((await call('POST', '/api/admin/login', { password: 'wrong', code: code(0) })).status, 401);      // كلمة مرور خاطئة
    assert.equal((await call('GET', '/api/admin/summary')).status, 401);
    const ok = await call('POST', '/api/admin/login', { password: 'test-admin-pass', code: code(0) });             // الرمز لم يُحرق بالمحاولة الفاشلة
    assert.equal(ok.status, 200);
    assert.equal((await call('GET', '/api/admin/summary')).status, 200);

    const session = cookie; cookie = '';
    assert.equal((await call('POST', '/api/admin/login', { password: 'test-admin-pass', code: code(0) })).status, 401);   // إعادة استخدام الرمز
    assert.equal((await call('POST', '/api/admin/login', { password: 'test-admin-pass', code: code(-1) })).status, 401);  // رمز أقدم
    cookie = session;

    assert.equal((await call('POST', '/api/admin/2fa/disable', { code: '000000' })).status, 400);
    assert.equal((await call('POST', '/api/admin/2fa/disable', { code: code(1) })).status, 200);
    assert.equal((await call('GET', '/api/admin/login-info')).body.totp, false);
    cookie = '';
    assert.equal((await call('POST', '/api/admin/login', { password: 'test-admin-pass' })).status, 200);
  });

  await t('سجل النشاط: يسجّل الأحداث المهمة ولا يحتوي كلمات مرور ولا أكوادًا', async () => {
    const { log } = (await call('GET', '/api/admin/audit')).body;
    const acts = new Set(log.map(l => l.action));
    for (const a of ['login', 'login_failed', 'product_created', 'product_updated', 'codes_added', 'order_resend', '2fa_enabled', '2fa_disabled']) assert.ok(acts.has(a), 'مفقود: ' + a);
    const raw = JSON.stringify(log);
    assert.ok(!raw.includes('AAAA-1111') && !raw.includes('DDDD-4444') && !raw.includes('test-admin-pass') && !raw.includes('127.0.0.1'));
    assert.equal((await call('GET', '/api/admin/audit', undefined, { Cookie: '' })).status, 401);
  });

  await t('تسجيل الخروج يلغي الجلسة، وتحديد المعدل يحمي تسجيل الدخول', async () => {
    U.resetLimits();
    await call('POST', '/api/admin/logout', {});
    cookie = '';
    assert.equal((await call('GET', '/api/admin/summary')).status, 401);
    let last;
    for (let i = 0; i < 7; i++) last = await call('POST', '/api/admin/login', { password: 'nope' + i });
    assert.equal(last.status, 429);
  });

  console.log = origLog;
  origLog(`\nنجحت ${passed} اختبارات.`);
  server.close(); fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.log = origLog; origLog('\nفشل الاختبار:', e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
