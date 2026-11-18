# Roteiro da apresentação técnica (5 a 10 min)

| Tempo | Bloco | O que mostrar |
|---|---|---|
| 0:00–1:00 | Problema e solução | Reserva antecipada + pagamento online + cancela automatizada; protótipo simulado, sem cancela real |
| 1:00–2:30 | Arquitetura | Diagrama do README: dashboard → API Node/Express → Firestore; Mercado Pago → webhook; ESP32 ↔ API → Telegram. Por que a decisão fica no backend |
| 2:30–4:30 | Demo do motorista | Mapa com 2 locais (popup: tarifa e vagas livres) → período → estimativa calculada no servidor → reservar → checkout de teste → reserva confirmada só após o webhook → mensagem no Telegram |
| 4:30–6:30 | Demo da cancela (Wokwi) | Código no Monitor Serial → ENTRADA → servo abre + LED verde. Reserva não paga → LED vermelho. Parar o backend → `FALHA_REDE`, cancela fechada. SAIDA → ticket no Telegram |
| 6:30–7:30 | Painel do operador | Ocupação por vaga, dispositivos (último contato), alertas, reconciliação de pagamento |
| 7:30–9:00 | Segurança e consistência | Transação + `lock_version` contra reserva dupla; `event_id` idempotente; webhook assinado + consulta à API; chave por dispositivo; segredos fora do Git (T15); `npm test` com 19 testes passando |
| 9:00–10:00 | Limites e próximos passos | Opção B (cobrança do excedente online), CA fixa no TLS do ESP32, leitor de placa/QR no lugar do Serial, divisor de tensão no ECHO do HC-SR04 real |

**Prepare antes:** backend no ar com túnel HTTPS, projeto Wokwi salvo e aberto, bot vinculado, uma reserva já paga
para a demo da cancela (o build do Wokwi pode demorar na fila), prints de reserva paga e ticket como plano B.
**Não mostrar na tela:** `.env`, tokens, painel de credenciais do Mercado Pago, JSON da conta de serviço.

## Reflexão individual (modelo — cada integrante escreve a sua)

1. Qual parte do sistema eu construí e qual decisão técnica tomei nela?
2. Uma dificuldade real que tive e como resolvi (ou o que faria diferente).
3. O que aprendi sobre integrar hardware, backend e serviços externos (pagamento, mensageria)?
4. Qual risco de segurança ou de consistência eu não tinha percebido antes desta atividade?
5. O que seria necessário para este protótipo controlar uma cancela real com segurança?
