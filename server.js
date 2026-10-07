'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const U = require('./lib/util');
const { cfg, HttpError, esc, sar } = U;
const { db, tx, seedDemo, hashIp, getSetting, setSetting, delSetting, audit } = require('./lib/db');

const PUBLIC = path.join(__dirname, 'public');
const RESERVE_MS = 35 * 60 * 1000;      // مدة حجز الأكواد أثناء الدفع
const INVOICE_MS = 30 * 60 * 1000;      // صلاحية فاتورة الدفع
const CATS = ['cards', 'topup', 'subs'];
const HEX = /^#[0-9a-fA-F]{6}$/;

/* ================= المتجر ================= */
function listProducts(admin) {
  const prods = db.prepare(`SELECT * FROM products ${admin ? '' : 'WHERE active=1'} ORDER BY id DESC`).all();
  const opts = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM codes c WHERE c.option_id=o.id AND c.status='available') AS avail,
      (SELECT COUNT(*) FROM codes c WHERE c.option_id=o.id AND c.status='reserved')  AS reserved,
      (SELECT COUNT(*) FROM codes c WHERE c.option_id=o.id AND c.status='sold')      AS sold
    FROM options o ${admin ? '' : 'WHERE o.active=1'} ORDER BY o.product_id, o.sort, o.id`).all();
  const by = new Map();
  for (const o of opts) {
    if (!by.has(o.product_id)) by.set(o.product_id, []);
    by.get(o.product_id).push(admin
      ? { id: o.id, label: o.label, price: o.price, active: !!o.active, avail: o.avail, reserved: o.reserved, sold: o.sold }
      : { id: o.id, label: o.label, price: o.price, max: Math.min(o.avail, 5) });
  }
  return prods.map(p => ({
    id: p.id, title: p.title, cat: p.cat, label: p.label, region: p.region, desc: p.descr,
    c: [p.c1, p.c2], active: !!p.active, opts: by.get(p.id) || [],
  })).filter(p => admin || p.opts.length);
}

function reap() {
  const now = Date.now();
  tx(() => {
    db.prepare("UPDATE codes SET status='available',order_id=NULL,reserved_until=NULL WHERE status='reserved' AND reserved_until<?").run(now);
    db.prepare("UPDATE orders SET status='expired' WHERE status='pending' AND created_at<?").run(now - RESERVE_MS);
  });
}

function releaseOrder(orderId, status) {
  tx(() => {
    db.prepare("UPDATE codes SET status='available',order_id=NULL,reserved_until=NULL WHERE order_id=? AND status='reserved'").run(orderId);
    db.prepare("UPDATE orders SET status=? WHERE id=? AND status IN ('pending','expired')").run(status, orderId);
  });
}

async function checkout(body, ip) {
  if (U.limited('co:' + ip, 20, 10 * 60 * 1000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'اكتب بريدًا صحيحًا، مثل name@example.com');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 10) throw new HttpError(400, 'السلة فارغة');
  const lines = new Map();
  for (const it of body.items) {
    const opt = Number(it && it.opt), qty = Number(it && it.qty);
    if (!Number.isInteger(opt) || !Number.isInteger(qty) || qty < 1 || qty > 5) throw new HttpError(400, 'طلب غير صالح');
    lines.set(opt, Math.min(5, (lines.get(opt) || 0) + qty));
  }

  reap();
  const now = Date.now();
  const ipHash = hashIp(ip);
  /* حد الطلبات المعلّقة: يمنع حجز المخزون بطلبات غير مدفوعة */
  const pend = (col, val) => db.prepare(`SELECT COUNT(*) n FROM orders WHERE status='pending' AND ${col}=? AND created_at>?`).get(val, now - RESERVE_MS).n;
  if (pend('email', email) >= cfg.maxPendingEmail || pend('ip_hash', ipHash) >= cfg.maxPendingIp)
    throw new HttpError(429, 'لديك طلبات غير مكتملة كثيرة. أكمل الدفع أو انتظر ٣٥ دقيقة ثم حاول مجددًا');
  if (cfg.turnstileSecret) {
    let human = false;
    try { human = await U.verifyTurnstile(body.turnstile, ip); }
    catch (e) { console.error('[turnstile]', e.message); throw new HttpError(503, 'تعذّر التحقق الأمني الآن، حاول بعد قليل'); }
    if (!human) throw new HttpError(400, 'فشل التحقق الأمني، أعد المحاولة');
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const order = tx(() => {
    let total = 0;
    const rows = [];
    for (const [optId, qty] of lines) {
      const o = db.prepare(`SELECT o.id,o.label,o.price,p.title FROM options o JOIN products p ON p.id=o.product_id
                            WHERE o.id=? AND o.active=1 AND p.active=1`).get(optId);
      if (!o) throw new HttpError(400, 'أحد المنتجات لم يعد متاحًا');
      rows.push({ o, qty });
      total += o.price * qty;
    }
    if (total < 100) throw new HttpError(400, 'الحد الأدنى للطلب ١ ريال');
    const id = db.prepare('INSERT INTO orders(token,email,total,created_at,ip_hash) VALUES(?,?,?,?,?)').run(token, email, total, now, ipHash).lastInsertRowid;
    for (const { o, qty } of rows) {
      db.prepare('INSERT INTO order_items(order_id,option_id,qty,unit) VALUES(?,?,?,?)').run(id, o.id, qty, o.price);
      const r = db.prepare(`UPDATE codes SET status='reserved',order_id=?,reserved_until=?
                            WHERE id IN (SELECT id FROM codes WHERE option_id=? AND status='available' ORDER BY id LIMIT ?)`)
        .run(id, now + RESERVE_MS, o.id, qty);
      if (r.changes < qty) throw new HttpError(409, `الكمية المطلوبة من «${o.title} ${o.label}» غير متوفرة حاليًا`);
    }
    return { id: Number(id), total };
  });

  if (cfg.payMode === 'demo') return { url: '/order/' + token };

  try {
    const inv = await U.createInvoice({
      amount: order.total,
      description: 'Codeweb order #' + order.id,
      successUrl: `${cfg.baseUrl}/order/${token}`,
      callbackUrl: `${cfg.baseUrl}/api/pay/callback/${token}`,
      expiresAt: now + INVOICE_MS,
      metadata: { order_id: String(order.id) },
    });
    db.prepare('UPDATE orders SET provider_ref=? WHERE id=?').run(inv.id, order.id);
    return { url: inv.url };
  } catch (e) {
    console.error('[دفع] فشل إنشاء الفاتورة:', e.message);
    releaseOrder(order.id, 'failed');
    throw new HttpError(502, 'تعذّر بدء الدفع الآن، حاول مرة أخرى بعد قليل');
  }
}

function orderItems(orderId, withCodes) {
  const items = db.prepare(`
    SELECT oi.option_id, oi.qty, oi.unit, op.label AS olabel, p.title, p.label AS plabel, p.cat, p.c1, p.c2
    FROM order_items oi JOIN options op ON op.id=oi.option_id JOIN products p ON p.id=op.product_id
    WHERE oi.order_id=? ORDER BY oi.id`).all(orderId);
  const codes = withCodes
    ? db.prepare("SELECT option_id, code_enc FROM codes WHERE order_id=? AND status='sold' ORDER BY id").all(orderId)
    : [];
  return items.map(i => ({
    title: i.title, label: i.olabel, plabel: i.plabel, cat: i.cat, c: [i.c1, i.c2], qty: i.qty, unit: i.unit,
    codes: withCodes ? codes.filter(c => c.option_id === i.option_id).map(c => U.decCode(c.code_enc)) : undefined,
  }));
}

/* تأكيد الدفع وتسليم الأكواد (آمن للتكرار) */
async function finalize(orderId) {
  const result = tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o || !['pending', 'expired'].includes(o.status)) return null;
    const items = db.prepare('SELECT option_id, qty FROM order_items WHERE order_id=?').all(o.id);
    let ok = true;
    for (const it of items) {
      const have = db.prepare("SELECT COUNT(*) n FROM codes WHERE order_id=? AND option_id=? AND status='reserved'").get(o.id, it.option_id).n;
      if (have < it.qty) {
        const need = it.qty - have;
        const r = db.prepare(`UPDATE codes SET status='reserved',order_id=?,reserved_until=?
                              WHERE id IN (SELECT id FROM codes WHERE option_id=? AND status='available' ORDER BY id LIMIT ?)`)
          .run(o.id, Date.now() + 60000, it.option_id, need);
        if (r.changes < need) ok = false;
      }
    }
    if (!ok) {
      db.prepare("UPDATE codes SET status='available',order_id=NULL,reserved_until=NULL WHERE order_id=? AND status='reserved'").run(o.id);
      db.prepare("UPDATE orders SET status='needs_refund' WHERE id=?").run(o.id);
      return 'needs_refund';
    }
    db.prepare("UPDATE codes SET status='sold',reserved_until=NULL WHERE order_id=? AND status='reserved'").run(o.id);
    db.prepare("UPDATE orders SET status='paid',paid_at=? WHERE id=?").run(Date.now(), o.id);
    return 'paid';
  });
  if (result === 'paid') await mailOrder(orderId).catch(e => console.error('[بريد] فشل الإرسال:', e.message));
  if (result === 'needs_refund') console.error(`[تنبيه] الطلب #${orderId} مدفوع لكن المخزون نفد: يلزم استرجاع المبلغ يدويًا`);
  return result;
}

