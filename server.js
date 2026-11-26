require('dotenv').config();
const express = require('express'), crypto = require('crypto'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), path = require('path');
const rateLimit = require('express-rate-limit'), { Pool } = require('pg'), provider = require('./provider');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
db.on('error', e => console.error('db idle connection error (safe to ignore):', e.message)); // Neon closes idle connections; this stops that from crashing the server
const app = express(), PS = process.env.PAYSTACK_SECRET_KEY, ORDER_MINUTES = 5;
app.set('trust proxy', 1); // Render sits behind a proxy
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }));
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });

// Credit a Paystack payment. Only a PENDING row can flip to success, so webhook + verify together credit exactly once.
async function credit(ref, amountKobo) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const t = await c.query(`UPDATE transactions SET status='success' WHERE reference=$1 AND status='pending' AND amount_kobo=$2 RETURNING user_id,amount_kobo`, [ref, amountKobo]);
    if (t.rowCount) await c.query('UPDATE users SET balance_kobo=balance_kobo+$1 WHERE id=$2', [t.rows[0].amount_kobo, t.rows[0].user_id]);
    await c.query('COMMIT'); return t.rowCount > 0;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
// ---- Paystack webhook (raw body needed for the signature check, so BEFORE express.json) ----
app.post('/webhooks/paystack', express.raw({ type: '*/*' }), wrap(async (req, res) => {
  const sig = crypto.createHmac('sha512', PS).update(req.body).digest('hex');
  if (sig !== req.headers['x-paystack-signature']) return res.sendStatus(401);
  const ev = JSON.parse(req.body);
  if (ev.event === 'charge.success') await credit(ev.data.reference, ev.data.amount);
  res.sendStatus(200);
}));

