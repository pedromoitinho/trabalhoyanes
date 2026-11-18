import { iso, isAlreadyExists } from './util.js';

const MAX_ATTEMPTS = 5;

export function createNotifier({ db, telegram, now }) {
  const col = db.collection('notifications');

  async function syncTicket(n, status) {
    if (n.type === 'TICKET') await db.collection('tickets').doc(n.reservation_id).update({ telegram_status: status });
  }

  async function enqueue(id, { chat_id, type, text, reservation_id = null }) {
    const n = {
      notification_id: id,
      reservation_id,
      channel: 'telegram',
      type,
      chat_id: chat_id ?? null,
      text,
      status: chat_id ? 'PENDING' : 'SEM_DESTINO',
      attempts: 0,
      created_at: iso(now()),
      sent_at: null,
      last_error: null,
    };
    try {
      await col.doc(id).create(n);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      return (await col.doc(id).get()).data().status;
    }
    if (!chat_id) {
      await syncTicket(n, n.status);
      return n.status;
    }
    return attempt(col.doc(id));
  }

  async function attempt(ref) {
    const n = await db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      if (!['PENDING', 'PENDING_RETRY'].includes(d.status)) return null;
      tx.update(ref, { status: 'SENDING', attempts: d.attempts + 1 });
      return { ...d, attempts: d.attempts + 1 };
    });
    if (!n) return (await ref.get()).data().status;
    let status;
    let extra;
    try {
      if (!telegram) throw new Error('Telegram não configurado');
      await telegram.send(n.chat_id, n.text);
      status = 'SENT';
      extra = { sent_at: iso(now()), last_error: null };
    } catch (e) {
      status = n.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING_RETRY';
      extra = { last_error: String(e.message).slice(0, 200) };
    }
    await ref.update({ status, ...extra });
    await syncTicket(n, status);
    return status;
  }

  async function retryPending() {
    const q = await col.where('status', '==', 'PENDING_RETRY').get();
    for (const d of q.docs) await attempt(d.ref);
  }

  return { enqueue, retryPending };
}
