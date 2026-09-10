import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function init() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  console.log('[db:init] applying schema...');
  await pool.query(schema);
  console.log('[db:init] schema applied successfully');
  await pool.end();
}

init().catch((err) => {
  console.error('[db:init] FAILED:', err);
  process.exit(1);
});