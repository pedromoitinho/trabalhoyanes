const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, APP_BASE_URL: base } = process.env;
if (!token || !secret || !base?.startsWith('https://')) {
  console.error('Defina TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET e APP_BASE_URL (https) no .env.');
  process.exit(1);
}
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: `${base.replace(/\/$/, '')}/webhooks/telegram`, secret_token: secret, allowed_updates: ['message'] }),
});
const data = await res.json();
console.log(data.ok ? 'Webhook do Telegram registrado.' : `Falhou: ${data.description}`);
