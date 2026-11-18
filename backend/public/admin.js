const table = (headers, rows) =>
  rows.length
    ? `<div class="tabela"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`
    : '<p class="vazio">Nada por aqui.</p>';

async function refresh() {
  const o = await API.call('GET', '/api/admin/overview');
  $('ocupacao').innerHTML = o.parking_lots
    .map(
      (l) => `<div class="lote"><b>${esc(l.name)}</b> — ${l.occupied}/${l.total} ocupadas
        <div class="vagas">${l.spaces.map((s) => `<span class="vaga ${s.occupancy_state === 'OCCUPIED' ? 'ocupada' : ''}">${esc(s.label)}</span>`).join('')}</div></div>`,
    )
    .join('');
  $('alertas').innerHTML = table(
    ['Quando', 'Alerta', 'Envio Telegram'],
    o.alerts.map((a) => [dt(a.created_at), esc(a.text), esc(a.status)]),
  );
  $('reconciliacoes').innerHTML = table(
    ['Pagamento', 'Reserva', 'Status', 'Motivo', 'Verificado'],
    o.reconciliations.map((p) => [esc(p.payment_id), esc(p.reservation_id), esc(p.status), esc(p.reconciliation), dt(p.verified_at)]),
  );
  $('dispositivos').innerHTML = table(
    ['Dispositivo', 'Local', 'Status', 'Estado', 'Cancela', 'Sensores (cm)', 'Firmware', 'Último contato'],
    o.devices.map((d) => [
      esc(d.device_id),
      esc(d.parking_lot_id),
      `<span class="status s-${esc(d.status)}">${esc(d.status)}</span>`,
      esc(d.state ?? '—'),
      esc(d.gate ?? '—'),
      `${esc(d.entry_cm ?? '—')} / ${esc(d.exit_cm ?? '—')}`,
      esc(d.firmware_version ?? '—'),
      dt(d.last_seen),
    ]),
  );
  $('lista-reservas').innerHTML = table(
    ['Código', 'Local', 'Vaga', 'Chegada prevista', 'Saída prevista', 'Status', 'Valor'],
    o.reservations.map((r) => [
      esc(r.code),
      esc(r.parking_lot_name),
      esc(r.space_label),
      dt(r.arrival_expected),
      dt(r.departure_expected),
      `<span class="status s-${esc(r.status)}">${esc(STATUS[r.status] ?? r.status)}</span>`,
      money(r.final_amount_cents ?? r.price_estimate_cents),
    ]),
  );
  const sel = $('sel-lote');
  const current = sel.value;
  sel.innerHTML = o.parking_lots.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  if (current) sel.value = current;
}

async function load() {
  const box = $('login');
  if (!API.token()) return renderLogin(box, load, 'Entrar como operador');
  let me;
  try {
    me = await API.call('GET', '/api/me');
  } catch {
    return renderLogin(box, load, 'Entrar como operador');
  }
  if (me.role !== 'admin') {
    box.innerHTML = '<p class="erro">Esta conta não é de operador.</p><button id="sair" class="secundario">Sair</button>';
    $('sair').addEventListener('click', () => (API.logout(), load()));
    return;
  }
  box.innerHTML = `<p>Operador: <b>${esc(me.name)}</b> <button id="sair" class="secundario">Sair</button></p>`;
  $('sair').addEventListener('click', () => {
    API.logout();
    $('painel').hidden = true;
    load();
  });
  $('painel').hidden = false;
  await refresh();
}

$('form-local').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  try {
    const r = await API.call('POST', '/api/admin/parking-lots', {
      ...f,
      latitude: Number(f.latitude),
      longitude: Number(f.longitude),
      hourly_rate_cents: Math.round(Number(f.rate) * 100),
      spaces: Number(f.spaces),
    });
    $('msg-local').textContent = `Cadastrado: ${r.name} (${r.spaces} vagas).`;
    ev.target.reset();
    refresh();
  } catch (e) {
    $('msg-local').textContent = e.message;
  }
});

$('form-dispositivo').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await API.call('POST', '/api/admin/devices', Object.fromEntries(new FormData(ev.target)));
    $('msg-dispositivo').innerHTML = `Chave de <b>${esc(r.device_id)}</b> (copie agora para o firmware): <code>${esc(r.device_key)}</code>`;
    refresh();
  } catch (e) {
    $('msg-dispositivo').textContent = e.message;
  }
});

load().catch((e) => ($('login').textContent = e.message));
setInterval(() => !$('painel').hidden && refresh().catch(() => {}), 10_000);
