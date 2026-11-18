import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { deviceKey } from '../src/auth.js';
import { createMemoryDb } from '../src/memdb.js';
import { seed } from '../src/seed.js';

const config = {
  baseUrl: 'https://smartpark.example',
  sessionSecret: 's'.repeat(40),
  deviceSecret: 'd'.repeat(40),
  mpWebhookSecret: 'w'.repeat(40),
  telegramBotUsername: 'smartpark_teste_bot',
  telegramWebhookSecret: 'tg-secret-teste',
  operatorChatId: '999',
  pendingTtlMin: 15,
  entryEarlyMin: 15,
  entryLateMin: 30,
  exitGraceMin: 10,
  cancelRefundMin: 60,
  deviceOfflineMin: 2,
};

let clock = Date.parse('2026-11-18T12:00:00.000Z');
const at = (h, m = 0) => new Date(Date.UTC(2026, 10, 18, h + 3, m)).toISOString();
const setLocal = (h, m = 0) => (clock = Date.parse(at(h, m)));

const payments = new Map();
const mp = {
  prefs: 0,
  refunds: [],
  async createPreference() {
    this.prefs++;
    return { id: `pref-${this.prefs}`, init_point: `https://mp.example/checkout/${this.prefs}` };
  },
  async getPayment(id) {
    if (!payments.has(id)) throw new Error('404');
    return payments.get(id);
  },
  async refund(id) {
    this.refunds.push(id);
    return { status: 'approved' };
  },
};

const sent = [];
let telegramDown = false;
const telegram = {
  async send(chat, text) {
    if (telegramDown) throw new Error('Telegram HTTP 503');
    sent.push({ chat: String(chat), text });
  },
};

let db, core, server, base;
let ana, bia, caio, adminToken;

async function call(method, path, { body, token, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const register = async (name) =>
  (await call('POST', '/api/auth/register', { body: { name, email: `${name}@teste.dev`, password: 'senha-forte-1' } })).body.token;
const reserve = (token, lot, from, to, extra = {}) =>
  call('POST', '/api/reservations', { token, body: { parking_lot_id: lot, arrival: from, departure: to, ...extra } });
const getRes = async (token, id) => (await call('GET', `/api/reservations/${id}`, { token })).body;
const doc = async (colName, id) => (await db.collection(colName).doc(id).get()).data();
const all = async (colName) => (await db.collection(colName).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

function webhook(id, secret = config.mpWebhookSecret) {
  const ts = String(clock);
  const requestId = `req-${id}-${Math.random()}`;
  const v1 = createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
  return call('POST', `/webhooks/mercadopago?data.id=${id}&type=payment`, {
    body: { type: 'payment', action: 'payment.updated', data: { id } },
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
  });
}
function pay(reservation, status, paymentId) {
  payments.set(paymentId, {
    id: Number(paymentId),
    status,
    status_detail: status === 'approved' ? 'accredited' : 'cc_rejected_other_reason',
    external_reference: reservation.id,
    transaction_amount: reservation.price_estimate_cents / 100,
    currency_id: 'BRL',
  });
  return webhook(paymentId);
}

let eventSeq = 0;
const deviceHeaders = (id) => ({ 'X-Device-Id': id, 'X-Device-Key': deviceKey(config.deviceSecret, id) });
const gate = (type, code, { eventId = `gate-centro-01-teste-${++eventSeq}`, device = 'gate-centro-01' } = {}) =>
  call('POST', '/api/iot/access-request', { headers: deviceHeaders(device), body: { event_id: eventId, type, code } });

before(async () => {
  db = createMemoryDb();
  await seed(db, { adminEmail: 'operador@smartpark.test', adminPassword: 'senha-operador-teste' });
  let app;
  ({ app, core } = createApp({ db, mp, telegram, config, now: () => clock }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  [ana, bia, caio] = [await register('ana'), await register('bia'), await register('caio')];
  adminToken = (await call('POST', '/api/auth/login', { body: { email: 'operador@smartpark.test', password: 'senha-operador-teste' } })).body
    .token;
});
after(() => server.close());

test('T01 dashboard: página com Leaflet e marcadores com dados do projeto', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /leaflet@1\.9\.4/);
  const { status, body } = await call('GET', '/api/parking-lots');
  assert.equal(status, 200);
  assert.equal(body.length, 2);
  for (const lot of body) {
    assert.ok(lot.name && lot.address && Number.isFinite(lot.latitude) && Number.isFinite(lot.longitude));
    assert.ok(lot.hourly_rate_cents > 0 && lot.total > 0 && lot.free === lot.total);
    assert.deepEqual(Object.keys(lot).sort(), [
      'address', 'free', 'hourly_rate_cents', 'id', 'latitude', 'longitude', 'name', 'opening_hours', 'total',
    ]);
  }
});

test('T02 datas inválidas são rejeitadas pelo backend', async () => {
  const cases = [
    [at(12), at(11), 'PERIODO_INVALIDO'],
    [at(8), at(10), 'PERIODO_INVALIDO'],
    ['ontem', at(10), 'DATA_INVALIDA'],
    [at(22), at(23, 30), 'FORA_DO_HORARIO'],
  ];
  for (const [from, to, error] of cases) {
    const r = await reserve(ana, 'centro', from, to);
    assert.equal(r.status, 400, `${from} → ${to}`);
    assert.equal(r.body.error, error);
  }
  const q = await call('GET', `/api/parking-lots/centro/availability?arrival=${at(12)}&departure=${at(11)}`);
  assert.equal(q.status, 400);
});

test('T13 preço enviado pelo navegador é ignorado (calculado no servidor)', async () => {
  const r = await reserve(ana, 'centro', at(10), at(12, 30), { price_estimate_cents: 1, price: 0.01, status: 'CONFIRMED' });
  assert.equal(r.status, 201);
  assert.equal(r.body.price_estimate_cents, 3 * 1200);
  assert.equal(r.body.status, 'PENDING_PAYMENT');
  const q = await call('GET', `/api/parking-lots/centro/availability?arrival=${at(10)}&departure=${at(12, 30)}`);
  assert.equal(q.body.price_estimate_cents, 3600);
  assert.equal(q.body.free, 5);
});

test('RF10 painel: só operador cadastra local; motorista recebe 403', async () => {
  const lot = { name: 'Teste Concorrência', address: 'Rua X, 1', latitude: -23.55, longitude: -46.63, hourly_rate_cents: 1000, opening_hours: '24h', spaces: 1, prefix: 'T' };
  assert.equal((await call('POST', '/api/admin/parking-lots', { token: ana, body: lot })).status, 403);
  assert.equal((await call('POST', '/api/admin/parking-lots', { body: lot })).status, 401);
  const r = await call('POST', '/api/admin/parking-lots', { token: adminToken, body: lot });
  assert.equal(r.status, 201);
  test.lotUnico = r.body.id;
  const o = await call('GET', '/api/admin/overview', { token: adminToken });
  assert.equal(o.status, 200);
  assert.ok(o.body.parking_lots.some((l) => l.id === r.body.id && l.total === 1));
});

test('T03 duas pessoas reservam a mesma vaga/horário ao mesmo tempo: só uma consegue', async () => {
  const [x, y] = await Promise.all([
    reserve(bia, test.lotUnico, at(10), at(11)),
    reserve(caio, test.lotUnico, at(10), at(11)),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  const loser = x.status === 409 ? x : y;
  assert.equal(loser.body.error, 'SEM_VAGA');
  const winner = x.status === 201 ? x.body : y.body;
  assert.equal((await pay(winner, 'approved', '3001')).status, 200);
  const confirmed = (await all('reservations')).filter((r) => r.parking_lot_id === test.lotUnico && r.status === 'CONFIRMED');
  assert.equal(confirmed.length, 1);
  assert.equal((await reserve(caio, test.lotUnico, at(11), at(12))).status, 201);
});

test('Telegram: vínculo do chat_id só pelo /start com token de uso único', async () => {
  const { body } = await call('POST', '/api/me/telegram-link', { token: ana });
  const start = new URL(body.url).searchParams.get('start');
  const update = { update_id: 1, message: { text: `/start ${start}`, chat: { id: 555, type: 'private' } } };
  assert.equal((await call('POST', '/webhooks/telegram', { body: update, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'errado' } })).status, 401);
  assert.equal((await call('POST', '/webhooks/telegram', { body: update, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret-teste' } })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: ana })).body.telegram_linked, true);
  const replay = { update_id: 2, message: { text: `/start ${start}`, chat: { id: 666, type: 'private' } } };
  await call('POST', '/webhooks/telegram', { body: replay, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret-teste' } });
  const user = (await all('users')).find((u) => u.email === 'ana@teste.dev');
  assert.equal(user.telegram_chat_id, '555');
});

test('T04 pagamento rejeitado: reserva não confirma e entrada é negada', async () => {
  const r = (await reserve(ana, 'centro', at(9, 30), at(11))).body;
  test.rejeitada = r;
  assert.equal((await pay(r, 'rejected', '1001')).status, 200);
  assert.equal((await getRes(ana, r.id)).status, 'PENDING_PAYMENT');
  assert.equal((await doc('payments', 'mp_1001')).status, 'rejected');
  const g = await gate('ENTRY', r.code);
  assert.equal(g.body.allow, false);
  assert.equal(g.body.action, 'KEEP_CLOSED');
  assert.equal(g.body.message, 'Pagto pendente');
});

test('T05 pagamento aprovado com webhook válido confirma uma única vez', async () => {
  const r = (await reserve(ana, 'centro', at(9, 10), at(10, 10))).body;
  test.confirmada = r;
  payments.set('1002', { id: 1002, status: 'approved', external_reference: r.id, transaction_amount: 12, currency_id: 'BRL' });
  assert.equal((await webhook('1002', 'segredo-errado')).status, 401);
  assert.equal((await getRes(ana, r.id)).status, 'PENDING_PAYMENT');
  assert.equal((await webhook('1002')).status, 200);
  const res = await getRes(ana, r.id);
  assert.equal(res.status, 'CONFIRMED');
  assert.equal(res.payment_id, '1002');
  const p = await doc('payments', 'mp_1002');
  assert.equal(p.status, 'approved');
  assert.ok(p.verified_at);
  assert.equal(p.reconciliation, null);
  const msgs = sent.filter((m) => m.chat === '555' && m.text.includes('RESERVA CONFIRMADA') && m.text.includes(r.code));
  assert.equal(msgs.length, 1);
});

test('T06 mesmo webhook duas vezes: nenhuma confirmação ou mensagem duplicada', async () => {
  const r = test.confirmada;
  const before1 = await getRes(ana, r.id);
  assert.equal((await webhook('1002')).status, 200);
  assert.equal((await webhook('1002')).status, 200);
  const after1 = await getRes(ana, r.id);
  assert.equal(after1.confirmed_at, before1.confirmed_at);
  assert.equal(sent.filter((m) => m.text.includes('RESERVA CONFIRMADA') && m.text.includes(r.code)).length, 1);
  assert.equal((await all('payments')).filter((p) => p.payment_id === '1002').length, 1);
});

test('Regra 12.3 pagamento aprovado após expiração: não confirma, gera reconciliação e alerta', async () => {
  const r = (await reserve(ana, 'centro', at(13), at(14))).body;
  setLocal(9, 16);
  assert.equal((await pay(r, 'approved', '1003')).status, 200);
  const res = await getRes(ana, r.id);
  assert.equal(res.status, 'EXPIRED');
  assert.equal((await doc('payments', 'mp_1003')).reconciliation, 'RESERVA_EXPIRADA');
  assert.ok(sent.some((m) => m.chat === '999' && m.text.includes('1003') && m.text.includes('RESERVA_EXPIRADA')));
  assert.equal((await gate('ENTRY', r.code)).body.allow, false);
});

test('T07 entrada com reserva válida: autoriza, registra evento único e ocupa a vaga', async () => {
  const r = test.confirmada;
  assert.equal((await gate('ENTRY', r.code, { device: 'gate-paulista-01' })).body.allow, false);
  const bad = await call('POST', '/api/iot/access-request', {
    headers: { 'X-Device-Id': 'gate-centro-01', 'X-Device-Key': 'chave-errada' },
    body: { event_id: 'gate-centro-01-x-1', type: 'ENTRY', code: r.code },
  });
  assert.equal(bad.status, 401);

  const g = await gate('ENTRY', r.code, { eventId: 'gate-centro-01-boot1-1' });
  assert.deepEqual(g.body, { event_id: 'gate-centro-01-boot1-1', allow: true, action: 'OPEN', message: 'Entrada liberada' });
  const again = await gate('ENTRY', r.code, { eventId: 'gate-centro-01-boot1-1' });
  assert.deepEqual(again.body, g.body);
  const events = (await all('access_events')).filter((e) => e.reservation_id === r.id && e.result === 'ALLOWED');
  assert.equal(events.length, 1);
  const res = await getRes(ana, r.id);
  assert.equal(res.status, 'CHECKED_IN');
  assert.equal((await doc('spaces', res.space_id)).occupancy_state, 'OCCUPIED');
  assert.equal((await gate('ENTRY', r.code)).body.allow, false);
});

test('T08 entrada sem reserva paga ou com código inexistente: cancela fechada', async () => {
  for (const code of [test.rejeitada.code, 'ZZZZZZZZ', '']) {
    const g = await gate('ENTRY', code);
    assert.equal(g.status, 200);
    assert.equal(g.body.allow, false);
    assert.equal(g.body.action, 'KEEP_CLOSED');
  }
});

test('T10 saída: salva horário real, duração e valor final pela política', async () => {
  const r = test.confirmada;
  setLocal(10, 15);
  const g = await gate('EXIT', r.code, { eventId: 'gate-centro-01-boot1-2' });
  assert.equal(g.body.allow, true);
  const res = await getRes(ana, r.id);
  assert.equal(res.status, 'COMPLETED');
  assert.equal(res.departure_real, at(10, 15));
  const t = await doc('tickets', r.id);
  assert.equal(t.duration_minutes, 59);
  assert.equal(t.extra_cents, 0);
  assert.equal(t.final_amount_cents, 1200);
  assert.equal(t.telegram_status, 'SENT');
  assert.equal((await doc('spaces', res.space_id)).occupancy_state, 'FREE');
  const msg = sent.find((m) => m.text.includes(`Ticket: SP-${r.code}`));
  assert.match(msg.text, /Duração: 0h59min/);
  assert.match(msg.text, /Valor final: R\$\s12,00/);
});

test('T11 saída repetida: sem novo ticket nem nova cobrança', async () => {
  const r = test.confirmada;
  const same = await gate('EXIT', r.code, { eventId: 'gate-centro-01-boot1-2' });
  assert.equal(same.body.allow, true);
  const other = await gate('EXIT', r.code);
  assert.equal(other.body.allow, false);
  assert.equal((await all('tickets')).filter((t) => t.reservation_id === r.id).length, 1);
  assert.equal(sent.filter((m) => m.text.includes(`Ticket: SP-${r.code}`)).length, 1);
  assert.equal((await getRes(ana, r.id)).final_amount_cents, 1200);
});

test('T12 Telegram indisponível: ticket salvo, envio PENDING_RETRY e reenvio sem duplicar', async () => {
  const r = (await reserve(ana, 'centro', at(10, 30), at(11, 30))).body;
  await pay(r, 'approved', '1004');
  setLocal(10, 20);
  assert.equal((await gate('ENTRY', r.code)).body.allow, true);
  telegramDown = true;
  setLocal(11, 50);
  assert.equal((await gate('EXIT', r.code)).body.allow, true);
  let t = await doc('tickets', r.id);
  assert.equal(t.telegram_status, 'PENDING_RETRY');
  assert.equal(t.extra_cents, 1200);
  assert.equal(t.final_amount_cents, 2400);
  assert.equal(t.payment_status, 'APROVADO_COM_EXCEDENTE_PENDENTE');
  assert.equal((await doc('notifications', `${r.id}:TICKET`)).status, 'PENDING_RETRY');

  telegramDown = false;
  await core.sweep();
  await core.sweep();
  t = await doc('tickets', r.id);
  assert.equal(t.telegram_status, 'SENT');
  assert.equal(sent.filter((m) => m.text.includes(`Ticket: SP-${r.code}`)).length, 1);
  assert.equal((await doc('notifications', `${r.id}:TICKET`)).attempts, 2);
});

test('T14 reserva de outro usuário: acesso negado', async () => {
  const id = test.confirmada.id;
  assert.equal((await call('GET', `/api/reservations/${id}`, { token: bia })).status, 403);
  assert.equal((await call('POST', `/api/reservations/${id}/cancel`, { token: bia })).status, 403);
  assert.equal((await call('GET', `/api/reservations/${id}`)).status, 401);
  assert.equal((await call('GET', `/api/reservations/${id}`, { token: 'forjado.9999999999999.abc' })).status, 401);
  assert.equal((await call('GET', `/api/reservations/${id}`, { token: adminToken })).status, 200);
});

test('Cancelamento: pendente cancela; confirmada com 60+ min reembolsa', async () => {
  const p = (await reserve(bia, 'paulista', at(15), at(16))).body;
  assert.equal((await call('POST', `/api/reservations/${p.id}/cancel`, { token: bia })).body.status, 'CANCELLED');
  const c = (await reserve(bia, 'paulista', at(15), at(16))).body;
  await pay(c, 'approved', '2001');
  const r = await call('POST', `/api/reservations/${c.id}/cancel`, { token: bia });
  assert.equal(r.body.status, 'CANCELLED');
  assert.equal(r.body.refund_status, 'REFUNDED');
  assert.deepEqual(mp.refunds, ['2001']);
});

test('Telemetria, alerta de dispositivo offline e expiração automática', async () => {
  const h = deviceHeaders('gate-centro-01');
  const bad = await call('POST', '/api/iot/telemetry', { headers: h, body: { state: 'HACK', gate: 'CLOSED' } });
  assert.equal(bad.status, 400);
  await new Promise((ok) => setTimeout(ok, 5_100));
  const ok = await call('POST', '/api/iot/telemetry', {
    headers: h,
    body: { state: 'PRONTO', gate: 'CLOSED', entry_cm: 300, exit_cm: 300, firmware_version: '1.0.0' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.total, 6);
  assert.equal((await call('POST', '/api/iot/telemetry', { headers: h, body: { state: 'PRONTO', gate: 'CLOSED' } })).status, 429);
  clock += 3 * 60_000;
  await core.sweep();
  assert.equal((await doc('devices', 'gate-centro-01')).status, 'OFFLINE');
  assert.ok(sent.some((m) => m.chat === '999' && m.text.includes('gate-centro-01 sem comunicação')));
  assert.equal((await getRes(ana, test.rejeitada.id)).status, 'EXPIRED');
});

test('T15 repositório sem tokens, chaves ou credenciais', async () => {
  const root = new URL('../../', import.meta.url);
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((f) => f.isFile() && !/node_modules|[\\/]\.git([\\/]|$)/.test(f.parentPath) && f.name !== '.env')
    .map((f) => `${f.parentPath}/${f.name}`);
  const patterns = [
    /APP_USR-\d{6,}/,
    /TEST-\d{10,}/,
    /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /"private_key"\s*:/,
  ];
  for (const f of files) {
    const text = await readFile(f, 'utf8').catch(() => '');
    for (const p of patterns) assert.doesNotMatch(text, p, `possível segredo em ${f}`);
  }
  const gitignore = await readFile(new URL('.gitignore', root), 'utf8');
  for (const entry of ['.env', '*service-account*.json']) assert.ok(gitignore.includes(entry));
});
