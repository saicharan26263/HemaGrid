import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../auth/jwt.js';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Demo facilities to guarantee immediate accessibility for UI demo buttons
const DEMO_FACILITIES = [
  { name: 'St. Mary\'s Medical Center', type: 'HOSPITAL' as const, state: 'NY', city: 'New York', address: '1 East 1st St', lat: 40.7128, lng: -74.0060, phone: '+12125550101', email: 'stmarys@bloodbanc.demo', verified: true },
  { name: 'NYC Presbyterian Blood Bank', type: 'BLOOD_CENTER' as const, state: 'NY', city: 'New York', address: '2 Riverside Dr', lat: 40.7306, lng: -73.9352, phone: '+12125550102', email: 'nycpbb@bloodbanc.demo', verified: true },
  { name: 'Brooklyn General Hospital', type: 'HOSPITAL' as const, state: 'NY', city: 'Brooklyn', address: '10 Flatbush Ave', lat: 40.6501, lng: -73.9496, phone: '+17185550103', email: 'brooklyn@bloodbanc.demo', verified: true },
  { name: 'Massachusetts General', type: 'HOSPITAL' as const, state: 'MA', city: 'Boston', address: '55 Fruit St', lat: 42.3601, lng: -71.0589, phone: '+16175550104', email: 'mgh@bloodbanc.demo', verified: true },
  { name: 'Cedars-Sinai Medical Center', type: 'HOSPITAL' as const, state: 'CA', city: 'Los Angeles', address: '8700 Beverly Blvd', lat: 34.0754, lng: -118.3795, phone: '+13105550105', email: 'cedars@bloodbanc.demo', verified: true },
  { name: 'UCSF Blood Center', type: 'BLOOD_CENTER' as const, state: 'CA', city: 'San Francisco', address: '505 Parnassus Ave', lat: 37.7633, lng: -122.4579, phone: '+14155550106', email: 'ucsfbc@bloodbanc.demo', verified: true },
  { name: 'Northwestern Memorial', type: 'HOSPITAL' as const, state: 'IL', city: 'Chicago', address: '251 E Huron St', lat: 41.8947, lng: -87.6226, phone: '+13125550107', email: 'northwestern@bloodbanc.demo', verified: true },
  { name: 'Houston Methodist', type: 'HOSPITAL' as const, state: 'TX', city: 'Houston', address: '6565 Fannin St', lat: 29.7102, lng: -95.3992, phone: '+17135550108', email: 'methodist@bloodbanc.demo', verified: true },
  { name: 'Emory University Hospital', type: 'HOSPITAL' as const, state: 'GA', city: 'Atlanta', address: '1364 Clifton Rd', lat: 33.7946, lng: -84.3240, phone: '+14045550109', email: 'emory@bloodbanc.demo', verified: true },
  { name: 'UW Medicine Bloodworks', type: 'BLOOD_CENTER' as const, state: 'WA', city: 'Seattle', address: '921 Terry Ave', lat: 47.6169, lng: -122.3321, phone: '+12065550110', email: 'uwbloodworks@bloodbanc.demo', verified: true },
];

const BLOOD_TYPES = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'] as const;
type BloodGroup = typeof BLOOD_TYPES[number];

