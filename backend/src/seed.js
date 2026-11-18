import { emailKey, hashPassword } from './auth.js';

const LOTS = [
  {
    id: 'centro',
    name: 'SmartPark Unidade Centro',
    address: 'Rua Fictícia das Flores, 100 — Centro, São Paulo/SP',
    latitude: -23.5489,
    longitude: -46.6388,
    hourly_rate_cents: 1200,
    opening_hours: '06:00-23:00',
    prefix: 'A',
    spaces: 6,
    device: 'gate-centro-01',
  },
  {
    id: 'paulista',
    name: 'SmartPark Unidade Paulista',
    address: 'Avenida Imaginária, 2000 — Bela Vista, São Paulo/SP',
    latitude: -23.5614,
    longitude: -46.6559,
    hourly_rate_cents: 1500,
    opening_hours: '24h',
    prefix: 'B',
    spaces: 4,
    device: 'gate-paulista-01',
  },
];

async function ensure(ref, data) {
  if (!(await ref.get()).exists) await ref.set(data);
}

export async function seed(db, { adminEmail, adminPassword } = {}) {
  for (const l of LOTS) {
    const { id, prefix, spaces, device, ...lot } = l;
    await ensure(db.collection('parking_lots').doc(id), { ...lot, active: true });
    for (let i = 1; i <= spaces; i++) {
      const label = `${prefix}-${String(i).padStart(2, '0')}`;
      await ensure(db.collection('spaces').doc(`${id}-${label}`), { parking_lot_id: id, label, active: true, occupancy_state: 'FREE' });
    }
    await ensure(db.collection('devices').doc(device), {
      device_id: device,
      parking_lot_id: id,
      status: 'OFFLINE',
      last_seen: null,
      firmware_version: null,
    });
  }
  if (adminEmail && adminPassword) {
    const email = adminEmail.trim().toLowerCase();
    await db.collection('users').doc(emailKey(email)).set(
      { name: 'Operador', email, role: 'admin', password_hash: hashPassword(adminPassword), telegram_chat_id: null },
      { merge: true },
    );
  } else {
    console.warn('[seed] ADMIN_EMAIL/ADMIN_PASSWORD ausentes: nenhum operador criado.');
  }
}
