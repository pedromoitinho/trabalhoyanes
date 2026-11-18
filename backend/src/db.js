import { createMemoryDb } from './memdb.js';

export async function openDb(driver) {
  if (driver === 'memory') return createMemoryDb();
  const { initializeApp, applicationDefault, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const account = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const credential = account
    ? cert(JSON.parse(account.startsWith('{') ? account : Buffer.from(account, 'base64').toString('utf8')))
    : applicationDefault();
  initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID });
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
