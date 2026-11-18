const dtf = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const dateTime = (value) => dtf.format(new Date(value)).replace(',', '');
export const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const duration = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}min`;

export const confirmationText = (r) =>
  [
    'SMARTPARK IoT — RESERVA CONFIRMADA',
    `Código: ${r.code}`,
    `Estacionamento: ${r.parking_lot_name}`,
    `Vaga: ${r.space_label}`,
    `Período: ${dateTime(r.arrival_expected)} até ${dateTime(r.departure_expected)}`,
    `Valor: ${money(r.price_estimate_cents)}`,
    'Pagamento: aprovado',
    'Informe o código na cancela de entrada.',
  ].join('\n');

export const entryText = (r, t) =>
  ['SMARTPARK IoT — ENTRADA REGISTRADA', `Código: ${r.code}`, `Vaga: ${r.space_label}`, `Horário: ${dateTime(t)}`].join('\n');

export const ticketText = (k) =>
  [
    'SMARTPARK IoT — COMPROVANTE',
    `Ticket: ${k.ticket_id}`,
    `Estacionamento: ${k.parking_lot_name}`,
    `Vaga: ${k.space_label}`,
    `Chegada real: ${dateTime(k.arrival_real)}`,
    `Saída real: ${dateTime(k.departure_real)}`,
    `Duração: ${duration(k.duration_minutes)}`,
    `Valor final: ${money(k.final_amount_cents)}`,
    k.extra_cents
      ? `Pagamento: aprovado (${money(k.prepaid_cents)}) + excedente pendente ${money(k.extra_cents)}`
      : 'Pagamento: aprovado',
  ].join('\n');
