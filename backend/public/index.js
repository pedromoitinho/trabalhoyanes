const map = L.map('map').setView([-23.555, -46.645], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const markers = new Map();
let fitted = false;

const popupHtml = (l) => `
  <strong>${esc(l.name)}</strong><br>${esc(l.address)}<br>
  Tarifa: ${money(l.hourly_rate_cents)}/h · Horário: ${esc(l.opening_hours)}<br>
  Vagas livres agora: <b>${l.free}</b> de ${l.total}<br>
  <button type="button" data-lot="${esc(l.id)}">Reservar aqui</button>`;

async function loadLots() {
  const lots = await API.call('GET', '/api/parking-lots');
  const sel = $('lote');
  const current = sel.value;
  sel.innerHTML = lots.map((l) => `<option value="${esc(l.id)}">${esc(l.name)} — ${l.free}/${l.total} livres</option>`).join('');
  if (current) sel.value = current;
  for (const l of lots) {
    if (!markers.has(l.id)) markers.set(l.id, L.marker([l.latitude, l.longitude]).addTo(map).bindPopup(''));
    markers.get(l.id).setPopupContent(popupHtml(l));
  }
  if (!fitted && lots.length) {
    map.fitBounds(lots.map((l) => [l.latitude, l.longitude]), { padding: [60, 60], maxZoom: 15 });
    fitted = true;
  }
}

map.on('popupopen', (e) => {
  const b = e.popup.getElement().querySelector('button[data-lot]');
  b?.addEventListener('click', () => {
    $('lote').value = b.dataset.lot;
    map.closePopup();
    quote();
  });
});

const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const start = new Date(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000);
$('chegada').value = toLocalInput(start);
$('saida').value = toLocalInput(new Date(start.getTime() + 2 * 3_600_000));

function period() {
  const a = new Date($('chegada').value);
  const b = new Date($('saida').value);
  if (isNaN(a) || isNaN(b)) throw new Error('Preencha chegada e saída.');
  return { arrival: a.toISOString(), departure: b.toISOString() };
}

async function quote() {
  try {
    const q = await API.call('GET', `/api/parking-lots/${encodeURIComponent($('lote').value)}/availability?${new URLSearchParams(period())}`);
    $('cotacao').textContent = `${q.free} de ${q.total} vagas livres no período · estimativa ${money(q.price_estimate_cents)}`;
  } catch (e) {
    $('cotacao').textContent = e.message;
  }
}
$('btn-consultar').addEventListener('click', quote);

async function payReservation(id) {
  const { checkout_url } = await API.call('POST', `/api/reservations/${encodeURIComponent(id)}/checkout`);
  location.href = checkout_url;
}

$('form-reserva').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!API.token()) {
    $('cotacao').textContent = 'Entre na sua conta para reservar.';
    return;
  }
  try {
    const r = await API.call('POST', '/api/reservations', { parking_lot_id: $('lote').value, ...period() });
    $('cotacao').textContent = `Reserva ${r.code} criada (vaga ${r.space_label}, ${money(r.price_estimate_cents)}). Abrindo checkout…`;
    await payReservation(r.id);
  } catch (e) {
    $('cotacao').textContent = e.message;
    loadReservations();
    loadLots();
  }
});

async function renderAccount() {
  const box = $('conta');
  if (!API.token()) return renderLogin(box, renderAll);
  let me;
  try {
    me = await API.call('GET', '/api/me');
  } catch {
    return renderLogin(box, renderAll);
  }
  box.innerHTML = `
    <h2>Conta</h2>
    <p>Olá, <b>${esc(me.name)}</b>${me.role === 'admin' ? ' (operador)' : ''}</p>
    <p>Telegram: ${me.telegram_linked ? 'vinculado' : 'não vinculado'}</p>
    <div class="linha">
      <button id="btn-telegram" class="secundario">${me.telegram_linked ? 'Revincular' : 'Vincular'} Telegram</button>
      <button id="btn-sair" class="secundario">Sair</button>
    </div>
    <p id="tg-link"></p>`;
  $('btn-sair').addEventListener('click', () => {
    API.logout();
    renderAll();
  });
  $('btn-telegram').addEventListener('click', async () => {
    try {
      const { url } = await API.call('POST', '/api/me/telegram-link');
      $('tg-link').innerHTML = `Abra <a href="${esc(url)}" target="_blank" rel="noopener">este link</a> no Telegram e toque em <b>Iniciar</b> (válido por 15 min).`;
    } catch (e) {
      $('tg-link').textContent = e.message;
    }
  });
}

async function loadReservations() {
  const ul = $('reservas');
  if (!API.token()) {
    ul.innerHTML = '<li class="vazio">Entre para ver suas reservas.</li>';
    return;
  }
  const list = await API.call('GET', '/api/reservations').catch(() => []);
  ul.innerHTML = list.length
    ? list
        .map(
          (r) => `
      <li>
        <div><b>${esc(r.code)}</b> · ${esc(r.parking_lot_name)} · vaga ${esc(r.space_label)}</div>
        <div>${dt(r.arrival_expected)} → ${dt(r.departure_expected)}</div>
        <div><span class="status s-${esc(r.status)}">${esc(STATUS[r.status] ?? r.status)}</span>
             ${money(r.final_amount_cents ?? r.price_estimate_cents)}</div>
        <div class="linha">
          ${r.status === 'PENDING_PAYMENT' ? `<button data-pay="${esc(r.id)}">Pagar</button>` : ''}
          ${['PENDING_PAYMENT', 'CONFIRMED'].includes(r.status) ? `<button class="secundario" data-cancel="${esc(r.id)}">Cancelar</button>` : ''}
        </div>
      </li>`,
        )
        .join('')
    : '<li class="vazio">Nenhuma reserva ainda.</li>';
}

$('reservas').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.pay) await payReservation(b.dataset.pay);
    if (b.dataset.cancel && confirm('Cancelar esta reserva? Reembolso integral só com 60 min ou mais de antecedência da chegada.')) {
      await API.call('POST', `/api/reservations/${encodeURIComponent(b.dataset.cancel)}/cancel`);
      await Promise.all([loadReservations(), loadLots()]);
    }
  } catch (e) {
    alert(e.message);
  }
});

async function handleReturn() {
  const q = new URLSearchParams(location.search);
  const id = q.get('reserva');
  if (!id) return;
  history.replaceState(null, '', '/');
  const box = $('aviso');
  box.hidden = false;
  box.textContent = `Retorno do checkout (${q.get('retorno') ?? '-'}). Aguardando o servidor verificar o pagamento…`;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await API.call('GET', `/api/reservations/${encodeURIComponent(id)}`);
      if (r.status !== 'PENDING_PAYMENT') {
        box.textContent = `Reserva ${r.code}: ${STATUS[r.status] ?? r.status}.`;
        loadReservations();
        return;
      }
    } catch {}
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  box.textContent = 'Pagamento ainda não confirmado pelo servidor. A reserva só vale após a confirmação; acompanhe em "Minhas reservas".';
}

function renderAll() {
  renderAccount();
  loadReservations();
}

loadLots().catch((e) => ($('cotacao').textContent = e.message));
renderAll();
handleReturn();
setInterval(() => loadLots().catch(() => {}), 30_000);
