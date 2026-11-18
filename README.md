# SmartPark IoT

Estacionamento inteligente com reserva antecipada, pagamento digital (Mercado Pago Checkout Pro), notificações
pelo Telegram e cancela simulada em ESP32 no Wokwi. Protótipo educacional: **não controla cancela real**.

| Camada | Tecnologia | Onde |
|---|---|---|
| Interface | HTML, CSS, JavaScript, Leaflet + tiles OpenStreetMap | [`backend/public/`](backend/public) |
| Backend | Node.js 22+ com Express 5 (o roteiro aceita Flask/Node/Nest) | [`backend/src/`](backend/src) |
| Persistência | Firebase Cloud Firestore (Admin SDK) | [`docs/FIRESTORE.md`](docs/FIRESTORE.md), [`firestore.rules`](firestore.rules) |
| Pagamento | Mercado Pago Checkout Pro + webhook assinado | [`backend/src/mercadopago.js`](backend/src/mercadopago.js) |
| Notificações | Telegram Bot API | [`backend/src/telegram.js`](backend/src/telegram.js), [`backend/src/notifier.js`](backend/src/notifier.js) |
| IoT simulado | ESP32 DevKit v1 no Wokwi | [`wokwi/`](wokwi), [`docs/WOKWI.md`](docs/WOKWI.md) |

Contrato da API: [`docs/API.md`](docs/API.md) · Relatório de testes: [`docs/RELATORIO_TESTES.md`](docs/RELATORIO_TESTES.md) ·
Roteiro da apresentação: [`docs/APRESENTACAO.md`](docs/APRESENTACAO.md)

## Fluxo

```
Dashboard (Leaflet) ──HTTPS──> Express API ──Admin SDK──> Firestore
        │                          │  ▲
        └──redirect──> Mercado Pago ┘  └── webhook assinado → consulta /v1/payments → confirma reserva
ESP32/Wokwi ──HTTPS (chave do dispositivo)──> /api/iot/* ──> eventos de entrada/saída → ticket → Telegram
```

1. O dashboard lista os estacionamentos e consulta disponibilidade/preço por período (calculados no servidor).
2. O motorista (logado) reserva: o backend valida o período, escolhe uma vaga livre **em transação** e cria a
   reserva `PENDING_PAYMENT` com 15 min para pagar.
3. O backend cria a preferência do Checkout Pro (`external_reference` = ID da reserva) e devolve só a URL.
4. O Mercado Pago chama o webhook; o backend valida a assinatura, **consulta o pagamento na API** e só então
   confirma a reserva (uma única vez) e envia a confirmação no Telegram.
5. Na cancela, o motorista digita o código; o ESP32 envia `event_id` + código; o backend decide e registra.
6. Na saída, o backend grava o horário real, calcula o valor final, gera um único ticket e envia no Telegram.

## Política de tarifa — Opção A (preço fixo antecipado)

| Situação | Regra |
|---|---|
| Preço | tarifa por **hora iniciada** do período reservado (mín. 30 min, máx. 24 h, até 30 dias de antecedência) |
| Pagamento | antecipado, dentro de 15 min após criar a reserva; depois a reserva expira e a vaga é liberada |
| Entrada | de 15 min antes até 30 min depois da chegada prevista (e nunca após a saída prevista) |
| Atraso | após a tolerância de 30 min, a reserva expira como "não compareceu", **sem reembolso** |
| Saída | sempre liberada para quem entrou (não prender o veículo) |
| Permanência excedente | até 10 min além da saída prevista: grátis; depois, cada hora iniciada desde a saída prevista pela mesma tarifa. O ticket mostra o excedente como pendente e o operador recebe alerta para cobrar no balcão |
| Cancelamento | pendente: sem custo; confirmada com 60+ min de antecedência: **reembolso integral** pela API do Mercado Pago; com menos de 60 min: sem reembolso |
| Pagamento após expiração | **não confirma** a reserva; o pagamento fica com `reconciliation = RESERVA_EXPIRADA` e o operador recebe alerta para reembolsar |

