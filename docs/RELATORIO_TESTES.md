# Relatório de testes

**Ambiente:** Node.js 26.13, Windows 11 · `npm test` (backend/test/app.test.js) · banco Firestore em memória
(`src/memdb.js`, mesma API usada com o Firestore real), Mercado Pago e Telegram simulados, relógio controlado
(início: 18/11/2026 09:00, horário de São Paulo).
**Resultado da execução de 18/11/2026:** 19 testes, **19 aprovados, 0 falhas** (≈5,6 s).

Os testes T09 (firmware) e os passos com serviços reais (Mercado Pago de teste, bot do Telegram, Firestore real,
simulação no Wokwi) estão na seção "Testes manuais" e devem ser executados e preenchidos pelo grupo.

## Testes automatizados

| Teste | Entrada | Resultado esperado | Resultado observado |
|---|---|---|---|
| T01 Abrir dashboard | `GET /` e `GET /api/parking-lots` | Mapa carrega; marcadores com dados do projeto | ✔ HTML com Leaflet 1.9.4; 2 locais só com campos públicos (nome, endereço, coordenadas, tarifa, horário, total, livres). Verificado também no navegador: 2 marcadores e tiles OSM carregados |
| T02 Datas inválidas | saída 11:00 < chegada 12:00; chegada 08:00 (passado); `"ontem"`; 22:00–23:30 no Centro (fecha 23:00) | Backend rejeita | ✔ 400 `PERIODO_INVALIDO` / `DATA_INVALIDA` / `FORA_DO_HORARIO`; consulta de disponibilidade também 400 |
| T03 Duas pessoas, mesma vaga/horário | local com 1 vaga; Bia e Caio reservam 10:00–11:00 em paralelo | No máximo uma confirmada; conflito informado | ✔ uma 201, outra 409 `SEM_VAGA`; após pagamento, 1 reserva `CONFIRMED`; período 11:00–12:00 continua disponível |
| T04 Pagamento rejeitado | webhook de pagamento `rejected` | Reserva não confirma; entrada negada | ✔ reserva segue `PENDING_PAYMENT`; `payments.status = rejected`; cancela: `allow:false`, `Pagto pendente` |
| T05 Aprovado com webhook válido | webhook com assinatura errada, depois correta | Pagamento verificado; reserva confirmada uma vez | ✔ assinatura errada → 401 sem efeito; correta → backend consulta o pagamento, reserva `CONFIRMED`, `verified_at` gravado, 1 mensagem de confirmação no Telegram |
| T06 Mesmo webhook 2× | reenvio do webhook do pagamento aprovado (2 vezes) | Sem confirmação/cobrança duplicada | ✔ `confirmed_at` inalterado; 1 documento de pagamento; 1 mensagem de confirmação |
| T07 Entrada com reserva válida | código da reserva confirmada, `event_id` novo; reenvio do mesmo `event_id`; outro dispositivo; chave errada | Autoriza, registra evento, ocupa vaga | ✔ `allow:true, action:OPEN`; reenvio devolve a mesma resposta e 1 só evento; vaga `OCCUPIED`; dispositivo de outro local negado; chave errada → 401; 2ª entrada sem saída negada |
| T08 Entrada sem reserva paga | código pendente, código inexistente, código vazio | Cancela fechada | ✔ `allow:false, action:KEEP_CLOSED` nos 3 casos |
| T10 Registrar saída | saída 10:15 (prevista 10:10, tolerância 10 min) | Horário real salvo; duração e valor final pela regra | ✔ `COMPLETED`, `departure_real` 10:15, duração 59 min, extra R$ 0, final R$ 12,00, vaga `FREE`, ticket enviado ("Duração: 0h59min") |
| T11 Repetir saída | mesmo `event_id`; depois outro `event_id` | Sem cobrança nem ticket duplicado | ✔ mesmo evento → mesma resposta; outro evento → negado; 1 ticket, 1 mensagem, valor final inalterado |
| T12 Telegram indisponível | Telegram falhando na saída (20 min de excedente); depois volta e o `sweep` roda 2× | Ticket salvo; envio pendente para nova tentativa | ✔ ticket salvo com `telegram_status = PENDING_RETRY` (extra R$ 12,00, final R$ 24,00); após retorno: `SENT`, 1 única mensagem, 2 tentativas registradas |
| T13 Alterar preço pelo navegador | corpo com `price_estimate_cents: 1`, `price: 0.01`, `status: CONFIRMED` | Backend ignora e calcula | ✔ preço R$ 36,00 (3 horas iniciadas × R$ 12,00) e status `PENDING_PAYMENT` |
| T14 Reserva de outro usuário | Bia consulta/cancela reserva da Ana; sem token; token forjado; operador | Acesso negado sem autorização | ✔ 403 / 403 / 401 / 401; operador 200 |
| T15 Repositório Git | varredura de todos os arquivos (exceto `node_modules` e `.env`) | Nenhum token/segredo/credencial | ✔ nenhum token Mercado Pago/Telegram, chave privada ou JSON de conta de serviço; `.gitignore` cobre `.env` e `*service-account*.json` |
| Extra — RF10 painel | motorista e anônimo tentam cadastrar local; operador cadastra | Só operador | ✔ 403 / 401 / 201; overview mostra o novo local |
| Extra — vínculo Telegram | `/start` com secret errado; correto; reuso do token em outro chat | `chat_id` só via Telegram, uso único | ✔ 401; vinculado ao chat 555; reuso não troca o chat |
| Extra — regra 12.3 | pagamento aprovado 16 min após criar a reserva (TTL 15 min) | Não confirma; reconciliação | ✔ reserva `EXPIRED`, `reconciliation = RESERVA_EXPIRADA`, alerta ao operador, entrada negada |
| Extra — cancelamento | cancelar pendente; cancelar confirmada com 60+ min | Sem custo / reembolso integral | ✔ `CANCELLED`; `refund_status = REFUNDED` com chamada de reembolso ao Mercado Pago |
| Extra — telemetria e sweep | estado inválido; telemetria válida; 2ª em < 5 s; 3 min sem contato | Validação, limite, alerta offline, expiração | ✔ 400; 200 com `{total, free}`; 429; dispositivo `OFFLINE` + alerta; reserva pendente vencida → `EXPIRED` |