function titleCase(str: string): string {
  if (!str) return '';
  const acronyms = new Set(['II', 'III', 'IV', 'V', 'VI', 'VII', 'VA', 'ER', 'ICU', 'USA', 'LLC', 'LP', 'MD', 'PA', 'INC', 'NY', 'CA', 'TX', 'FL', 'OH']);
  return str
    .split(/\s+/)
    .map((word) => {
      const clean = word.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      if (acronyms.has(clean)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 35);
}

function parseCsvLine(text: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  result.push(cur.trim());
  return result;
}

// Pseudo-random generator for consistent deterministic stock per hospital
function seedRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

interface HospitalRecord {
  name: string;
  type: 'HOSPITAL' | 'BLOOD_CENTER';
  state: string;
  city: string;
  address: string;
  phone: string;
  email: string;
  verified: boolean;
  lat: number;
  lng: number;
}

async function loadHospitalsFromCsv(): Promise<HospitalRecord[]> {
  const csvPath = path.join(__dirname, 'us_hospitals.csv');
  if (!fs.existsSync(csvPath)) {
    console.warn(`[seed] ${csvPath} not found, using demo facilities only`);
    return DEMO_FACILITIES;
  }

  const fileStream = fs.createReadStream(csvPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const facilities: HospitalRecord[] = [...DEMO_FACILITIES];
  const seenEmails = new Set<string>(DEMO_FACILITIES.map((f) => f.email.toLowerCase()));
  const demoNames = new Set<string>(DEMO_FACILITIES.map((f) => f.name.toLowerCase()));

  let isHeader = true;
  for await (const rawLine of rl) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    if (isHeader) {
      isHeader = false;
      continue;
    }

    const parts = parseCsvLine(line);
    if (parts.length < 20) continue;

    // Index mappings from HIFLD CSV:
    // 4: NAME, 5: ADDRESS, 6: CITY, 7: STATE, 10: TELEPHONE, 11: TYPE, 12: STATUS, 17: LATITUDE, 18: LONGITUDE
    const status = (parts[12] || '').trim().toUpperCase();
    if (status !== 'OPEN') continue;

    const rawName = (parts[4] || '').trim();
    const state = (parts[7] || '').trim().toUpperCase();
    const rawCity = (parts[6] || '').trim();
    const rawAddress = (parts[5] || '').trim();
    const rawPhone = (parts[10] || '').trim();
    const rawType = (parts[11] || '').trim().toUpperCase();
    const latStr = parts[17] || '';
    const lngStr = parts[18] || '';

    const lat = Number.parseFloat(latStr);
    const lng = Number.parseFloat(lngStr);

    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
    // Valid US geographic bounds (including Alaska, Hawaii, and territories)
    if (lat < 13.0 || lat > 72.0 || lng < -180.0 || lng > -60.0) continue;

    const name = titleCase(rawName);
    if (demoNames.has(name.toLowerCase())) continue; // already in demo

    const city = titleCase(rawCity);
    const address = titleCase(rawAddress) || `${city}, ${state}`;
    const phone = rawPhone && rawPhone !== 'NOT AVAILABLE' ? rawPhone : '+18005550199';
    const type: 'HOSPITAL' | 'BLOOD_CENTER' = rawType.includes('BLOOD') ? 'BLOOD_CENTER' : 'HOSPITAL';

    const baseSlug = slugify(name);
    let email = `${baseSlug}.${state.toLowerCase()}@bloodbanc.demo`;
    let counter = 1;
    while (seenEmails.has(email)) {
      email = `${baseSlug}.${counter}.${state.toLowerCase()}@bloodbanc.demo`;
      counter++;
    }
    seenEmails.add(email);

    facilities.push({
      name,
      type,
      state,
      city,
      address,
      phone,
      email,
      verified: true,
      lat,
      lng,
    });
  }

  return facilities;
}

async function seed() {
  console.log('[seed] Starting Nationwide US Hospital & Blood Vault Seeding...');
  const startTime = Date.now();

  const facilities = await loadHospitalsFromCsv();
  console.log(`[seed] Loaded ${facilities.length} active US hospitals across 50+ states/territories.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('[seed] Clearing existing transaction records...');
    await client.query('DELETE FROM escalation_events');
    await client.query('DELETE FROM matches');
    await client.query('DELETE FROM requests');
    await client.query('DELETE FROM inventory');
    await client.query('DELETE FROM audit_log');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM facilities');

    // Precompute password hash for default password 'password123'
    console.log('[seed] Hashing default password "password123"...');
    const defaultPwHash = hashPassword('password123');

    // 1. Insert facilities in batches
    console.log(`[seed] Inserting ${facilities.length} facilities...`);
    const BATCH_SIZE = 400;
    const facilityIdMap = new Map<string, string>(); // email -> id

    for (let i = 0; i < facilities.length; i += BATCH_SIZE) {
      const batch = facilities.slice(i, i + BATCH_SIZE);
      const valueClauses: string[] = [];
      const params: unknown[] = [];

      for (let j = 0; j < batch.length; j++) {
        const f = batch[j]!;
        const offset = j * 10;
        params.push(f.name, f.type, f.state, f.city, f.address, f.phone, f.email, f.verified, f.lng, f.lat);
        valueClauses.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, ST_SetSRID(ST_MakePoint($${offset + 9}, $${offset + 10}), 4326)::geography)`
        );
      }

      const sql = `
        INSERT INTO facilities (name, type, state, city, address, phone, email, verified, geom)
        VALUES ${valueClauses.join(', ')}
        RETURNING id, email
      `;
      const res = await client.query(sql, params);
      for (const row of res.rows) {
        facilityIdMap.set(row.email, row.id);
      }

      if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= facilities.length) {
        console.log(`[seed] Inserted ${Math.min(i + BATCH_SIZE, facilities.length)} / ${facilities.length} facilities`);
      }
    }

    // 2. Insert user staff accounts for all facilities
    console.log('[seed] Creating staff login accounts for each hospital (default password: password123)...');
    for (let i = 0; i < facilities.length; i += BATCH_SIZE) {
      const batch = facilities.slice(i, i + BATCH_SIZE);
      const valueClauses: string[] = [];
      const params: unknown[] = [];

      for (let j = 0; j < batch.length; j++) {
        const f = batch[j]!;
        const fid = facilityIdMap.get(f.email)!;
        const offset = j * 5;
        params.push(fid, `${f.name} Admin`, f.email, defaultPwHash, f.type === 'BLOOD_CENTER' ? 'BLOOD_CENTER' : 'HOSPITAL');
        valueClauses.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
      }

      const sql = `
        INSERT INTO users (facility_id, name, email, password_hash, role)
        VALUES ${valueClauses.join(', ')}
      `;
      await client.query(sql, params);
    }

    // 3. Populate realistic vault stock across 8 blood types for every facility
    console.log('[seed] Provisioning blood bank inventory vaults (60,000+ units across 8 blood groups)...');
    const nowMs = Date.now();
    const invBatchSize = 300; // 300 facilities * 8 types = 2400 rows per insert

    for (let i = 0; i < facilities.length; i += invBatchSize) {
      const batch = facilities.slice(i, i + invBatchSize);
      const valueClauses: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      for (let j = 0; j < batch.length; j++) {
        const f = batch[j]!;
        const fid = facilityIdMap.get(f.email)!;
        const rnd = seedRandom((i + j) * 11 + 7);

        for (const bt of BLOOD_TYPES) {
          // Realistic blood group distributions in US hospitals:
          let units = 0;
          const carryChance = bt === 'O+' || bt === 'A+' ? 0.95 : bt === 'O-' ? 0.88 : 0.75;
          if (rnd() < carryChance) {
            if (bt === 'O+') units = Math.floor(rnd() * 20) + 6;
            else if (bt === 'O-') units = Math.floor(rnd() * 12) + 2;
            else if (bt === 'A+') units = Math.floor(rnd() * 16) + 4;
            else if (bt === 'A-') units = Math.floor(rnd() * 10) + 2;
            else if (bt === 'B+') units = Math.floor(rnd() * 14) + 3;
            else if (bt === 'B-') units = Math.floor(rnd() * 8) + 1;
            else if (bt === 'AB+') units = Math.floor(rnd() * 8) + 2;
            else if (bt === 'AB-') units = Math.floor(rnd() * 6) + 1;
          }

          const flagged = units > 0 && rnd() < 0.08;
          const daysAhead = Math.floor(rnd() * 35) + 10;
          const expiresAt = new Date(nowMs + daysAhead * 86400000).toISOString().slice(0, 10);
          const comment = flagged ? 'Priority dispatch - approaching 14-day SLA limit' : null;

          params.push(fid, bt, units, expiresAt, flagged, comment);
          valueClauses.push(
            `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`
          );
          paramIdx += 6;
        }
      }

      const sql = `
        INSERT INTO inventory (facility_id, blood_type, units, expires_at, flagged, comment)
        VALUES ${valueClauses.join(', ')}
      `;
      await client.query(sql, params);
    }

    await client.query('COMMIT');

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[seed] SUCCESS: Seeded ${facilities.length} US hospitals in ${durationSec}s!`);
    console.log('[seed] All facilities are active with default password: "password123"');
    console.log('[seed] Key Demo Portals:');
    for (const d of DEMO_FACILITIES.slice(0, 5)) {
      console.log(`   - ${d.name} (${d.city}, ${d.state}): ${d.email} / password123`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] FAILED, rolled back transaction:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('[seed] Error running seed:', err);
  process.exit(1);
});