Todos os prazos são configuráveis no `.env` (`PENDING_TTL_MIN`, `ENTRY_EARLY_MIN`, `ENTRY_LATE_MIN`,
`EXIT_GRACE_MIN`, `CANCEL_REFUND_MIN`).

## Regras de decisão obrigatórias (seção 12) — onde estão

| Regra | Implementação |
|---|---|
| Vaga sem duas reservas confirmadas conflitantes | `createReservation` e `processPayment` em transação; vaga escolhida tem `lock_version` atualizado (força conflito entre transações concorrentes) |
| Reserva pendente não autoriza entrada | `access`: `PENDING_PAYMENT` → negado (`Pagto pendente`) |
| Pagamento aprovado para reserva expirada | `processPayment`: reserva → `EXPIRED`, `reconciliation`, alerta ao operador; cancela não abre |
| Janela de tolerância e local/dispositivo corretos | `access`: compara `device.parking_lot_id` e janela de entrada |
| Sem duas entradas ativas | `access`: `CHECKED_IN` → negado |
| Saída repetida não gera ticket/cobrança | `access_events/{event_id}` idempotente + ticket com ID da reserva |
| Backend indisponível → cancela fechada | firmware: `FALHA_REDE`, nunca abre sem resposta `allow:true` |
| Disponibilidade recalculada | calculada a cada consulta a partir de reservas ativas; dashboard atualiza a cada 30 s; `sweep` expira pendentes/no-show a cada 60 s |

## Como rodar

Requisitos: Node.js 22.9+ (testado no 26). Na pasta `backend`:

```bash
npm install
```

```bash
cp .env.example .env
```

Preencha `SESSION_SECRET` e `DEVICE_SHARED_SECRET` (32+ caracteres; o `.env.example` mostra como gerar),
`ADMIN_EMAIL` e `ADMIN_PASSWORD`.

**Testes automatizados** (banco em memória, Mercado Pago e Telegram simulados):
```bash
npm test
```

**Demo local sem Firebase** (dados em memória, somem ao reiniciar; checkout desativado sem token):
```bash
npm run demo
```
Abra <http://localhost:3000> (motorista) e <http://localhost:3000/admin.html> (operador).

**Com Firestore** (entrega):
1. Firebase Console → criar projeto → habilitar Cloud Firestore → publicar [`firestore.rules`](firestore.rules).
2. Configurações do projeto → Contas de serviço → gerar chave privada. Guarde o JSON **fora do repositório** e
   aponte `GOOGLE_APPLICATION_CREDENTIALS` para ele; defina `FIREBASE_PROJECT_ID` e `DB_DRIVER=firestore`.
3. Popular dados de demonstração e subir:
   ```bash
   npm run seed
   ```
   ```bash
   npm start
   ```

**URL pública HTTPS** (webhooks e Wokwi não alcançam `localhost`):
```bash
cloudflared tunnel --url http://localhost:3000
```
Coloque a URL em `APP_BASE_URL`. O túnel expõe só a API (que exige autenticação nas rotas privadas); nunca exponha
o console do Firebase, arquivos de credencial ou portas administrativas.

**Mercado Pago (credenciais de teste)**
1. Painel do desenvolvedor → criar aplicação (Checkout Pro) → copiar o Access Token **de teste** para `MERCADOPAGO_ACCESS_TOKEN`.
2. Webhooks → URL `https://<túnel>/webhooks/mercadopago`, evento *Pagamentos* → copiar a assinatura secreta
   para `MERCADOPAGO_WEBHOOK_SECRET`.
3. Pague com um comprador de teste e os cartões de teste da documentação; teste aprovado, pendente, rejeitado,
   webhook repetido e pagamento após expiração (item 24). **Não use credenciais de produção** sem revisão comercial e de segurança.

**Telegram**
1. No @BotFather: `/newbot` → token em `TELEGRAM_BOT_TOKEN`, nome de usuário do bot em `TELEGRAM_BOT_USERNAME`.
2. Gere `TELEGRAM_WEBHOOK_SECRET` (letras, números, `_` e `-`) e registre o webhook:
   ```bash
   npm run telegram:webhook
   ```
