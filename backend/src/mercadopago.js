import { createHmac } from 'node:crypto';
import { safeEqual } from './auth.js';

const API = 'https://api.mercadopago.com';

export function createMercadoPago(accessToken) {
  async function call(method, path, body, idempotencyKey) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey && { 'X-Idempotency-Key': idempotencyKey }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Mercado Pago respondeu HTTP ${res.status} em ${method} ${path.split('?')[0]}`);
    return data;
  }
  return {
    createPreference: (preference, idempotencyKey) => call('POST', '/checkout/preferences', preference, idempotencyKey),
    getPayment: (id) => call('GET', `/v1/payments/${encodeURIComponent(id)}`),
    refund: (id, idempotencyKey) => call('POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, {}, idempotencyKey),
  };
}

export function verifyMpSignature(secret, { xSignature, xRequestId, dataId }) {
  const parts = Object.fromEntries(
    String(xSignature ?? '')
      .split(',')
      .map((p) => p.trim().split('=')),
  );
  if (!parts.ts || !parts.v1) return false;
  let manifest = `id:${String(dataId).toLowerCase()};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${parts.ts};`;
  return safeEqual(createHmac('sha256', secret).update(manifest).digest('hex'), parts.v1);
}

export const toMpDate = (isoString) =>
  new Date(Date.parse(isoString) - 3 * 3_600_000).toISOString().replace('Z', '-03:00');
