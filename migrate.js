require('dotenv').config();
const fs = require('fs'), { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
db.query(fs.readFileSync(__dirname + '/schema.sql', 'utf8')).then(() => { console.log('Database ready'); return db.end(); })
  .catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