async function syncPayment(o) {
  if (cfg.payMode !== 'moyasar' || !o.provider_ref || !['pending', 'expired'].includes(o.status)) return;
  try {
    const inv = await U.fetchInvoice(o.provider_ref);
    if (inv.status === 'paid' && inv.amount === o.total && inv.currency === 'SAR') await finalize(o.id);
  } catch (e) { console.error('[دفع] تعذّر التحقق من الفاتورة:', e.message); }
}

async function mailOrder(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o || o.status !== 'paid') return false;
  const items = orderItems(orderId, true);
  const link = `${cfg.baseUrl}/order/${o.token}`;
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:auto;line-height:1.8">
<h2>شكرًا لشرائك من Codeweb</h2><p>تم دفع طلبك رقم ${o.id}. هذه أكوادك:</p>
${items.map(i => `<h3 style="margin-bottom:4px">${esc(i.title)} (${esc(i.label)}) × ${i.qty}</h3>${i.codes.map(c => `<p dir="ltr" style="font-family:monospace;font-size:16px;background:#efeeff;padding:8px 12px;border-radius:6px;margin:4px 0">${esc(c)}</p>`).join('')}`).join('')}
<p>يمكنك فتح طلبك في أي وقت: <a href="${esc(link)}">${esc(link)}</a></p>
<p style="color:#666;font-size:13px">احتفظ بالأكواد ولا تشاركها مع أحد.</p></div>`;
  const text = `شكرًا لشرائك من Codeweb\nطلب رقم ${o.id}\n\n` +
    items.map(i => `${i.title} (${i.label}) × ${i.qty}\n${i.codes.join('\n')}`).join('\n\n') + `\n\n${link}`;
  await U.sendMail({ to: o.email, subject: `أكواد طلبك رقم ${o.id} من Codeweb`, html, text });
  db.prepare('UPDATE orders SET mailed_at=? WHERE id=?').run(Date.now(), o.id);
  return true;
}

async function orderView(token) {
  let o = db.prepare('SELECT * FROM orders WHERE token=?').get(token);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  if (['pending', 'expired'].includes(o.status)) {
    await syncPayment(o);
    o = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
  }
  const [name, domain] = o.email.split('@');
  return {
    id: o.id, status: o.status, total: o.total, mode: cfg.payMode, mailed: !!o.mailed_at,
    email: name.slice(0, 2) + '***@' + domain,
    items: orderItems(o.id, o.status === 'paid'),
  };
}

/* ================= الإدارة ================= */
function validateProduct(b) {
  const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const p = { title: s(b.title, 80), cat: s(b.cat, 10), label: s(b.label, 14), region: s(b.region, 40), descr: s(b.descr, 400), c1: s(b.c1, 7), c2: s(b.c2, 7) };
  if (!p.title) throw new HttpError(400, 'اسم المنتج مطلوب');
  if (!CATS.includes(p.cat)) throw new HttpError(400, 'نوع المنتج غير صالح');
  if (!p.label) throw new HttpError(400, 'الاسم القصير على الغلاف مطلوب');
  if (!HEX.test(p.c1) || !HEX.test(p.c2)) throw new HttpError(400, 'لون غير صالح (مثال: #3B30F5)');
  if (!Array.isArray(b.opts) || !b.opts.length || b.opts.length > 12) throw new HttpError(400, 'أضف فئة واحدة على الأقل (حتى ١٢)');
  p.opts = b.opts.map((o, i) => {
    const price = Math.round(Number(o.price) * 100);
    if (!s(o.label, 40)) throw new HttpError(400, 'اسم الفئة مطلوب');
    if (!Number.isFinite(price) || price < 100 || price > 5000000) throw new HttpError(400, 'السعر يجب أن يكون بين ١ و٥٠٠٠٠ ريال');
    const id = o.id == null || o.id === '' ? null : Number(o.id);
    return { id: Number.isInteger(id) ? id : null, label: s(o.label, 40), price, active: o.active === false ? 0 : 1, sort: i };
  });
  p.active = b.active === false ? 0 : 1;
  return p;
}

function saveProduct(b) {
  const p = validateProduct(b);
  const pid = Number.isInteger(Number(b.id)) && Number(b.id) > 0 ? Number(b.id) : null;
  return tx(() => {
    let id = pid;
    if (id) {
      if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw new HttpError(404, 'المنتج غير موجود');
      db.prepare('UPDATE products SET title=?,cat=?,label=?,region=?,descr=?,c1=?,c2=?,active=? WHERE id=?')
        .run(p.title, p.cat, p.label, p.region, p.descr, p.c1, p.c2, p.active, id);
    } else {
      id = Number(db.prepare('INSERT INTO products(title,cat,label,region,descr,c1,c2,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(p.title, p.cat, p.label, p.region, p.descr, p.c1, p.c2, p.active, Date.now()).lastInsertRowid);
    }
    const keep = [];
    for (const o of p.opts) {
      if (o.id && db.prepare('SELECT 1 FROM options WHERE id=? AND product_id=?').get(o.id, id)) {
        db.prepare('UPDATE options SET label=?,price=?,sort=?,active=? WHERE id=?').run(o.label, o.price, o.sort, o.active, o.id);
        keep.push(o.id);
      } else {
        keep.push(Number(db.prepare('INSERT INTO options(product_id,label,price,sort,active) VALUES(?,?,?,?,?)').run(id, o.label, o.price, o.sort, o.active).lastInsertRowid));
      }
    }
    db.prepare(`UPDATE options SET active=0 WHERE product_id=? AND id NOT IN (${keep.map(() => '?').join(',')})`).run(id, ...keep);
    audit(pid ? 'product_updated' : 'product_created', `#${id} ${p.title}`.slice(0, 120));
    return id;
  });
}