## Testes manuais (executar e preencher)

| Teste | Ação | Resultado esperado | Resultado observado | Correção |
|---|---|---|---|---|
| T09 Perder conexão | No Wokwi, parar o backend (ou usar `API_BASE` inválida) e apertar ENTRADA | `FALHA_REDE`, cancela fechada, LED vermelho piscando | | |
| T07/T08 no Wokwi | Entrada com reserva paga / não paga | Servo abre + LED verde / fechado + LED vermelho | | |
| T10/T11 no Wokwi | Saída e repetição | Ticket no Telegram uma vez | | |
| Passo 35 | Conferir `access_events` no Firestore | Cada `event_id` uma única vez | | |
| Mercado Pago teste | Pagar com cartão de teste aprovado / recusado / pendente | Confirma só o aprovado (via webhook) | | |
| Telegram real | Vincular conta, confirmar reserva, ticket, alerta offline | Mensagens recebidas | | |

## Problemas encontrados e correções durante o desenvolvimento

| Problema | Correção |
|---|---|
| T01 falhou na primeira execução: dashboard ainda não existia (`GET /` → 404) | Criado `public/index.html` com Leaflet; teste passou |
| Corrida: duas transações escolhendo vagas diferentes não conflitam, mas na mesma vaga poderiam gravar duas reservas (consulta não bloqueia inserções novas no Firestore) | A transação atualiza `lock_version` da vaga escolhida, forçando conflito e nova tentativa |
| Reenvio do ESP32 após timeout poderia registrar entrada duplicada | ID do documento em `access_events` = `event_id`; repetição devolve a resposta gravada |
| Envio de Telegram simultâneo (sweep + fluxo) poderia duplicar mensagem | Tentativa reservada em transação (`SENDING`) antes de chamar a API |
| `localhost` inacessível pelo Wokwi | Documentado túnel HTTPS (`cloudflared`) em `docs/WOKWI.md` |
| Firmware: validação no Wokwi | Sketch + `diagram.json` compilados no Wokwi (ESP32 core + LiquidCrystal I2C, ESP32Servo, ArduinoJson) e os 12 componentes carregados sem erro |
