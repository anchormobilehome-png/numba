// Number supplier adapter. Only this file changes when you pick or switch suppliers.
//
// TEST_MODE=true  -> built-in test supplier: generated numbers, and a generated 6-digit code that arrives 30 seconds later.
// TEST_MODE=false -> your real supplier (fill in the 4 functions at the bottom).
const crypto = require('crypto');
const T = require('./testcatalog');
const TEST = process.env.TEST_MODE === 'true';
const CODE_DELAY_MS = 30000;

// ---------- built-in test supplier ----------
// Same price rule as the website: fixed prices for the main services, a stable price under 3,000 for the rest.
function testPrice(name) {
  if (T.fixed[name]) return T.fixed[name];
  let x = 0; for (const c of name) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return 1000 + (x % 40) * 50;
}
function testNumber(code) { // same formatting rules as the website's generated numbers
  const p = T.countries[code] || { cc: '', len: 10, groups: [3, 3, 4] };
  let d = ''; for (let i = 0; i < p.len; i++) d += crypto.randomInt(0, 10);
  const parts = []; let at = 0;
  p.groups.forEach(n => { if (at < p.len) { parts.push(d.slice(at, at + n)); at += n; } });
  if (at < p.len) parts.push(d.slice(at));
  if (p.style === 'us' || p.style === 'paren') return '+' + p.cc + ' (' + parts[0] + ') ' + parts.slice(1).join('-');
  return '+' + p.cc + ' ' + parts.join(' ');
}
const testApi = {
  async listPrices() {
    const rows = [];
    for (const service of T.services) for (const [country, c] of Object.entries(T.countries))
      rows.push({ service, country, countryName: c.name, priceNaira: testPrice(service), stock: 9000 });
    return rows;
  },
  async buy(service, country) {
    if (!T.services.includes(service) || !T.countries[country]) throw new Error('Not available');
    const readyAt = Date.now() + CODE_DELAY_MS; // the order id carries the time the code becomes ready, so nothing is lost on restart
    return { providerOrderId: 'T' + readyAt + 'x' + crypto.randomBytes(3).toString('hex'), number: testNumber(country), test: true };
  },
  async getSms(id) {
    const m = /^T(\d+)x/.exec(id || '');
    if (!m || Date.now() < +m[1]) return null;
    return String(100000 + (crypto.createHash('sha256').update(id).digest().readUInt32BE(0) % 900000)); // 6 digits
  },
  async cancel() {},
};

// ---------- real supplier (fill in from your supplier's API docs) ----------
// -> [{ service:'whatsapp', country:'ng', countryName:'Nigeria', costUsd:0.25, stock:120 }, ...]
async function listPrices() { return []; }
// -> { providerOrderId:'123', number:'+447700900123' }  (throw an Error if no stock)
async function buy(service, country) { throw new Error('Supplier not connected'); }
// -> '4831' or null while still waiting
async function getSms(providerOrderId) { return null; }
// Ask the supplier to cancel so you also get your money back from them
async function cancel(providerOrderId) {}

module.exports = TEST ? { TEST: true, ...testApi } : { TEST: false, listPrices, buy, getSms, cancel };