3. No dashboard, "Vincular Telegram" gera um link `t.me/<bot>?start=<token>` de uso único (15 min). O `chat_id` vem
   do próprio Telegram, nunca do navegador.
4. Para alertas operacionais, coloque o `chat_id` do operador em `TELEGRAM_DEFAULT_CHAT_ID`.

**Wokwi:** veja [`docs/WOKWI.md`](docs/WOKWI.md).

## Segurança aplicada
- Segredos só em variáveis de ambiente; `.env`, JSON de conta de serviço, chaves e logs no [`.gitignore`](.gitignore).
  O teste T15 procura tokens do Mercado Pago/Telegram e chaves privadas no repositório.
- ESP32 guarda só a própria chave (`HMAC(DEVICE_SHARED_SECRET, device_id)`); nada de Mercado Pago, Firebase ou Telegram.
- Webhook do Mercado Pago com assinatura HMAC validada e estado confirmado pela API; webhook do Telegram com secret token.
- Senhas com scrypt + salt; sessão por token HMAC com expiração; o ID do usuário vem do token, não do corpo.
- Rotas privadas exigem login; operador (`role: admin`) para o painel; reserva de outro usuário → 403.
- Validação de tipos, limites e horários no servidor; preço sempre recalculado; corpo JSON limitado a 20 KB.
- Limite de requisições em login/cadastro (20/min por IP) e telemetria (1 a cada 5 s por dispositivo).
- Logs só com método, rota, status e tempo (sem query, corpo, tokens ou dados pessoais).
- Cabeçalhos CSP, `X-Frame-Options`, `nosniff`; Leaflet carregado com SRI; HTML do usuário escapado.
- Notificações com ID determinístico, tentativa reservada em transação, até 5 tentativas e estado `PENDING_RETRY`.
- Teste ≠ produção: um `.env` por ambiente com projeto Firebase, credenciais, bot e URLs próprios.

## Limitações conhecidas
- `npm run demo` usa banco em memória (perde dados ao reiniciar); a entrega deve usar o Firestore.
- O firmware usa `setInsecure()` no TLS do túnel de desenvolvimento; em produção, fixe a CA do servidor.
- O excedente na saída é registrado e alertado, mas não cobrado online (Opção A); cobrança complementar seria a Opção B.
- Limitador de requisições em memória: com várias instâncias, trocar por Redis ou pelo proxy.
- Consultas do painel varrem coleções inteiras; com volume real, paginar.

## Entregas (seção 14)

| Entrega | Situação |
|---|---|
| Link do projeto Wokwi e diagrama de ligação | código e `diagram.json` prontos e compilando no Wokwi; diagrama em [`docs/WOKWI.md`](docs/WOKWI.md). **Falta:** salvar o projeto com a conta do grupo e anexar o link |
| Código-fonte do backend e do dashboard, sem credenciais | este repositório (T15 verifica) |
| Estrutura documentada do Firestore e dados de demonstração | [`docs/FIRESTORE.md`](docs/FIRESTORE.md) + `npm run seed` |
| Mapa com 2+ estacionamentos fictícios e vagas consultáveis | seed com 2 locais e 10 vagas; painel cadastra mais |
| Fluxo de pré-agendamento e checkout de teste | implementado. **Falta:** credenciais de teste do Mercado Pago do grupo para demonstrar |
| Webhook validado e evidência do estado do pagamento | implementado e testado (T05/T06). **Falta:** prints do painel/Firestore com o pagamento de teste (sem segredos) |
| Bot Telegram com confirmação, alerta e ticket | implementado e testado (T05, T10, T12). **Falta:** criar o bot e capturar prints |
| Relatório de testes | [`docs/RELATORIO_TESTES.md`](docs/RELATORIO_TESTES.md) (automatizados preenchidos; manuais no Wokwi a preencher) |
| Apresentação técnica e reflexão individual | roteiro em [`docs/APRESENTACAO.md`](docs/APRESENTACAO.md); a reflexão é individual de cada integrante |
