import { createMemoryDb } from './memdb.js';

export async function openDb(driver) {
  if (driver === 'memory') return createMemoryDb();
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
