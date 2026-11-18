# Modelo de dados no Firestore

Todos os horários são strings ISO 8601 em UTC (`2026-11-18T12:00:00.000Z`); o fuso de exibição é America/Sao_Paulo.
Valores monetários são inteiros em **centavos** (`*_cents`) para evitar erro de arredondamento.

O navegador e o ESP32 **não acessam o Firestore**: as regras em [`firestore.rules`](../firestore.rules) negam todo
acesso direto. Só o backend (Admin SDK) lê e grava, e ele valida autenticação, autorização, preço, pagamento e acesso.

## Coleções

### `parking_lots/{id}`
| Campo | Tipo | Observação |
|---|---|---|
| name | string | exibido no mapa |
| address | string | endereço aproximado (fictício na demo) |
| latitude, longitude | number | posição do marcador |
| hourly_rate_cents | int | tarifa por hora iniciada |
| opening_hours | string | `"24h"` ou `"HH:MM-HH:MM"` (horário de São Paulo) |
| active | bool | só locais ativos aparecem no mapa |

### `spaces/{lotId}-{label}`
| Campo | Tipo | Observação |
|---|---|---|
| parking_lot_id | string | |
| label | string | ex.: `A-01` |
| active | bool | vaga fora de uso não é oferecida |
| occupancy_state | `FREE` \| `OCCUPIED` | atualizado pelos eventos de entrada/saída aprovados |
| lock_version | int | incrementado ao reservar/confirmar; força conflito entre transações concorrentes na mesma vaga |

### `reservations/{id}` (ID automático)
| Campo | Tipo | Observação |
|---|---|---|
| user_id | string | dono (ID do documento em `users`) |
| parking_lot_id, parking_lot_name | string | |
| space_id, space_label | string | vaga atribuída na criação |
| code | string | 8 caracteres; digitado na cancela; vira o ticket `SP-<code>` |
| arrival_expected, departure_expected | ISO | período reservado |
| status | ver abaixo | |
| hourly_rate_cents | int | tarifa congelada no momento da reserva |
| price_estimate_cents | int | **calculado no servidor**; valor cobrado no checkout |
| created_at, expires_at | ISO | `expires_at` = criação + 15 min (prazo para pagar) |
| preference_id, checkout_url | string | preferência do Checkout Pro |
| payment_id | string | pagamento que confirmou a reserva |
| confirmed_at, arrival_real, departure_real | ISO | |
| entry_event_id, exit_event_id | string | eventos que mudaram o estado |
| final_amount_cents | int | valor final na saída |
| cancelled_at, refund_status, expired_at, expired_reason | | cancelamento/expiração |

**Status:** `PENDING_PAYMENT → CONFIRMED → CHECKED_IN → COMPLETED`; desvios: `EXPIRED` (não pagou em 15 min,
não compareceu ou pagamento após expiração) e `CANCELLED` (pelo usuário, reembolso ou chargeback).

### `payments/mp_{payment_id}`
`reservation_id, provider ("mercadopago"), preference_id, payment_id, status, status_detail, amount, currency,
verified_at, reconciliation`. Gravado só depois de consultar o pagamento na API do Mercado Pago.
**Nenhum dado de cartão é armazenado.** `reconciliation` ≠ `null` indica pagamento aprovado que não confirmou a
reserva (`RESERVA_EXPIRADA`, `VALOR_DIVERGENTE`, `PAGAMENTO_DUPLICADO`, `VAGA_INDISPONIVEL`, `RESERVA_INEXISTENTE`).

### `access_events/{event_id}`
`event_id, reservation_id, device_id, parking_lot_id, type (ENTRY|EXIT), timestamp, result (ALLOWED|DENIED), reason, response`.
O **ID do documento é o `event_id`** gerado pelo ESP32 (`<device>-<boot>-<contador>`): reenviar o mesmo evento
devolve a resposta gravada sem criar outro registro.

### `tickets/{reservation_id}`
`ticket_id, reservation_id, parking_lot_name, space_label, arrival_real, departure_real, duration_minutes,
prepaid_cents, extra_cents, final_amount_cents, payment_status, telegram_status, created_at`.
ID = ID da reserva → no máximo **um ticket por estadia**.

### `devices/{device_id}`
`device_id, parking_lot_id, status (ONLINE|OFFLINE|DISABLED), last_seen, state, gate, entry_cm, exit_cm, firmware_version`.
**Sem segredos**: a chave do dispositivo é derivada de `DEVICE_SHARED_SECRET` no servidor e não é gravada.

### `notifications/{notification_id}`
`notification_id, reservation_id, channel ("telegram"), type (CONFIRMATION|ENTRY|TICKET|ALERT), chat_id, text,
status (PENDING|SENDING|SENT|PENDING_RETRY|FAILED|SEM_DESTINO), attempts, created_at, sent_at, last_error`.
ID determinístico (`<reserva>:TICKET`, `alert:<chave>`) impede mensagem duplicada.

### `users/{sha256(email)[0..40]}` e `telegram_links/{token}`
Usuário: `name, email, password_hash (scrypt + salt), role (driver|admin), telegram_chat_id, created_at`.
Vínculo Telegram: `user_id, expires_at` (token de uso único, 15 min).

## Índices
Todas as consultas usam apenas filtros de igualdade (`==`/`in`), atendidos pelos índices automáticos. Não há
índice composto obrigatório.

## Dados de demonstração (`npm run seed`)
| Local | Tarifa | Horário | Vagas | Dispositivo |
|---|---|---|---|---|
| SmartPark Unidade Centro (`centro`) | R$ 12,00/h | 06:00–23:00 | A-01…A-06 | `gate-centro-01` |
| SmartPark Unidade Paulista (`paulista`) | R$ 15,00/h | 24h | B-01…B-04 | `gate-paulista-01` |

Endereços fictícios. Ao terminar a prática, apague as coleções no Firebase Console (item 19 do roteiro).
