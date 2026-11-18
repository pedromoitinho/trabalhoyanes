export function createTelegram(botToken) {
  return {
    async send(chatId, text) {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(`Telegram HTTP ${res.status}${data.description ? `: ${data.description}` : ''}`);
    },
  };
}
