'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { cfg, encCode, hashCode } = require('./util');

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const db = new DatabaseSync(cfg.dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  cat TEXT NOT NULL,
  label TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  descr TEXT NOT NULL DEFAULT '',
  c1 TEXT NOT NULL DEFAULT '#3B30F5',
  c2 TEXT NOT NULL DEFAULT '#9B5CFF',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS options(
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  price INTEGER NOT NULL,            -- بالهللة (١٠٠ هللة = ١ ريال)
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS codes(
  id INTEGER PRIMARY KEY,
  option_id INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  code_enc TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'available',   -- available | reserved | sold
  order_id INTEGER,
  reserved_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_codes_opt ON codes(option_id, status);
CREATE INDEX IF NOT EXISTS idx_codes_order ON codes(order_id);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | paid | expired | failed | needs_refund
  provider_ref TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  mailed_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip_hash TEXT
);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  option_id INTEGER NOT NULL REFERENCES options(id),
  qty INTEGER NOT NULL,
  unit INTEGER NOT NULL
);
`);

/* ترقية قواعد بيانات أقدم: بصمة عنوان الشراء (مشفّرة، لحدّ الطلبات المعلّقة) */
if (!db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === 'ip_hash')) db.exec('ALTER TABLE orders ADD COLUMN ip_hash TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at)');

const hashIp = ip => hashCode('ip:' + ip);
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const delSetting = k => db.prepare('DELETE FROM settings WHERE key=?').run(k);

/* سجل نشاط الإدارة. لا تُسجَّل فيه كلمات المرور ولا قيم الأكواد أبدًا. */
function audit(action, detail = '', ip = '') {
  db.prepare('INSERT INTO audit(ts,action,detail,ip_hash) VALUES(?,?,?,?)').run(Date.now(), action, String(detail).slice(0, 200), ip ? hashIp(ip).slice(0, 10) : null);
  db.prepare('DELETE FROM audit WHERE id < (SELECT MAX(id) - 5000 FROM audit)').run();
}

/* معاملة ذرّية: تمنع بيع الكود نفسه مرتين */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* تجاهل */ } throw e; }
}

/* ---------- بيانات تجريبية (عند أول تشغيل فقط) ---------- */
function seedDemo() {
  if (db.prepare('SELECT COUNT(*) n FROM products').get().n > 0) return;
  const D = [
    ['بطاقة PlayStation Store', 'cards', 'PSN', 'السعودية', 'رصيد لمتجر PlayStation تشتري به الألعاب والإضافات. تأكد أن منطقة حسابك تطابق منطقة البطاقة.', '#0A3FBF', '#35B4FF', [['١٠ دولار', 40], ['٢٠ دولار', 78], ['٥٠ دولار', 190]]],
    ['بطاقة Xbox', 'cards', 'XBOX', 'السعودية', 'رصيد لمتجر Xbox على الجهاز والحاسب. تأكد أن منطقة حسابك تطابق منطقة البطاقة.', '#0B5D2A', '#46D17A', [['١٠ دولار', 40], ['٢٥ دولارًا', 96], ['٥٠ دولارًا', 190]]],
    ['رصيد Steam', 'cards', 'STEAM', 'عالمي', 'رصيد يُضاف إلى محفظة Steam لشراء الألعاب على الحاسب.', '#101B3A', '#4D7CFF', [['٥ دولارات', 21], ['١٠ دولارات', 40], ['٢٠ دولارًا', 78]]],
    ['شحن ببجي موبايل', 'topup', 'UC', 'عالمي', 'شدّات UC لشراء الشخصيات والأزياء داخل اللعبة. تحتاج رقم اللاعب (ID) عند التفعيل.', '#8A5A00', '#FFC83D', [['٦٠ UC', 9], ['٣٢٥ UC', 45], ['٦٦٠ UC', 89]]],
    ['فورتنايت V-Bucks', 'topup', 'V-BUCKS', 'عالمي', 'عملة فورتنايت لشراء الأزياء ومسار المعركة.', '#1D3FD1', '#8CE0FF', [['١٠٠٠ V-Bucks', 36], ['٢٨٠٠ V-Bucks', 95]]],
    ['اشتراك نتفليكس', 'subs', 'NETFLIX', 'حسب بلد الحساب', 'اشتراك مشاهدة للأفلام والمسلسلات. يُفعَّل بالكود على حسابك.', '#5A0A12', '#FF3B4D', [['شهر واحد', 39], ['٣ أشهر', 112]]],
    ['اشتراك سبوتيفاي', 'subs', 'SPOTIFY', 'حسب بلد الحساب', 'اشتراك Premium للاستماع بلا إعلانات وبتحميل الأغاني.', '#0B4A2A', '#3DDC84', [['شهر واحد', 22], ['٣ أشهر', 62], ['سنة', 230]]],
    ['اشتراك PlayStation Plus', 'subs', 'PS PLUS', 'السعودية', 'اللعب عبر الإنترنت وألعاب شهرية مجانية طوال مدة الاشتراك.', '#0A3FBF', '#FFC83D', [['شهر واحد', 40], ['٣ أشهر', 110], ['١٢ شهرًا', 360]]],
  ];
  tx(() => {
    const now = Date.now();
    for (const [title, cat, label, region, descr, c1, c2, opts] of D) {
      const pid = db.prepare('INSERT INTO products(title,cat,label,region,descr,c1,c2,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(title, cat, label, region, descr, c1, c2, now).lastInsertRowid;
      opts.forEach(([ol, price], i) => {
        const oid = db.prepare('INSERT INTO options(product_id,label,price,sort) VALUES(?,?,?,?)').run(pid, ol, price * 100, i).lastInsertRowid;
        for (let k = 0; k < 6; k++) {
          const code = 'DEMO-' + crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g).join('-');
          db.prepare('INSERT INTO codes(option_id,code_enc,code_hash,created_at) VALUES(?,?,?,?)').run(oid, encCode(code), hashCode(code), now);
        }
      });
    }
  });
  console.log('[بيانات تجريبية] أُضيفت منتجات وأكواد تجريبية (DEMO-...). احذفها قبل الإنتاج.');
}

module.exports = { db, tx, seedDemo, hashIp, getSetting, setSetting, delSetting, audit };
