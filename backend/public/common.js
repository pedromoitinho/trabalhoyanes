const $ = (id) => document.getElementById(id);

const API = {
  token: () => localStorage.getItem('sp_token'),
  logout: () => localStorage.removeItem('sp_token'),
  async call(method, path, body) {
    const token = API.token();
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) API.logout();
    if (!res.ok) throw new Error(data.message || `Erro ${res.status}`);
    return data;
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dt = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const STATUS = {
  PENDING_PAYMENT: 'Aguardando pagamento',
  CONFIRMED: 'Confirmada',
  CHECKED_IN: 'Em uso',
  COMPLETED: 'Concluída',
  EXPIRED: 'Expirada',
  CANCELLED: 'Cancelada',
};

function renderLogin(box, onDone, title = 'Entrar') {
  box.innerHTML = `
    <h2>${esc(title)}</h2>
    <form>
      <label>Nome <small>(só para criar conta)</small> <input name="name" autocomplete="name"></label>
      <label>E-mail <input name="email" type="email" required autocomplete="email"></label>
      <label>Senha <input name="password" type="password" required minlength="8" autocomplete="current-password"></label>
      <div class="linha">
        <button value="login">Entrar</button>
        <button value="register" class="secundario">Criar conta</button>
      </div>
      <p class="erro" role="alert"></p>
    </form>`;
  const form = box.querySelector('form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const action = ev.submitter?.value === 'register' ? 'register' : 'login';
    try {
      const data = await API.call('POST', `/api/auth/${action}`, Object.fromEntries(new FormData(form)));
      localStorage.setItem('sp_token', data.token);
      onDone();
    } catch (e) {
      box.querySelector('.erro').textContent = e.message;
    }
  });
}
