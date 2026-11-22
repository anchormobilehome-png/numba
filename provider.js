// Adapter for your number supplier. Only this file changes when you pick or switch suppliers.
// Every function must return the shapes shown. Fill in the TODOs from your supplier's API docs.
const KEY = process.env.PROVIDER_API_KEY;

// -> [{ service:'whatsapp', country:'ng', countryName:'Nigeria', costUsd:0.25, stock:120 }, ...]
// Called on a timer and cached, so every country and service the supplier has shows on your site.
async function listPrices() { /* TODO: GET supplier prices endpoint, map to the shape above */ return []; }

// -> { providerOrderId:'123', number:'+447700900123' }  (throw an Error if no stock)
async function buy(service, country) { /* TODO */ throw new Error('provider.buy not implemented'); }

// -> '4831' or null while still waiting
async function getSms(providerOrderId) { /* TODO */ return null; }

// Ask the supplier to cancel (so you get your money back from them too)
async function cancel(providerOrderId) { /* TODO */ }

module.exports = { listPrices, buy, getSms, cancel };
