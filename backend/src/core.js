import { randomBytes, randomInt } from 'node:crypto';
import { checkPassword, emailKey, hashPassword, issueToken } from './auth.js';
import { confirmationText, dateTime, entryText, money, ticketText } from './format.js';
import { toMpDate } from './mercadopago.js';
import { estimateCents, finalAmount, withinOpeningHours } from './pricing.js';
import { MIN, fail, idOf, iso, isAlreadyExists } from './util.js';

const BLOCKING = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEVICE_STATES = ['INICIALIZANDO', 'PRONTO', 'VALIDANDO', 'ACESSO_LIBERADO', 'ACESSO_NEGADO', 'FALHA_REDE', 'MANUTENCAO'];
const DEVICE_ALERTS = ['FALHA_REDE_REPETIDA', 'CANCELA_INESPERADA'];
const DENY_MESSAGE = { PAGAMENTO_PENDENTE: 'Pagto pendente', FORA_DA_JANELA: 'Fora do horario' };

const view = (d) => ({ id: d.id, ...d.data() });
const newCode = () => Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
const overlaps = (x, y) =>
  Date.parse(x.arrival_expected) < Date.parse(y.departure_expected) &&
  Date.parse(y.arrival_expected) < Date.parse(x.departure_expected);
const byNewest = (a, b) => String(b.created_at).localeCompare(String(a.created_at));

