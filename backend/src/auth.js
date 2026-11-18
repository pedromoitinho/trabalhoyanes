import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 12 * 60 * 60_000;

const hmac = (secret, text) => createHmac('sha256', secret).update(text).digest('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function checkPassword(password, stored = 'x:00') {
  const [salt, hash] = stored.split(':');
  return safeEqual(scryptSync(password, salt, 32).toString('hex'), hash);
}

export function issueToken(secret, uid, nowMs) {
  const body = `${uid}.${nowMs + TOKEN_TTL_MS}`;
  return `${body}.${hmac(secret, body)}`;
}

export function readToken(secret, token, nowMs) {
  const [uid, exp, sig] = String(token ?? '').split('.');
  if (!sig || !safeEqual(sig, hmac(secret, `${uid}.${exp}`)) || !(Number(exp) > nowMs)) return null;
  return uid;
}

export const deviceKey = (secret, deviceId) => hmac(secret, `device:${deviceId}`);

export const emailKey = (email) => createHash('sha256').update(email).digest('hex').slice(0, 40);
