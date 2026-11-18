import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';

const db = await openDb('firestore');
await seed(db, { adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD });
console.log('Seed concluído: 2 estacionamentos, vagas e dispositivos de demonstração.');
