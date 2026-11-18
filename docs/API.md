# Contrato da API

Base: `APP_BASE_URL`. Corpo e respostas em JSON (limite 20 KB).
Erros: `{"error": "CODIGO", "message": "texto para o usuário"}`.

| Autenticação | Como |
|---|---|
| Motorista / operador | `Authorization: Bearer <token>` (token HMAC de 12 h devolvido no login) |
| ESP32 | `X-Device-Id: <device_id>` + `X-Device-Key: <chave do dispositivo>` |
| Webhook Mercado Pago | header `x-signature` (HMAC-SHA256 com `MERCADOPAGO_WEBHOOK_SECRET`) |
| Webhook Telegram | header `X-Telegram-Bot-Api-Secret-Token` |

Códigos HTTP: 200/201 sucesso · 400 validação · 401 sem autenticação · 403 sem permissão · 404 não encontrado ·
409 conflito (vaga ocupada, estado inválido) · 429 limite de requisições · 502/503 provedor indisponível · 500 erro interno.

## Público e motorista

| Método e rota | Proteção | Corpo / resposta |
|---|---|---|
| `GET /api/health` | — | `{ok:true}` |
| `POST /api/auth/register` | 20/min por IP | `{name,email,password}` → 201 `{token,user}` |
| `POST /api/auth/login` | 20/min por IP | `{email,password}` → `{token,user}` |
| `GET /api/me` | usuário | `{id,name,email,role,telegram_linked}` |
| `POST /api/me/telegram-link` | usuário | `{url:"https://t.me/<bot>?start=<token>"}` |
| `GET /api/parking-lots` | — | `[{id,name,address,latitude,longitude,hourly_rate_cents,opening_hours,total,free}]` (só campos públicos) |
| `GET /api/parking-lots/:id/availability?arrival=ISO&departure=ISO` | — | `{total,free,price_estimate_cents}` |
| `POST /api/reservations` | usuário | `{parking_lot_id,arrival,departure}` → 201 reserva `PENDING_PAYMENT`. Qualquer preço enviado é ignorado. 409 `SEM_VAGA`; 429 `MUITAS_PENDENTES` (máx. 3 pendentes) |
| `GET /api/reservations` | usuário | reservas do próprio usuário |
| `GET /api/reservations/:id` | dono ou operador | reserva; 403 para outro usuário |
| `POST /api/reservations/:id/checkout` | dono | `{checkout_url}` (valor vem do banco) |
| `POST /api/reservations/:id/cancel` | dono | reserva atualizada (`refund_status` quando houver) |

Exemplo — criar reserva:
```http
POST /api/reservations
Authorization: Bearer <token>

{"parking_lot_id":"centro","arrival":"2026-11-18T17:00:00.000Z","departure":"2026-11-18T19:00:00.000Z"}
```
```json
{"id":"a1b2…","code":"K7P2QX9A","status":"PENDING_PAYMENT","space_label":"A-01","price_estimate_cents":2400,
 "expires_at":"2026-11-18T12:15:00.000Z", "…": "…"}
```

## Webhooks

| Rota | Regra |
|---|---|
| `POST /webhooks/mercadopago?type=payment&data.id=<id>` | Valida `x-signature` (manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`). Assinatura inválida → 401. Depois **consulta `GET /v1/payments/<id>`** e só então altera a reserva, em transação e de forma idempotente. Tópicos diferentes de `payment` → 200 sem efeito. Erro interno → 5xx (o Mercado Pago reenvia). |
| `POST /webhooks/telegram` | Confere o secret token. Trata `/start <token>` em chat privado para vincular `chat_id` à conta. |

## IoT (ESP32)

`POST /api/iot/access-request`
```json
{"event_id":"gate-centro-01-3f9a12c0-7","type":"ENTRY","code":"K7P2QX9A"}
```
Resposta (sempre mínima):
```json
{"event_id":"gate-centro-01-3f9a12c0-7","allow":true,"action":"OPEN","message":"Entrada liberada"}
```
Negado: `allow:false`, `action:"KEEP_CLOSED"`, `message` genérica (`Nao autorizado`, `Pagto pendente`, `Fora do horario`).
O motivo detalhado fica em `access_events.reason`. Mesmo `event_id` → mesma resposta, sem novo efeito.

`POST /api/iot/telemetry` (máx. 1 a cada 5 s por dispositivo)
```json
{"state":"PRONTO","gate":"CLOSED","entry_cm":300,"exit_cm":300,"firmware_version":"1.0.0","alert":null}
```
Resposta: `{"total":6,"free":5}` (mostrado no LCD). `alert` aceita `FALHA_REDE_REPETIDA` ou `CANCELA_INESPERADA`;
cancela aberta fora de `ACESSO_LIBERADO` também gera alerta.

## Operador (`role: admin`)

| Método e rota | Uso |
|---|---|
| `GET /api/admin/overview` | ocupação por local e vaga, reservas recentes, dispositivos, alertas, reconciliações |
| `POST /api/admin/parking-lots` | `{name,address,latitude,longitude,hourly_rate_cents,opening_hours,spaces,prefix}` → 201 |
| `POST /api/admin/devices` | `{device_id,parking_lot_id}` → 201 `{device_key}` (mostrada uma vez) |
