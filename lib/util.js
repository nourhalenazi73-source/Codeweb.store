'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- .env (بدون اعتماديات) ---------- */
function loadEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(path.join(__dirname, '..', '.env'));
const env = process.env;

const cfg = {
  port: +env.PORT || 3000,
  production: env.NODE_ENV === 'production',
  trustProxy: env.TRUST_PROXY === '1',
  trustCloudflare: env.TRUST_CLOUDFLARE === '1',
  turnstileSite: env.TURNSTILE_SITE_KEY || '',
  turnstileSecret: env.TURNSTILE_SECRET_KEY || '',
  maxPendingIp: +env.MAX_PENDING_IP || 5,
  maxPendingEmail: +env.MAX_PENDING_EMAIL || 3,
  adminPassword: env.ADMIN_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || '',
  codesSecret: env.CODES_SECRET || '',
  payMode: env.PAYMENT_MODE || 'demo',
  moyasarKey: env.MOYASAR_SECRET_KEY || '',
  mailMode: env.MAIL_MODE || 'console',
  resendKey: env.RESEND_API_KEY || '',
  mailFrom: env.MAIL_FROM || 'Codeweb <orders@example.com>',
  seedDemo: env.SEED_DEMO === '1',
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'store.db'),
};
cfg.baseUrl = (env.BASE_URL || `http://localhost:${cfg.port}`).replace(/\/+$/, '');

/* فحوص الأمان عند التشغيل */
const problems = [];
if (cfg.production) {
  if (cfg.adminPassword.length < 10) problems.push('ADMIN_PASSWORD يجب ألا يقل عن 10 أحرف');
  if (cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET يجب ألا يقل عن 32 حرفًا');
  if (cfg.codesSecret.length < 16) problems.push('CODES_SECRET يجب ألا يقل عن 16 حرفًا');
  if (cfg.payMode === 'demo') problems.push('PAYMENT_MODE=demo غير مسموح في الإنتاج (يسلّم الأكواد بلا دفع)');
  if (!cfg.baseUrl.startsWith('https://')) problems.push('BASE_URL يجب أن يبدأ بـ https:// في الإنتاج');
  if (cfg.seedDemo) problems.push('SEED_DEMO=1 غير مسموح في الإنتاج');
}
if (cfg.payMode === 'moyasar' && !cfg.moyasarKey) problems.push('MOYASAR_SECRET_KEY مطلوب عند PAYMENT_MODE=moyasar');
if (!!cfg.turnstileSite !== !!cfg.turnstileSecret) problems.push('TURNSTILE_SITE_KEY و TURNSTILE_SECRET_KEY يجب ضبطهما معًا أو تركهما فارغين');
if (cfg.mailMode === 'resend' && !cfg.resendKey) problems.push('RESEND_API_KEY مطلوب عند MAIL_MODE=resend');
if (problems.length) {
  console.error('\nإعدادات غير صالحة:\n- ' + problems.join('\n- ') + '\n');
  process.exit(1);
}
if (!cfg.production) {
  if (!cfg.adminPassword) { cfg.adminPassword = 'admin12345'; console.warn('[تنبيه] كلمة مرور الإدارة الافتراضية: admin12345 (للتجربة فقط)'); }
  if (!cfg.sessionSecret) cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  if (!cfg.codesSecret) { cfg.codesSecret = 'dev-only-codes-secret'; console.warn('[تنبيه] CODES_SECRET افتراضي للتجربة فقط'); }
}

/* ---------- تشفير الأكواد (AES-256-GCM) ---------- */
const key = crypto.scryptSync(cfg.codesSecret, 'codeweb-codes-v1', 32);
function encCode(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decCode(s) {
  const [iv, tag, enc] = s.split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
const hashCode = c => crypto.createHmac('sha256', key).update(c).digest('hex');

/* ---------- جلسة الإدارة ---------- */
const SESSION_MS = 12 * 3600 * 1000;
const sign = v => crypto.createHmac('sha256', cfg.sessionSecret).update(v).digest('base64url');
function makeSession() { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(exp); }
function checkSession(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || !(+exp > Date.now())) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------- تحديد المعدل (في الذاكرة) ---------- */
const buckets = new Map();
function limited(id, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(id);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(id, b); }
  b.n++;
  return b.n > max;
}
/* عدّاد للمحاولات الفاشلة فقط: peek يفحص دون عدّ، وhit يسجّل فشلًا */
const peek = (id, max) => { const b = buckets.get(id); return !!b && b.reset > Date.now() && b.n >= max; };
const hit = (id, windowMs) => {
  const now = Date.now(); let b = buckets.get(id);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(id, b); }
  b.n++;
};
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k); }, 60000).unref();

/* ---------- التحقق بخطوتين (TOTP حسب RFC 6238، متوافق مع Google/Microsoft Authenticator وAuthy) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newTotpSecret = () => b32enc(crypto.randomBytes(20));
function totpCode(secretB32, step) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secretB32)).update(b).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
/* يرجع رقم الفترة المقبولة أو null. lastStep يمنع إعادة استخدام الرمز نفسه. */
function totpVerify(secretB32, code, lastStep) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const step = now + d;
    if (step > lastStep && safeEqual(totpCode(secretB32, step), c)) return step;
  }
  return null;
}

/* ---------- Cloudflare Turnstile (تحقق ضد البوتات من جهة الخادم) ---------- */
async function verifyTurnstile(token, ip) {
  const body = new URLSearchParams({ secret: cfg.turnstileSecret, response: String(token || '').slice(0, 2048) });
  if (ip && ip !== 'x') body.set('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  return !!j.success;
}

/* ---------- أدوات ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sar = h => (h / 100).toLocaleString('ar-EG', { minimumFractionDigits: h % 100 ? 2 : 0 }) + ' ر.س';

/* ---------- البريد ---------- */
async function sendMail({ to, subject, html, text }) {
  if (cfg.mailMode === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.mailFrom, to: [to], subject, html, text }),
    });
    if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return;
  }
  console.log(`[بريد تجريبي] إلى ${to}: ${subject}\n${text}\n`);
}

/* ---------- الدفع (Moyasar عبر الفواتير) ---------- */
const MOYASAR = process.env.MOYASAR_API || 'https://api.moyasar.com/v1'; // للاختبار فقط
const authHeader = () => 'Basic ' + Buffer.from(cfg.moyasarKey + ':').toString('base64');
async function createInvoice({ amount, description, successUrl, callbackUrl, expiresAt, metadata }) {
  const r = await fetch(MOYASAR + '/invoices', {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount, currency: 'SAR', description,
      success_url: successUrl, callback_url: callbackUrl,
      expired_at: new Date(expiresAt).toISOString(), metadata,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id || !j.url) throw new Error('Moyasar create ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return { id: j.id, url: j.url };
}
async function fetchInvoice(id) {
  const r = await fetch(MOYASAR + '/invoices/' + encodeURIComponent(id), { headers: { Authorization: authHeader() } });
  if (!r.ok) throw new Error('Moyasar fetch ' + r.status);
  return r.json();
}

const resetLimits = () => buckets.clear();   // للاختبارات فقط

module.exports = { resetLimits, cfg, encCode, decCode, hashCode, makeSession, checkSession, safeEqual, limited, peek, hit, newTotpSecret, totpCode, totpVerify, verifyTurnstile, HttpError, esc, sar, sendMail, createInvoice, fetchInvoice };