function addCodes(optionId, raw) {
  if (!db.prepare('SELECT 1 FROM options WHERE id=?').get(optionId)) throw new HttpError(404, 'الفئة غير موجودة');
  const lines = [...new Set(String(raw || '').split(/\r?\n/).map(x => x.trim()).filter(x => x.length >= 4 && x.length <= 200))];
  if (!lines.length) throw new HttpError(400, 'لم أجد أي كود صالح (٤ أحرف فأكثر في كل سطر)');
  if (lines.length > 5000) throw new HttpError(400, 'الحد الأقصى ٥٠٠٠ كود في المرة الواحدة');
  let added = 0;
  tx(() => {
    for (const c of lines) {
      const r = db.prepare('INSERT OR IGNORE INTO codes(option_id,code_enc,code_hash,created_at) VALUES(?,?,?,?)').run(optionId, U.encCode(c), U.hashCode(c), Date.now());
      added += r.changes;
    }
  });
  audit('codes_added', `فئة #${optionId}: أُضيف ${added}، مكرر ${lines.length - added}`);
  return { added, duplicates: lines.length - added };
}

function summary() {
  const paid = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM orders WHERE status='paid'").get();
  const today = db.prepare("SELECT COALESCE(SUM(total),0) s, COUNT(*) n FROM orders WHERE status='paid' AND paid_at>=?").get(Date.now() - 86400000);
  const count = st => db.prepare('SELECT COUNT(*) n FROM orders WHERE status=?').get(st).n;
  const low = db.prepare(`
    SELECT p.title, o.label, (SELECT COUNT(*) FROM codes c WHERE c.option_id=o.id AND c.status='available') AS avail
    FROM options o JOIN products p ON p.id=o.product_id WHERE o.active=1 AND p.active=1 ORDER BY avail ASC, p.id LIMIT 8`).all()
    .filter(x => x.avail <= 3);
  return { paidCount: paid.n, revenue: paid.s, dayRevenue: today.s, dayCount: today.n, pending: count('pending'), needsRefund: count('needs_refund'), low };
}