app.use(express.json());
app.use('/auth', rateLimit({ windowMs: 15 * 60e3, max: 30 }));
app.use(express.static(path.join(__dirname, 'public'))); // public/index.html is the website
// Admin has no link anywhere on the site. /admin shows its own login, and every /admin/* data route checks the admin role on the server.
app.get('/admin', (req, res) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
const siteUrl = () => (process.env.APP_URL || '').replace(/\/+$/, '');
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /auth/\nDisallow: /wallet/\nDisallow: /orders\nDisallow: /me\n\nSitemap: ${siteUrl()}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl()}/</loc></url></urlset>`));
const isAdminEmail = e => !!process.env.ADMIN_EMAIL && String(e).toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase();
// While TEST_MODE is on, real payments are blocked so nobody is charged real money for a generated number.
const testBlocked = () => provider.TEST && PS.startsWith('sk_test_');
if (provider.TEST) console.warn(testBlocked() ? 'TEST_MODE is on but PAYSTACK_SECRET_KEY is a LIVE key: top-ups and purchases are blocked. Use an sk_test_ key.' : 'TEST_MODE is on: purchases use generated numbers and codes.');

const auth = wrap2(async (req) => {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(tok, process.env.JWT_SECRET); } catch { throw bad('Please sign in', 401); }
  const u = await db.query('SELECT banned,role FROM users WHERE id=$1', [req.user.id]);
  if (!u.rowCount || u.rows[0].banned) throw bad('Account disabled', 403);
  req.user.role = u.rows[0].role; // always the current role from the database
});
function wrap2(fn) { return (req, res, next) => fn(req).then(() => next()).catch(e => res.status(e.status || 500).json({ error: e.message })); }
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });

// ---- Auth ----
app.post('/auth/register', wrap(async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8) throw bad('Valid email and 8+ character password required');
  try {
    const r = await db.query('INSERT INTO users(email,password_hash,full_name,role) VALUES($1,$2,$3,$4) RETURNING id,role', [email.toLowerCase(), await bcrypt.hash(password, 10), (fullName || '').trim().slice(0, 80), (process.env.ADMIN_EMAIL || '').toLowerCase() === email.toLowerCase() ? 'admin' : 'user']);
    res.json({ token: jwt.sign(r.rows[0], process.env.JWT_SECRET, { expiresIn: '7d' }) });
  } catch (e) { throw e.code === '23505' ? bad('Email already registered') : e; }
}));
app.post('/auth/login', wrap(async (req, res) => {
  const r = await db.query('SELECT * FROM users WHERE email=$1', [(req.body.email || '').toLowerCase()]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) throw bad('Wrong email or password', 401);
  if (isAdminEmail(u.email) && u.role !== 'admin') { await db.query(`UPDATE users SET role='admin' WHERE id=$1`, [u.id]); u.role = 'admin'; }
  res.json({ token: jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '7d' }) });
}));

// ---- Prices: ALL countries/services from the supplier, converted to naira ----
let cache = { at: 0, rows: [] };
async function setting(k) { return +(await db.query('SELECT value FROM settings WHERE key=$1', [k])).rows[0].value; }
async function prices() {
  if (Date.now() - cache.at > 5 * 60e3) cache = { at: Date.now(), rows: await provider.listPrices() };
  const m = await setting('margin_percent'), fx = await setting('usd_ngn');
  const ov = Object.fromEntries((await db.query('SELECT service,price_kobo FROM service_prices')).rows.map(r => [r.service, +r.price_kobo]));
  // fixed sell price per service wins; otherwise provider cost x rate x margin
  return cache.rows.filter(r => r.stock !== 0).map(r => ({ ...r, price_kobo: ov[r.service] ?? (r.priceNaira ? r.priceNaira * 100 : Math.ceil(r.costUsd * fx * (1 + m / 100)) * 100) }));
}
app.get('/prices', wrap(async (req, res) => {
  const { service, country } = req.query;
  res.json((await prices()).filter(p => (!service || p.service === service) && (!country || p.country === country)));
}));

// ---- Wallet ----
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/stats', wrap(async (req, res) => { // real public counters for the home page
  const u = await db.query(`SELECT count(*)::int n FROM users WHERE role='user'`), o = await db.query(`SELECT count(*)::int n FROM orders WHERE status='received' AND NOT is_test`); // test orders are never counted
  res.json({ users: u.rows[0].n, orders: o.rows[0].n });
}));
app.get('/me', auth, wrap(async (req, res) => {
  const u = (await db.query('SELECT email,full_name,balance_kobo FROM users WHERE id=$1', [req.user.id])).rows[0];
  const t = (await db.query(`SELECT coalesce(sum(CASE WHEN type='fund' AND status='success' THEN amount_kobo END),0) funded,
    coalesce(sum(CASE WHEN type='purchase' THEN amount_kobo WHEN type='refund' THEN -amount_kobo END),0) spent FROM transactions WHERE user_id=$1`, [req.user.id])).rows[0];
  res.json({ ...u, funded_kobo: t.funded, spent_kobo: t.spent });
}));
// Called when the user comes back from Paystack: confirms with Paystack directly in case the webhook is slow
app.get('/wallet/verify/:ref', auth, wrap(async (req, res) => {
  const own = await db.query(`SELECT 1 FROM transactions WHERE reference=$1 AND user_id=$2 AND type='fund'`, [req.params.ref, req.user.id]);
  if (!own.rowCount) throw bad('Unknown payment', 404);
  const j = await (await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(req.params.ref), { headers: { Authorization: 'Bearer ' + PS } })).json();
  const ok = !!(j.status && j.data && j.data.status === 'success');
  if (ok) await credit(req.params.ref, j.data.amount);
  res.json({ credited: ok });
}));
app.post('/wallet/fund', auth, wrap(async (req, res) => {
  if (testBlocked()) throw bad('Wallet top-ups are temporarily unavailable.', 503);
  const naira = Math.floor(+req.body.amount);
  if (!(naira >= 100 && naira <= 500000)) throw bad('Amount must be between ₦100 and ₦500,000');
  const u = (await db.query('SELECT email FROM users WHERE id=$1', [req.user.id])).rows[0];
  const ref = 'NB_' + crypto.randomBytes(10).toString('hex');
  await db.query(`INSERT INTO transactions(user_id,type,amount_kobo,reference,status) VALUES($1,'fund',$2,$3,'pending')`, [req.user.id, naira * 100, ref]);
  const r = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST', headers: { Authorization: 'Bearer ' + PS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: u.email, amount: naira * 100, reference: ref, callback_url: process.env.APP_URL + '/?paid=1' }) });
  const j = await r.json();
  if (!j.status) throw bad('Could not start payment');
  res.json({ url: j.data.authorization_url }); // redirect the browser here
}));

// ---- Orders ----
async function move(userId, delta, type, ref, c = db) { // ledger + balance, safe to retry via unique ref
  const t = await c.query(`INSERT INTO transactions(user_id,type,amount_kobo,reference) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [userId, type, Math.abs(delta), ref]);
  if (t.rowCount) await c.query('UPDATE users SET balance_kobo=balance_kobo+$1 WHERE id=$2', [delta, userId]);
  return t.rowCount > 0;
}
async function refund(order) {
  const r = await db.query(`UPDATE orders SET status=$2 WHERE id=$1 AND status IN('waiting','pending') RETURNING *`, [order.id, order.newStatus]);
  if (r.rowCount) await move(order.user_id, order.price_kobo, 'refund', 'RF_' + order.id);
  return r.rowCount > 0;
}
app.post('/orders', auth, wrap(async (req, res) => {
  if (testBlocked()) throw bad('Purchases are temporarily unavailable.', 503);
  const { service, country } = req.body;
  const p = (await prices()).find(x => x.service === service && x.country === country);
  if (!p) throw bad('Not available right now');
  const price = p.price_kobo, c = await db.connect(); let order;
  try { // 1) take money and create the order in one atomic step. Price comes from the server, never the browser.
    await c.query('BEGIN');
    const d = await c.query('UPDATE users SET balance_kobo=balance_kobo-$1 WHERE id=$2 AND balance_kobo>=$1 RETURNING id', [price, req.user.id]);
    if (!d.rowCount) throw bad('Insufficient balance. Fund your wallet first.');
    order = (await c.query(`INSERT INTO orders(user_id,service,country,price_kobo) VALUES($1,$2,$3,$4) RETURNING *`, [req.user.id, service, country, price])).rows[0];
    await c.query(`INSERT INTO transactions(user_id,type,amount_kobo,reference) VALUES($1,'purchase',$2,$3)`, [req.user.id, price, 'PU_' + order.id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  try { // 2) buy from supplier. If that fails, refund straight away.
    const b = await provider.buy(service, country);
    waitingHint = true;
    await db.query(`UPDATE orders SET number=$1,provider_order_id=$2,status='waiting',is_test=$4,expires_at=now()+interval '${ORDER_MINUTES} minutes' WHERE id=$3`, [b.number, b.providerOrderId, order.id, !!b.test]);
    res.json({ id: order.id, number: b.number, expires_in: ORDER_MINUTES * 60 });
  } catch (e) { await refund({ ...order, newStatus: 'failed' }); throw bad('No number available right now. You were not charged.', 502); }
}));
app.get('/orders', auth, wrap(async (req, res) => {
  res.json((await db.query('SELECT id,service,country,number,status,sms_code,price_kobo,expires_at,created_at FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id])).rows);
}));
app.post('/orders/:id/cancel', auth, wrap(async (req, res) => {
  const o = (await db.query(`SELECT * FROM orders WHERE id=$1 AND user_id=$2 AND status='waiting'`, [req.params.id, req.user.id])).rows[0];
  if (!o) throw bad('Order cannot be cancelled');
  await provider.cancel(o.provider_order_id).catch(() => {});
  await refund({ ...o, newStatus: 'cancelled' });
  res.json({ ok: true });
}));

// ---- Admin ----
app.get('/admin/stats', auth, admin, wrap(async (req, res) => {
  const one = async q => (await db.query(q)).rows[0];
  const u = await one(`SELECT count(*) FILTER (WHERE role='user')::int customers, count(*) FILTER (WHERE banned)::int banned, coalesce(sum(balance_kobo),0)::text wallet_liability_kobo FROM users`);
  const o = await one(`SELECT count(*) FILTER (WHERE status='received' AND NOT is_test)::int sold, count(*) FILTER (WHERE status='waiting')::int waiting, count(*) FILTER (WHERE is_test)::int test_orders, coalesce(sum(price_kobo) FILTER (WHERE status='received' AND NOT is_test),0)::text revenue_kobo FROM orders`);
  const f = await one(`SELECT coalesce(sum(amount_kobo),0)::text funded_kobo FROM transactions WHERE type='fund' AND status='success'`);
  res.json({ ...u, ...o, ...f, test_mode: provider.TEST });
}));
app.get('/admin/users', auth, admin, wrap(async (req, res) => {
  res.json((await db.query('SELECT id,email,full_name,role,banned,balance_kobo::text,created_at FROM users ORDER BY id DESC LIMIT 200')).rows);
}));
app.get('/admin/orders', auth, admin, wrap(async (req, res) => {
  res.json((await db.query('SELECT o.id,u.email,o.service,o.country,o.number,o.status,o.price_kobo::text,o.is_test,o.created_at FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 100')).rows);
}));
app.get('/admin/prices', auth, admin, wrap(async (req, res) => {
  res.json((await db.query('SELECT service,price_kobo::text FROM service_prices ORDER BY service')).rows);
}));
app.post('/admin/settings', auth, admin, wrap(async (req, res) => {
  for (const k of ['margin_percent', 'usd_ngn']) if (req.body[k] > 0) await db.query('UPDATE settings SET value=$2 WHERE key=$1', [k, String(req.body[k])]);
  res.json({ ok: true });
}));
app.post('/admin/prices', auth, admin, wrap(async (req, res) => {
  const n = Math.floor(+req.body.naira);
  if (!req.body.service || !(n >= 100)) throw bad('Service and a price of at least ₦100 required');
  await db.query('INSERT INTO service_prices(service,price_kobo) VALUES($1,$2) ON CONFLICT(service) DO UPDATE SET price_kobo=$2', [req.body.service, n * 100]);
  res.json({ ok: true });
}));
app.post('/admin/ban/:id', auth, admin, wrap(async (req, res) => { await db.query(`UPDATE users SET banned=true WHERE id=$1 AND role<>'admin'`, [req.params.id]); res.json({ ok: true }); }));
app.post('/admin/unban/:id', auth, admin, wrap(async (req, res) => { await db.query('UPDATE users SET banned=false WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---- Worker: collect SMS codes, expire and refund (runs every 5 seconds) ----
let waitingHint = true, lastPoll = 0; // only hit the database every 5s while an order is waiting, otherwise once a minute
setInterval(async () => {
  try {
    if (!waitingHint && Date.now() - lastPoll < 60000) return;
    lastPoll = Date.now();
    const waiting = (await db.query(`SELECT * FROM orders WHERE status='waiting'`)).rows;
    waitingHint = waiting.length > 0;
    for (const o of waiting) {
      const code = await provider.getSms(o.provider_order_id).catch(() => null);
      if (code) { await db.query(`UPDATE orders SET status='received',sms_code=$1 WHERE id=$2 AND status='waiting'`, [code, o.id]); continue; }
      if (new Date(o.expires_at) < new Date()) { await provider.cancel(o.provider_order_id).catch(() => {}); await refund({ ...o, newStatus: 'expired' }); }
    }
  } catch (e) { console.error('worker', e.message); }
}, 5000);

app.listen(process.env.PORT || 3000, () => console.log('Numba API running'));
