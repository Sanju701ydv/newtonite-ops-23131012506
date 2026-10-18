const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
const migrate = () => pool.query(fs.readFileSync(__dirname + '/schema.sql', 'utf8'));
module.exports = { pool, tx, migrate };
