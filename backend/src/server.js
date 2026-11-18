import { createApp } from './app.js';
import { openDb } from './db.js';
import { createMercadoPago } from './mercadopago.js';
import { seed } from './seed.js';
import { createTelegram } from './telegram.js';

const env = process.env;
const memory = process.argv.includes('--memory') || env.DB_DRIVER === 'memory';

const missing = ['SESSION_SECRET', 'DEVICE_SHARED_SECRET'].filter((k) => (env[k] ?? '').length < 32);
if (env.MERCADOPAGO_ACCESS_TOKEN && !env.MERCADOPAGO_WEBHOOK_SECRET) missing.push('MERCADOPAGO_WEBHOOK_SECRET');
if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_WEBHOOK_SECRET) missing.push('TELEGRAM_WEBHOOK_SECRET');
if (missing.length) {
  console.error(`Configuração inválida: defina ${missing.join(', ')} no .env (segredos com 32+ caracteres). Veja .env.example.`);
  process.exit(1);
}

const num = (key, fallback) => Number(env[key] ?? fallback);
const port = num('PORT', 3000);
const config = {
  baseUrl: (env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  sessionSecret: env.SESSION_SECRET,
  deviceSecret: env.DEVICE_SHARED_SECRET,
  mpWebhookSecret: env.MERCADOPAGO_WEBHOOK_SECRET,
  telegramBotUsername: env.TELEGRAM_BOT_USERNAME,
  telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  operatorChatId: env.TELEGRAM_DEFAULT_CHAT_ID || null,
  pendingTtlMin: num('PENDING_TTL_MIN', 15),
  entryEarlyMin: num('ENTRY_EARLY_MIN', 15),
  entryLateMin: num('ENTRY_LATE_MIN', 30),
  exitGraceMin: num('EXIT_GRACE_MIN', 10),
  cancelRefundMin: num('CANCEL_REFUND_MIN', 60),
  deviceOfflineMin: num('DEVICE_OFFLINE_MIN', 2),
};

const db = await openDb(memory ? 'memory' : 'firestore');
if (memory) await seed(db, { adminEmail: env.ADMIN_EMAIL, adminPassword: env.ADMIN_PASSWORD });
const mp = env.MERCADOPAGO_ACCESS_TOKEN ? createMercadoPago(env.MERCADOPAGO_ACCESS_TOKEN) : null;
const telegram = env.TELEGRAM_BOT_TOKEN ? createTelegram(env.TELEGRAM_BOT_TOKEN) : null;
if (!mp) console.warn('[aviso] MERCADOPAGO_ACCESS_TOKEN ausente: checkout desativado.');
if (!telegram) console.warn('[aviso] TELEGRAM_BOT_TOKEN ausente: notificações ficam registradas no banco, sem envio.');

const { app, core } = createApp({ db, mp, telegram, config });
app.listen(port, () => console.log(`SmartPark IoT em http://localhost:${port} — banco: ${memory ? 'memória (demo)' : 'Firestore'}`));

setInterval(() => core.sweep().catch((e) => console.error('[sweep]', e.message)), 60_000);
