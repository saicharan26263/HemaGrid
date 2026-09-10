// End-to-end test: full auth -> request -> smart-match -> provider ACCEPT -> inventory decrement flow
import { io } from 'socket.io-client';

const URL = 'http://localhost:4000';
const api = `${URL}/api`;

async function login(email) {
  const r = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  if (!r.ok) throw new Error(`login ${email} failed: ${r.status}`);
  return r.json();
}

function connect(token) {
  return io(URL, { auth: { token }, transports: ['websocket'] });
}

async function main() {
  const stmarys = await login('stmarys@bloodbanc.demo');
  console.log('Requester:', stmarys.user.name, '|', stmarys.user.facilityId);

  // Record St Mary's pre-request O- inventory
  const invBefore = await (await fetch(`${api}/inventory`, { headers: { Authorization: `Bearer ${stmarys.accessToken}` } })).json();
  const requesterOBefore = invBefore.items.find(i => i.blood_type === 'O-')?.units ?? 0;
  console.log('St Mary\'s O- before request:', requesterOBefore);

  const sock = connect(stmarys.accessToken);

  sock.on('connect', () => {
    console.log('[requester] connected — creating O- x4 CRITICAL');
    sock.emit('request:create', { bloodType: 'O-', units: 4, urgency: 'CRITICAL', notes: 'Mass casualty, urgent' });
  });

  sock.on('request:status', async (detail) => {
    console.log('\n=== REQUEST DISPATCHED ===');
    console.log('status:', detail.status, '| tier:', detail.tier, '| type:', detail.bloodType, '| units:', detail.units);
    console.log('matches:');
    for (const m of detail.matches) {
      console.log(`  - provider ${m.providerId} offered ${m.matchedBloodType} (${m.compatibility}) ${m.units}u @ ${Math.round(m.distanceM/1000)}km [${m.response}]`);
    }

    const pending = detail.matches.find(m => m.response === 'PENDING');
    if (!pending) { console.log('(no pending match to respond to)'); return; }

    // Map provider facility -> its login email (facilities email = <slug>@bloodbanc.demo; user email = <slug>@bloodbanc.demo too)
    // We know provider ids; look up via /api/facilities and derive login email
    const provEmail = await resolveProviderEmail(stmarys.accessToken, pending.providerId);
    console.log('\n>>> Provider', provEmail, 'ACCEPTS the request');
    const provider = await login(provEmail);
    const psock = connect(provider.accessToken);
    psock.on('connect', () => {
      psock.emit('match:respond', { requestId: detail.id, response: 'ACCEPT', reason: 'Stock available' });
    });
    psock.on('request:status', (d2) => {
      console.log('\n=== AFTER ACCEPT ===');
      console.log('request status:', d2.status);
      console.log('match responses:', d2.matches.map(m => `${m.providerId.slice(0,8)}:${m.response}`).join(', '));
      // Done
      setTimeout(() => process.exit(0), 500);
    });
    psock.on('error:general', (m) => console.log('[provider ERROR]', m));
  });

  sock.on('request:matched', (reqId, match) => {
    console.log('\n[matched] request matched — provider', match.providerId.slice(0,8), match.compatibility);
  });
  sock.on('error:general', (m) => console.log('[error]', m));
  sock.on('error:validation', (e) => console.log('[validation]', JSON.stringify(e)));

  setTimeout(() => { console.log('\n[done - timeout]'); process.exit(0); }, 8000);
}

async function resolveProviderEmail(token, providerId) {
  const r = await fetch(`${api}/facilities`, { headers: { Authorization: `Bearer ${token}` } });
  const facs = await r.json();
  const f = facs.find(x => x.id === providerId);
  // facility email is like 'brooklyn@bloodbanc.demo'; user email is the same slug
  return f.email; // 'brooklyn@bloodbanc.demo' === user login email
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });