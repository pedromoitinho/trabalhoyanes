import express from 'express';
import { fileURLToPath } from 'node:url';
import { deviceKey, readToken, safeEqual } from './auth.js';
import { createCore } from './core.js';
import { verifyMpSignature } from './mercadopago.js';
import { createNotifier } from './notifier.js';
import { HttpError } from './util.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    const recent = (hits.get(k) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) return res.status(429).json({ error: 'LIMITE_EXCEDIDO', message: 'Muitas requisições; aguarde.' });
    recent.push(t);
    hits.set(k, recent);
    next();
  };
}

export function createApp({ db, mp, telegram, config, now = Date.now }) {
  const notifier = createNotifier({ db, telegram, now });
  const core = createCore({ db, mp, telegram, notifier, config, now });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 'loopback');

  app.use((req, res, next) => {
    if (req.get('x-forwarded-proto') === 'http') return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
    next();
  });
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`));
    next();
  });
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; " +
        "img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(PUBLIC_DIR));

  const authLimit = rateLimit({ windowMs: 60_000, max: 20, key: (req) => req.ip });

  async function auth(req, res, next) {
    const uid = readToken(config.sessionSecret, (req.get('authorization') ?? '').replace(/^Bearer /, ''), now());
    const user = uid && (await db.collection('users').doc(uid).get());
    if (!user?.exists) return res.status(401).json({ error: 'NAO_AUTENTICADO', message: 'Faça login novamente.' });
    req.user = { id: user.id, ...user.data() };
    next();
  }
  const admin = (req, res, next) =>
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'ACESSO_NEGADO', message: 'Somente operadores.' });

  async function device(req, res, next) {
    const id = req.get('x-device-id') ?? '';
    if (!/^[a-z0-9-]{3,40}$/.test(id) || !safeEqual(req.get('x-device-key') ?? '', deviceKey(config.deviceSecret, id))) {
      return res.status(401).json({ error: 'DISPOSITIVO_NAO_AUTENTICADO' });
    }
    const d = await db.collection('devices').doc(id).get();
    if (!d.exists || d.data().status === 'DISABLED') return res.status(403).json({ error: 'DISPOSITIVO_BLOQUEADO' });
    req.device = { id, ...d.data() };
    next();
  }

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/register', authLimit, async (req, res) => res.status(201).json(await core.register(req.body)));
  app.post('/api/auth/login', authLimit, async (req, res) => res.json(await core.login(req.body)));
  app.get('/api/me', auth, (req, res) => res.json(core.publicUser(req.user.id, req.user)));
  app.post('/api/me/telegram-link', auth, async (req, res) => res.json(await core.telegramLink(req.user)));

  app.get('/api/parking-lots', async (req, res) => res.json(await core.listLots()));
  app.get('/api/parking-lots/:id/availability', async (req, res) => res.json(await core.quote(req.params.id, req.query)));

  app.post('/api/reservations', auth, async (req, res) => res.status(201).json(await core.createReservation(req.user, req.body)));
  app.get('/api/reservations', auth, async (req, res) => res.json(await core.myReservations(req.user)));
  app.get('/api/reservations/:id', auth, async (req, res) => res.json(core.view(await core.reservationFor(req.user, req.params.id))));
  app.post('/api/reservations/:id/checkout', auth, async (req, res) => res.json(await core.checkout(req.user, req.params.id)));
  app.post('/api/reservations/:id/cancel', auth, async (req, res) => res.json(await core.cancel(req.user, req.params.id)));

  app.post('/webhooks/mercadopago', async (req, res) => {
    const type = req.query.type ?? req.body?.type;
    const dataId = String(req.query['data.id'] ?? req.body?.data?.id ?? '');
    if (type !== 'payment' || !dataId) return res.sendStatus(200);
    const valid =
      config.mpWebhookSecret &&
      verifyMpSignature(config.mpWebhookSecret, { xSignature: req.get('x-signature'), xRequestId: req.get('x-request-id'), dataId });
    if (!valid) return res.status(401).json({ error: 'ASSINATURA_INVALIDA' });
    await core.processPayment(dataId);
    res.sendStatus(200);
  });

  app.post('/webhooks/telegram', async (req, res) => {
    if (!config.telegramWebhookSecret || !safeEqual(req.get('x-telegram-bot-api-secret-token') ?? '', config.telegramWebhookSecret)) {
      return res.sendStatus(401);
    }
    await core.telegramUpdate(req.body);
    res.sendStatus(200);
  });

  app.post('/api/iot/access-request', device, async (req, res) => res.json(await core.access(req.device, req.body)));
  app.post(
    '/api/iot/telemetry',
    device,
    rateLimit({ windowMs: 5_000, max: 1, key: (req) => req.device.id }),
    async (req, res) => res.json(await core.telemetry(req.device, req.body)),
  );

  app.get('/api/admin/overview', auth, admin, async (req, res) => res.json(await core.overview()));
  app.post('/api/admin/parking-lots', auth, admin, async (req, res) => res.status(201).json(await core.createLot(req.body)));
  app.post('/api/admin/devices', auth, admin, async (req, res) =>
    res.status(201).json(await core.createDevice(req.body, (id) => deviceKey(config.deviceSecret, id))),
  );

  app.use((req, res) => res.status(404).json({ error: 'NAO_ENCONTRADO' }));
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.expose) return res.status(err.status).json({ error: 'REQUISICAO_INVALIDA', message: 'JSON inválido ou grande demais.' });
    console.error('[erro]', err.message);
    res.status(500).json({ error: 'ERRO_INTERNO', message: 'Erro interno.' });
  });

  return { app, core, notifier };
}
