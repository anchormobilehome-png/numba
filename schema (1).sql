CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,full_name TEXT,password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user',banned BOOLEAN NOT NULL DEFAULT false,
 balance_kobo BIGINT NOT NULL DEFAULT 0 CHECK(balance_kobo>=0),created_at TIMESTAMPTZ DEFAULT now());
-- ledger: every balance change has a row. reference is unique so nothing is credited or refunded twice
CREATE TABLE IF NOT EXISTS transactions(id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id),
 type TEXT NOT NULL CHECK(type IN('fund','purchase','refund')),amount_kobo BIGINT NOT NULL,
 reference TEXT UNIQUE NOT NULL,status TEXT NOT NULL DEFAULT 'success',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS orders(id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id),service TEXT NOT NULL,country TEXT NOT NULL,
 number TEXT,provider_order_id TEXT,status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN('pending','waiting','received','cancelled','expired','failed')),
 sms_code TEXT,price_kobo BIGINT NOT NULL,expires_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
-- fixed sell price per service (same in every country). Services without a row use cost x rate x margin.
CREATE TABLE IF NOT EXISTS service_prices(service TEXT PRIMARY KEY,price_kobo BIGINT NOT NULL CHECK(price_kobo>0));
INSERT INTO service_prices VALUES('whatsapp',210000),('telegram',270000),('facebook',230000),('instagram',190000),('tiktok',250000) ON CONFLICT DO NOTHING;
INSERT INTO settings VALUES('margin_percent','30'),('usd_ngn','1600') ON CONFLICT DO NOTHING;
-- admin: set ADMIN_EMAIL in the environment, then register with that email
-- marks orders made by the built-in test supplier so they never count as real sales
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