export function createCore({ db, mp, telegram, notifier, config, now }) {
  const col = (name) => db.collection(name);
  const alert = (key, text) => notifier.enqueue(`alert:${key}`, { chat_id: config.operatorChatId, type: 'ALERT', text });

  async function notifyUser(reservationId, userId, type, text) {
    const user = (await col('users').doc(userId).get()).data();
    return notifier.enqueue(`${reservationId}:${type}`, { chat_id: user?.telegram_chat_id, type, text, reservation_id: reservationId });
  }

  const publicUser = (id, u) => ({ id, name: u.name, email: u.email, role: u.role, telegram_linked: Boolean(u.telegram_chat_id) });
  const session = (id, u) => ({ token: issueToken(config.sessionSecret, id, now()), user: publicUser(id, u) });

  async function register(body) {
    const name = String(body?.name ?? '').trim();
    const email = String(body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    if (!name || name.length > 80) fail(400, 'NOME_INVALIDO', 'Informe um nome de até 80 caracteres.');
    if (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'EMAIL_INVALIDO', 'E-mail inválido.');
    if (password.length < 8 || password.length > 128) fail(400, 'SENHA_FRACA', 'A senha deve ter de 8 a 128 caracteres.');
    const ref = col('users').doc(emailKey(email));
    const user = { name, email, password_hash: hashPassword(password), role: 'driver', telegram_chat_id: null, created_at: iso(now()) };
    try {
      await ref.create(user);
    } catch (e) {
      if (isAlreadyExists(e)) fail(409, 'EMAIL_EM_USO', 'E-mail já cadastrado.');
      throw e;
    }
    return session(ref.id, user);
  }

  async function login(body) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    const snap = await col('users').doc(emailKey(email)).get();
    const ok = checkPassword(String(body?.password ?? ''), snap.exists ? snap.data().password_hash : undefined);
    if (!snap.exists || !ok) fail(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha inválidos.');
    return session(snap.id, snap.data());
  }

  async function telegramLink(user) {
    if (!config.telegramBotUsername) fail(503, 'TELEGRAM_INDISPONIVEL', 'Bot do Telegram não configurado.');
    const token = randomBytes(16).toString('base64url');
    await col('telegram_links').doc(token).set({ user_id: user.id, expires_at: iso(now() + 15 * MIN) });
    return { url: `https://t.me/${config.telegramBotUsername}?start=${token}` };
  }

  async function telegramUpdate(update) {
    const msg = update?.message;
    const m = /^\/start\s+([A-Za-z0-9_-]{10,64})$/.exec(msg?.text ?? '');
    if (!m || msg.chat?.type !== 'private') return;
    const linkRef = col('telegram_links').doc(m[1]);
    const linked = await db.runTransaction(async (tx) => {
      const link = await tx.get(linkRef);
      if (!link.exists || Date.parse(link.data().expires_at) < now()) return false;
      tx.update(col('users').doc(link.data().user_id), { telegram_chat_id: String(msg.chat.id) });
      tx.delete(linkRef);
      return true;
    });
    const reply = linked
      ? 'Conta SmartPark vinculada. Você receberá aqui confirmações de reserva e tickets.'
      : 'Link inválido ou expirado. Gere um novo no site do SmartPark.';
    await telegram?.send(msg.chat.id, reply).catch((e) => console.error('[telegram]', e.message));
  }

  const isBlocking = (r, t) =>
    r.status === 'PENDING_PAYMENT' ? Date.parse(r.expires_at) > t : r.status === 'CONFIRMED' || r.status === 'CHECKED_IN';

  function busySpaces(reservationDocs, a, b, t) {
    const busy = new Set();
    for (const d of reservationDocs) {
      const r = d.data();
      if (!isBlocking(r, t)) continue;
      let start = Date.parse(r.arrival_expected);
      let end = Date.parse(r.departure_expected);
      if (r.status === 'CHECKED_IN') {
        start = Math.min(start, Date.parse(r.arrival_real));
        end = Math.max(end, t + MIN);
      }
      if (start < b && a < end) busy.add(r.space_id);
    }
    return busy;
  }

  const lotSpacesQ = (lotId) => col('spaces').where('parking_lot_id', '==', lotId);
  const lotActiveQ = (lotId) => col('reservations').where('parking_lot_id', '==', lotId).where('status', 'in', BLOCKING);

  function parseWindow(body, t) {
    const a = Date.parse(body?.arrival);
    const b = Date.parse(body?.departure);
    if (!Number.isFinite(a) || !Number.isFinite(b)) fail(400, 'DATA_INVALIDA', 'Informe chegada e saída em formato ISO 8601.');
    if (b <= a) fail(400, 'PERIODO_INVALIDO', 'A saída deve ser posterior à chegada.');
    if (b - a < 30 * MIN) fail(400, 'PERIODO_INVALIDO', 'A reserva mínima é de 30 minutos.');
    if (b - a > 24 * 60 * MIN) fail(400, 'PERIODO_INVALIDO', 'A reserva máxima é de 24 horas.');
    if (a < t - 5 * MIN) fail(400, 'PERIODO_INVALIDO', 'A chegada não pode estar no passado.');
    if (a > t + 30 * 24 * 60 * MIN) fail(400, 'PERIODO_INVALIDO', 'Reservas com até 30 dias de antecedência.');
    return { a, b };
  }

  function checkOpening(lot, a, b) {
    if (!withinOpeningHours(lot.opening_hours, a, b)) fail(400, 'FORA_DO_HORARIO', `Horário de funcionamento: ${lot.opening_hours}.`);
  }

  async function availability(lotId, a, b) {
    const t = now();
    const [spaces, reservations] = await Promise.all([lotSpacesQ(lotId).get(), lotActiveQ(lotId).get()]);
    const busy = busySpaces(reservations.docs, a, b, t);
    const active = spaces.docs.filter((s) => s.data().active);
    return { total: active.length, free: active.filter((s) => !busy.has(s.id)).length };
  }

  async function activeLot(lotId) {
    const d = await col('parking_lots').doc(idOf(lotId, 'parking_lot_id')).get();
    if (!d.exists || !d.data().active) fail(404, 'LOCAL_NAO_ENCONTRADO', 'Estacionamento não encontrado.');
    return d;
  }

  async function listLots() {
    const t = now();
    const lots = await col('parking_lots').where('active', '==', true).get();
    return Promise.all(
      lots.docs.map(async (d) => {
        const l = d.data();
        return {
          id: d.id,
          name: l.name,
          address: l.address,
          latitude: l.latitude,
          longitude: l.longitude,
          hourly_rate_cents: l.hourly_rate_cents,
          opening_hours: l.opening_hours,
          ...(await availability(d.id, t, t + MIN)),
        };
      }),
    );
  }

  async function quote(lotId, query) {
    const lot = await activeLot(lotId);
    const { a, b } = parseWindow(query, now());
    checkOpening(lot.data(), a, b);
    return { ...(await availability(lot.id, a, b)), price_estimate_cents: estimateCents(a, b, lot.data().hourly_rate_cents) };
  }

  async function createReservation(user, body) {
    const t = now();
    const lotId = idOf(body?.parking_lot_id, 'parking_lot_id');
    const { a, b } = parseWindow(body, t);
    const pending = await col('reservations').where('user_id', '==', user.id).where('status', '==', 'PENDING_PAYMENT').get();
    if (pending.docs.filter((d) => isBlocking(d.data(), t)).length >= 3) {
      fail(429, 'MUITAS_PENDENTES', 'Pague ou cancele suas reservas pendentes antes de criar outra.');
    }
    const lotRef = col('parking_lots').doc(lotId);
    const ref = col('reservations').doc();
    return db.runTransaction(async (tx) => {
      const lot = await tx.get(lotRef);
      if (!lot.exists || !lot.data().active) fail(404, 'LOCAL_NAO_ENCONTRADO', 'Estacionamento não encontrado.');
      checkOpening(lot.data(), a, b);
      const spaces = await tx.get(lotSpacesQ(lotId));
      const reservations = await tx.get(lotActiveQ(lotId));
      const busy = busySpaces(reservations.docs, a, b, t);
      const space = spaces.docs
        .filter((s) => s.data().active && !busy.has(s.id))
        .sort((x, y) => x.data().label.localeCompare(y.data().label))[0];
      if (!space) fail(409, 'SEM_VAGA', 'Não há vaga livre neste período.');
      const r = {
        user_id: user.id,
        parking_lot_id: lotId,
        parking_lot_name: lot.data().name,
        space_id: space.id,
        space_label: space.data().label,
        code: newCode(),
        arrival_expected: iso(a),
        departure_expected: iso(b),
        status: 'PENDING_PAYMENT',
        hourly_rate_cents: lot.data().hourly_rate_cents,
        price_estimate_cents: estimateCents(a, b, lot.data().hourly_rate_cents),
        created_at: iso(t),
        expires_at: iso(t + config.pendingTtlMin * MIN),
        payment_id: null,
      };
      tx.create(ref, r);
      tx.update(space.ref, { lock_version: (space.data().lock_version ?? 0) + 1 });
      return { id: ref.id, ...r };
    });
  }

  async function reservationFor(user, id) {
    const d = await col('reservations').doc(idOf(id)).get();
    if (!d.exists) fail(404, 'RESERVA_NAO_ENCONTRADA', 'Reserva não encontrada.');
    if (d.data().user_id !== user.id && user.role !== 'admin') fail(403, 'ACESSO_NEGADO', 'Acesso negado.');
    return d;
  }

  async function myReservations(user) {
    const q = await col('reservations').where('user_id', '==', user.id).get();
    return q.docs.map(view).sort(byNewest);
  }

  async function checkout(user, id) {
    const d = await reservationFor(user, id);
    const r = d.data();
    if (r.user_id !== user.id) fail(403, 'ACESSO_NEGADO', 'Acesso negado.');
    if (r.status !== 'PENDING_PAYMENT' || Date.parse(r.expires_at) <= now()) {
      fail(409, 'RESERVA_NAO_PAGAVEL', 'A reserva não está aguardando pagamento.');
    }
    if (!mp) fail(503, 'PAGAMENTO_INDISPONIVEL', 'Mercado Pago não configurado no servidor.');
    if (r.checkout_url) return { checkout_url: r.checkout_url };
    const back = (result) => `${config.baseUrl}/?reserva=${d.id}&retorno=${result}`;
    const pref = await mp.createPreference(
      {
        items: [
          {
            id: d.id,
            title: `Reserva SmartPark — ${r.parking_lot_name} (${r.code})`,
            quantity: 1,
            unit_price: r.price_estimate_cents / 100,
            currency_id: 'BRL',
          },
        ],
        external_reference: d.id,
        notification_url: `${config.baseUrl}/webhooks/mercadopago?source_news=webhooks`,
        back_urls: { success: back('sucesso'), pending: back('pendente'), failure: back('falha') },
        auto_return: 'approved',
        expires: true,
        expiration_date_to: toMpDate(r.expires_at),
        statement_descriptor: 'SMARTPARK',
      },
      `pref-${d.id}`,
    );
    await d.ref.update({ preference_id: pref.id, checkout_url: pref.init_point });
    return { checkout_url: pref.init_point };
  }

  async function cancel(user, id) {
    const d = await reservationFor(user, id);
    const t = now();
    let refundPaymentId = null;
    await db.runTransaction(async (tx) => {
      const r = (await tx.get(d.ref)).data();
      refundPaymentId = null;
      if (r.status === 'PENDING_PAYMENT') {
        tx.update(d.ref, { status: 'CANCELLED', cancelled_at: iso(t) });
        return;
      }
      if (r.status !== 'CONFIRMED') fail(409, 'NAO_CANCELAVEL', 'Esta reserva não pode mais ser cancelada.');
      const refundable = Date.parse(r.arrival_expected) - t >= config.cancelRefundMin * MIN;
      tx.update(d.ref, { status: 'CANCELLED', cancelled_at: iso(t), refund_status: refundable ? 'PENDING' : 'SEM_REEMBOLSO' });
      if (refundable) refundPaymentId = r.payment_id;
    });
    if (refundPaymentId) {
      try {
        await mp.refund(refundPaymentId, `refund-${d.id}`);
        await d.ref.update({ refund_status: 'REFUNDED' });
      } catch (e) {
        console.error('[reembolso]', e.message);
        await d.ref.update({ refund_status: 'REFUND_FAILED' });
        await alert(`refund:${d.id}`, `Falha no reembolso da reserva ${d.data().code}. Tratar manualmente no Mercado Pago.`);
      }
    }
    return view(await d.ref.get());
  }

  async function processPayment(paymentId) {
    if (!mp) fail(503, 'PAGAMENTO_INDISPONIVEL', 'Mercado Pago não configurado no servidor.');
    if (!/^\d{1,20}$/.test(paymentId)) fail(400, 'PAGAMENTO_INVALIDO', 'Identificador de pagamento inválido.');
    const p = await mp.getPayment(paymentId);
    const paid = String(p.id);
    const payRef = col('payments').doc(`mp_${paid}`);
    const resId = String(p.external_reference ?? '');
    const resRef = /^[A-Za-z0-9_-]{1,64}$/.test(resId) ? col('reservations').doc(resId) : null;
    const t = now();
    let outcome = null;
    await db.runTransaction(async (tx) => {
      outcome = null;
      const rs = resRef ? await tx.get(resRef) : null;
      const r = rs?.exists ? rs.data() : null;
      const spaceRef = r ? col('spaces').doc(r.space_id) : null;
      const space = spaceRef ? await tx.get(spaceRef) : null;
      const others = r
        ? await tx.get(col('reservations').where('space_id', '==', r.space_id).where('status', 'in', ['CONFIRMED', 'CHECKED_IN']))
        : null;
      let reconciliation = null;
      if (!r) reconciliation = 'RESERVA_INEXISTENTE';
      else if (p.status === 'approved') {
        if (['CONFIRMED', 'CHECKED_IN', 'COMPLETED'].includes(r.status)) {
          if (r.payment_id !== paid) reconciliation = 'PAGAMENTO_DUPLICADO';
        } else if (Math.round(p.transaction_amount * 100) !== r.price_estimate_cents || p.currency_id !== 'BRL') {
          reconciliation = 'VALOR_DIVERGENTE';
        } else if (r.status !== 'PENDING_PAYMENT' || Date.parse(r.expires_at) <= t) {
          reconciliation = 'RESERVA_EXPIRADA';
          if (r.status === 'PENDING_PAYMENT') {
            tx.update(resRef, { status: 'EXPIRED', expired_at: iso(t), expired_reason: 'PAGAMENTO_APOS_EXPIRACAO' });
          }
        } else if (others.docs.some((o) => o.id !== resRef.id && overlaps(o.data(), r))) {
          reconciliation = 'VAGA_INDISPONIVEL';
        } else {
          tx.update(resRef, { status: 'CONFIRMED', payment_id: paid, confirmed_at: iso(t) });
          tx.update(spaceRef, { lock_version: (space.data().lock_version ?? 0) + 1 });
          outcome = 'CONFIRMED';
        }
      } else if (['refunded', 'charged_back'].includes(p.status) && r.payment_id === paid && r.status === 'CONFIRMED') {
        tx.update(resRef, { status: 'CANCELLED', cancelled_at: iso(t), cancel_reason: p.status });
      }
      tx.set(payRef, {
        reservation_id: resId || null,
        provider: 'mercadopago',
        preference_id: r?.preference_id ?? null,
        payment_id: paid,
        status: p.status,
        status_detail: p.status_detail ?? null,
        amount: p.transaction_amount ?? null,
        currency: p.currency_id ?? null,
        verified_at: iso(t),
        reconciliation,
      });
      outcome ??= reconciliation;
    });
    if (outcome === 'CONFIRMED') {
      const r = (await resRef.get()).data();
      await notifyUser(resRef.id, r.user_id, 'CONFIRMATION', confirmationText(r));
    } else if (outcome && p.status === 'approved') {
      await alert(`recon:${paid}`, `Pagamento ${paid} aprovado exige reconciliação (${outcome}). Reserva: ${resId || '-'}. Avaliar reembolso.`);
    }
    return { status: p.status, outcome };
  }

  async function access(device, body) {
    const t = now();
    const eventId = String(body?.event_id ?? '');
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(eventId)) fail(400, 'EVENTO_INVALIDO', 'event_id inválido.');
    const type = body?.type;
    if (type !== 'ENTRY' && type !== 'EXIT') fail(400, 'EVENTO_INVALIDO', 'type deve ser ENTRY ou EXIT.');
    const code = String(body?.code ?? '').trim().toUpperCase();
    const found = /^[A-Z0-9]{4,16}$/.test(code) ? (await col('reservations').where('code', '==', code).get()).docs[0] : undefined;
    const evRef = col('access_events').doc(eventId);
    let after = null;
    const response = await db.runTransaction(async (tx) => {
      after = null;
      const ev = await tx.get(evRef);
      if (ev.exists) {
        if (ev.data().device_id !== device.id || ev.data().type !== type) fail(409, 'EVENTO_DUPLICADO', 'event_id já utilizado.');
        return ev.data().response;
      }
      const rs = found ? await tx.get(found.ref) : null;
      const r = rs?.data();
      let reason = null;
      if (!r) reason = 'RESERVA_INEXISTENTE';
      else if (r.parking_lot_id !== device.parking_lot_id) reason = 'LOCAL_INCORRETO';
      else if (type === 'ENTRY') {
        const arrival = Date.parse(r.arrival_expected);
        const latest = Math.min(arrival + config.entryLateMin * MIN, Date.parse(r.departure_expected));
        if (r.status === 'PENDING_PAYMENT') reason = 'PAGAMENTO_PENDENTE';
        else if (r.status === 'CHECKED_IN') reason = 'ENTRADA_JA_REGISTRADA';
        else if (r.status !== 'CONFIRMED') reason = 'RESERVA_INVALIDA';
        else if (t < arrival - config.entryEarlyMin * MIN || t > latest) reason = 'FORA_DA_JANELA';
      } else if (r.status !== 'CHECKED_IN') reason = 'SEM_ENTRADA_ATIVA';
      const allow = !reason;
      const res = {
        event_id: eventId,
        allow,
        action: allow ? 'OPEN' : 'KEEP_CLOSED',
        message: allow ? (type === 'ENTRY' ? 'Entrada liberada' : 'Saida liberada') : (DENY_MESSAGE[reason] ?? 'Nao autorizado'),
      };
      tx.create(evRef, {
        event_id: eventId,
        reservation_id: rs?.id ?? null,
        device_id: device.id,
        parking_lot_id: device.parking_lot_id,
        type,
        timestamp: iso(t),
        result: allow ? 'ALLOWED' : 'DENIED',
        reason,
        response: res,
      });
      if (allow && type === 'ENTRY') {
        tx.update(rs.ref, { status: 'CHECKED_IN', arrival_real: iso(t), entry_event_id: eventId });
        tx.update(col('spaces').doc(r.space_id), { occupancy_state: 'OCCUPIED' });
        after = { type, id: rs.id, r };
      }
      if (allow && type === 'EXIT') {
        const { extra, final } = finalAmount(r, t, config.exitGraceMin);
        const ticket = {
          ticket_id: `SP-${r.code}`,
          reservation_id: rs.id,
          parking_lot_name: r.parking_lot_name,
          space_label: r.space_label,
          arrival_real: r.arrival_real,
          departure_real: iso(t),
          duration_minutes: Math.max(0, Math.round((t - Date.parse(r.arrival_real)) / MIN)),
          prepaid_cents: r.price_estimate_cents,
          extra_cents: extra,
          final_amount_cents: final,
          payment_status: extra ? 'APROVADO_COM_EXCEDENTE_PENDENTE' : 'APROVADO',
          telegram_status: 'PENDING',
          created_at: iso(t),
        };
        tx.update(rs.ref, { status: 'COMPLETED', departure_real: iso(t), exit_event_id: eventId, final_amount_cents: final });
        tx.update(col('spaces').doc(r.space_id), { occupancy_state: 'FREE' });
        tx.create(col('tickets').doc(rs.id), ticket);
        after = { type, id: rs.id, r, ticket };
      }
      return res;
    });
    try {
      if (after?.type === 'ENTRY') await notifyUser(after.id, after.r.user_id, 'ENTRY', entryText(after.r, t));
      if (after?.type === 'EXIT') {
        await notifyUser(after.id, after.r.user_id, 'TICKET', ticketText(after.ticket));
        if (after.ticket.extra_cents) {
          await alert(`excedente:${after.id}`, `Reserva ${after.r.code} saiu com excedente pendente de ${money(after.ticket.extra_cents)}.`);
        }
      }
    } catch (e) {
      console.error('[notificacao]', e.message);
    }
    return response;
  }

  async function telemetry(device, body) {
    const t = now();
    const num = (v) => (v == null ? null : Number.isFinite(v) && v >= 0 && v <= 1000 ? v : fail(400, 'TELEMETRIA_INVALIDA', 'Distância inválida.'));
    if (!DEVICE_STATES.includes(body?.state)) fail(400, 'TELEMETRIA_INVALIDA', 'state inválido.');
    if (body.gate !== 'OPEN' && body.gate !== 'CLOSED') fail(400, 'TELEMETRIA_INVALIDA', 'gate deve ser OPEN ou CLOSED.');
    if (body.alert != null && !DEVICE_ALERTS.includes(body.alert)) fail(400, 'TELEMETRIA_INVALIDA', 'alert inválido.');
    await col('devices').doc(device.id).update({
      last_seen: iso(t),
      status: 'ONLINE',
      state: body.state,
      gate: body.gate,
      entry_cm: num(body.entry_cm),
      exit_cm: num(body.exit_cm),
      firmware_version: String(body.firmware_version ?? '').slice(0, 20),
    });
    const bucket = Math.floor(t / (10 * MIN));
    const unexpectedGate = body.gate === 'OPEN' && body.state !== 'ACESSO_LIBERADO' ? 'CANCELA_INESPERADA' : null;
    for (const a of new Set([body.alert, unexpectedGate].filter(Boolean))) {
      await alert(`${a}:${device.id}:${bucket}`, `Alerta do dispositivo ${device.id}: ${a} (estado ${body.state}).`);
    }
    return availability(device.parking_lot_id, t, t + MIN);
  }

  async function sweep() {
    const t = now();
    const [pending, confirmed] = await Promise.all(
      ['PENDING_PAYMENT', 'CONFIRMED'].map((s) => col('reservations').where('status', '==', s).get()),
    );
    for (const d of [...pending.docs, ...confirmed.docs]) {
      const r = d.data();
      const expired =
        r.status === 'PENDING_PAYMENT'
          ? Date.parse(r.expires_at) <= t
          : t > Math.min(Date.parse(r.arrival_expected) + config.entryLateMin * MIN, Date.parse(r.departure_expected));
      if (!expired) continue;
      await db.runTransaction(async (tx) => {
        if ((await tx.get(d.ref)).data().status !== r.status) return;
        tx.update(d.ref, {
          status: 'EXPIRED',
          expired_at: iso(t),
          expired_reason: r.status === 'CONFIRMED' ? 'NAO_COMPARECEU' : 'PAGAMENTO_NAO_CONFIRMADO',
        });
      });
    }
    const online = await col('devices').where('status', '==', 'ONLINE').get();
    for (const d of online.docs) {
      const last = d.data().last_seen;
      if (t - Date.parse(last) > config.deviceOfflineMin * MIN) {
        await d.ref.update({ status: 'OFFLINE' });
        await alert(`offline:${d.id}:${last}`, `Dispositivo ${d.id} sem comunicação desde ${dateTime(last)}.`);
      }
    }
    await notifier.retryPending();
  }

  async function overview() {
    const [lots, spaces, reservations, devices, alerts, payments] = await Promise.all([
      col('parking_lots').get(),
      col('spaces').get(),
      col('reservations').get(),
      col('devices').get(),
      col('notifications').where('type', '==', 'ALERT').get(),
      col('payments').get(),
    ]);
    return {
      parking_lots: lots.docs.map((d) => {
        const sp = spaces.docs
          .map(view)
          .filter((s) => s.parking_lot_id === d.id)
          .sort((x, y) => x.label.localeCompare(y.label));
        return {
          id: d.id,
          name: d.data().name,
          active: d.data().active,
          total: sp.length,
          occupied: sp.filter((s) => s.occupancy_state === 'OCCUPIED').length,
          spaces: sp.map((s) => ({ label: s.label, occupancy_state: s.occupancy_state, active: s.active })),
        };
      }),
      reservations: reservations.docs.map(view).sort(byNewest).slice(0, 100),
      devices: devices.docs.map(view),
      alerts: alerts.docs.map(view).sort(byNewest).slice(0, 50),
      reconciliations: payments.docs.map(view).filter((p) => p.reconciliation),
    };
  }

  async function createLot(body) {
    const name = String(body?.name ?? '').trim();
    const address = String(body?.address ?? '').trim();
    const lat = Number(body?.latitude);
    const lng = Number(body?.longitude);
    const rate = Number(body?.hourly_rate_cents);
    const hours = String(body?.opening_hours ?? '24h');
    const count = Number(body?.spaces);
    const prefix = String(body?.prefix ?? 'V').toUpperCase();
    if (!name || name.length > 80) fail(400, 'DADOS_INVALIDOS', 'Nome obrigatório (até 80 caracteres).');
    if (!address || address.length > 160) fail(400, 'DADOS_INVALIDOS', 'Endereço obrigatório (até 160 caracteres).');
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) fail(400, 'DADOS_INVALIDOS', 'Coordenadas inválidas.');
    if (!Number.isInteger(rate) || rate <= 0 || rate > 100_000) fail(400, 'DADOS_INVALIDOS', 'Tarifa inválida (centavos, maior que zero).');
    const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(hours);
    if (hours !== '24h' && !(m && m[1] * 60 + +m[2] < m[3] * 60 + +m[4] && +m[3] <= 23)) {
      fail(400, 'DADOS_INVALIDOS', 'Horário deve ser "24h" ou "HH:MM-HH:MM".');
    }
    if (!Number.isInteger(count) || count < 1 || count > 200) fail(400, 'DADOS_INVALIDOS', 'Quantidade de vagas entre 1 e 200.');
    if (!/^[A-Z]{1,3}$/.test(prefix)) fail(400, 'DADOS_INVALIDOS', 'Prefixo das vagas: 1 a 3 letras.');
    const lotRef = col('parking_lots').doc();
    await db.runTransaction(async (tx) => {
      tx.set(lotRef, { name, address, latitude: lat, longitude: lng, hourly_rate_cents: rate, opening_hours: hours, active: true });
      for (let i = 1; i <= count; i++) {
        const label = `${prefix}-${String(i).padStart(2, '0')}`;
        tx.set(col('spaces').doc(`${lotRef.id}-${label}`), { parking_lot_id: lotRef.id, label, active: true, occupancy_state: 'FREE' });
      }
    });
    return { id: lotRef.id, name, spaces: count };
  }

  async function createDevice(body, keyFor) {
    const deviceId = String(body?.device_id ?? '');
    if (!/^[a-z0-9-]{3,40}$/.test(deviceId)) fail(400, 'DADOS_INVALIDOS', 'device_id: 3 a 40 caracteres [a-z0-9-].');
    const lot = await activeLot(body?.parking_lot_id);
    try {
      await col('devices').doc(deviceId).create({
        device_id: deviceId,
        parking_lot_id: lot.id,
        status: 'OFFLINE',
        last_seen: null,
        firmware_version: null,
      });
    } catch (e) {
      if (isAlreadyExists(e)) fail(409, 'DISPOSITIVO_EXISTE', 'Dispositivo já cadastrado.');
      throw e;
    }
    return { device_id: deviceId, parking_lot_id: lot.id, device_key: keyFor(deviceId) };
  }

  return {
    register,
    login,
    publicUser,
    telegramLink,
    telegramUpdate,
    listLots,
    quote,
    createReservation,
    reservationFor,
    myReservations,
    checkout,
    cancel,
    processPayment,
    access,
    telemetry,
    sweep,
    overview,
    createLot,
    createDevice,
    view,
  };
}