const totpEnabled = () => !!getSetting('totp_secret');

/* ================= HTTP ================= */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const CF = cfg.turnstileSite ? ' https://challenges.cloudflare.com' : '';
const CSP = `default-src 'self'; script-src 'self'${CF}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src ${CF || "'none'"}; frame-ancestors 'none'; form-action 'self'; base-uri 'self'`;

function secHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (cfg.baseUrl.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'نوع المحتوى غير مدعوم'));
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'الطلب كبير جدًا')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'JSON غير صالح')); } });
    req.on('error', reject);
  });
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
function clientIp(req) {
  if (cfg.trustCloudflare && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).trim().slice(0, 64);
  if (cfg.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim().slice(0, 64);
  return req.socket.remoteAddress || 'x';
}

function serveStatic(req, res, p) {
  const pages = { '/': 'index.html', '/admin': 'admin.html', '/policies': 'policies.html' };
  let file = pages[p] || (p.startsWith('/order/') ? 'order.html' : p.slice(1));
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC + path.sep) || path.basename(full).startsWith('.')) throw new HttpError(404, 'غير موجود');
  let st; try { st = fs.statSync(full); } catch { throw new HttpError(404, 'الصفحة غير موجودة'); }
  if (!st.isFile()) throw new HttpError(404, 'الصفحة غير موجودة');
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname, m = req.method, ip = clientIp(req);
  let g;

  if (!p.startsWith('/api/')) {
    if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'الطريقة غير مسموحة');
    return serveStatic(req, res, p);
  }

  /* ---- عام ---- */
  if (m === 'GET' && p === '/api/products') return send(res, 200, { products: listProducts(false), mode: cfg.payMode, turnstile: cfg.turnstileSite || null });
  if (m === 'POST' && p === '/api/checkout') return send(res, 200, await checkout(await readJson(req), ip));
  if (m === 'GET' && (g = p.match(/^\/api\/order\/([\w-]{20,})$/))) {
    if (U.limited('ov:' + ip, 90, 60 * 1000)) throw new HttpError(429, 'محاولات كثيرة');
    return send(res, 200, await orderView(g[1]));
  }
  if (m === 'POST' && (g = p.match(/^\/api\/pay\/callback\/([\w-]{20,})$/))) {
    if (U.limited('cb:' + ip, 120, 60 * 1000)) throw new HttpError(429, 'محاولات كثيرة');
    const o = db.prepare('SELECT * FROM orders WHERE token=?').get(g[1]);
    if (o) await syncPayment(o);          // لا نثق بمحتوى الطلب: نتحقق من الفاتورة مباشرة من Moyasar
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && (g = p.match(/^\/api\/demo-pay\/([\w-]{20,})$/))) {
    if (cfg.payMode !== 'demo') throw new HttpError(404, 'غير متاح');
    const o = db.prepare('SELECT * FROM orders WHERE token=?').get(g[1]);
    if (!o) throw new HttpError(404, 'الطلب غير موجود');
    await finalize(o.id);
    return send(res, 200, { ok: true });
  }

  /* ---- الإدارة ---- */
  if (m === 'GET' && p === '/api/admin/login-info') return send(res, 200, { totp: totpEnabled() });
  if (m === 'POST' && p === '/api/admin/login') {
    if (U.peek('login:' + ip, 5)) throw new HttpError(429, 'محاولات كثيرة، انتظر ١٥ دقيقة');
    const b = await readJson(req);
    const pwOk = U.safeEqual(b.password || '', cfg.adminPassword);
    let step = null, codeOk = true;
    if (totpEnabled()) {
      step = U.totpVerify(U.decCode(getSetting('totp_secret')), b.code, +getSetting('totp_last') || 0);
      codeOk = step !== null;
    }
    if (!pwOk || !codeOk) {
      U.hit('login:' + ip, 15 * 60 * 1000);
      audit('login_failed', '', ip);
      throw new HttpError(401, totpEnabled() ? 'كلمة المرور أو رمز التحقق غير صحيح' : 'كلمة المرور غير صحيحة');
    }
    if (step !== null) setSetting('totp_last', step);
    audit('login', '', ip);
    res.setHeader('Set-Cookie', `cw_admin=${U.makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${cfg.baseUrl.startsWith('https://') ? '; Secure' : ''}`);
    return send(res, 200, { ok: true });
  }
  if (p.startsWith('/api/admin/')) {
    if (!U.checkSession(cookies(req).cw_admin)) throw new HttpError(401, 'سجّل الدخول أولًا');
    if (m === 'POST' && p === '/api/admin/logout') {
      audit('logout', '', ip);
      res.setHeader('Set-Cookie', 'cw_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/me') {
      return send(res, 200, { ok: true, mode: cfg.payMode, mail: cfg.mailMode, totp: totpEnabled(), turnstile: !!cfg.turnstileSecret, https: cfg.baseUrl.startsWith('https://'), proxy: cfg.trustProxy || cfg.trustCloudflare });
    }
    if (m === 'GET' && p === '/api/admin/audit') {
      return send(res, 200, { log: db.prepare('SELECT ts,action,detail,ip_hash FROM audit ORDER BY id DESC LIMIT 200').all() });
    }
    if (m === 'POST' && p === '/api/admin/2fa/setup') {
      if (totpEnabled()) throw new HttpError(400, 'التحقق بخطوتين مفعّل بالفعل');
      const secret = U.newTotpSecret();
      setSetting('totp_pending', U.encCode(secret));
      return send(res, 200, { secret, uri: `otpauth://totp/Codeweb:admin?secret=${secret}&issuer=Codeweb&algorithm=SHA1&digits=6&period=30` });
    }
    if (m === 'POST' && p === '/api/admin/2fa/enable') {
      if (U.peek('tfa:' + ip, 8)) throw new HttpError(429, 'محاولات كثيرة، انتظر قليلًا');
      const pending = getSetting('totp_pending');
      if (!pending || totpEnabled()) throw new HttpError(400, 'ابدأ الإعداد أولًا');
      const b = await readJson(req);
      const step = U.totpVerify(U.decCode(pending), b.code, 0);
      if (step === null) { U.hit('tfa:' + ip, 10 * 60 * 1000); throw new HttpError(400, 'الرمز غير صحيح، تأكد من وقت جهازك وأعد المحاولة'); }
      setSetting('totp_secret', pending); setSetting('totp_last', step); delSetting('totp_pending');
      audit('2fa_enabled', '', ip);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/2fa/disable') {
      if (U.peek('tfa:' + ip, 8)) throw new HttpError(429, 'محاولات كثيرة، انتظر قليلًا');
      if (!totpEnabled()) throw new HttpError(400, 'التحقق بخطوتين غير مفعّل');
      const b = await readJson(req);
      const step = U.totpVerify(U.decCode(getSetting('totp_secret')), b.code, +getSetting('totp_last') || 0);
      if (step === null) { U.hit('tfa:' + ip, 10 * 60 * 1000); throw new HttpError(400, 'الرمز غير صحيح'); }
      delSetting('totp_secret'); delSetting('totp_last'); delSetting('totp_pending');
      audit('2fa_disabled', '', ip);
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/summary') return send(res, 200, summary());
    if (m === 'GET' && p === '/api/admin/products') return send(res, 200, { products: listProducts(true) });
    if (m === 'POST' && p === '/api/admin/products') return send(res, 200, { id: saveProduct(await readJson(req)) });
    if (m === 'POST' && p === '/api/admin/codes') {
      const b = await readJson(req, 1024 * 1024);
      return send(res, 200, addCodes(Number(b.option_id), b.codes));
    }
    if (m === 'GET' && p === '/api/admin/orders') {
      return send(res, 200, { orders: db.prepare('SELECT id,email,total,status,created_at,paid_at,mailed_at FROM orders ORDER BY id DESC LIMIT 100').all() });
    }
    if (m === 'POST' && (g = p.match(/^\/api\/admin\/orders\/(\d+)\/resend$/))) {
      const ok = await mailOrder(Number(g[1]));
      if (!ok) throw new HttpError(400, 'يمكن إعادة الإرسال للطلبات المدفوعة فقط');
      audit('order_resend', `طلب #${g[1]}`, ip);
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'غير موجود');
}

const server = http.createServer(async (req, res) => {
  secHeaders(res);
  try { await route(req, res); }
  catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error('[خطأ]', e);
    if (res.headersSent) return res.end();
    if ((req.url || '').startsWith('/api/')) return send(res, status, { error: e instanceof HttpError ? e.message : 'حدث خطأ غير متوقع' });
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(e instanceof HttpError ? e.message : 'حدث خطأ غير متوقع');
  }
});

if (require.main === module) {
  if (process.env.ADMIN_2FA_RESET === '1') {
    ['totp_secret', 'totp_last', 'totp_pending'].forEach(delSetting);
    audit('2fa_reset_cli', 'أُلغي التحقق بخطوتين عبر ADMIN_2FA_RESET');
    console.warn('[تنبيه] أُلغي التحقق بخطوتين (ADMIN_2FA_RESET=1). أزل هذا المتغير بعد الدخول وأعد تفعيله.');
  }
  if (cfg.seedDemo) seedDemo();
  reap();
  setInterval(() => { try { reap(); } catch (e) { console.error(e); } }, 60 * 1000).unref();
  server.listen(cfg.port, () => {
    console.log(`Codeweb يعمل على ${cfg.baseUrl}  (الدفع: ${cfg.payMode}، البريد: ${cfg.mailMode})`);
    console.log(`لوحة التحكم: ${cfg.baseUrl}/admin`);
  });
}
module.exports = { server };
