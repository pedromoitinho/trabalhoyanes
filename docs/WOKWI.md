# Cancela simulada no Wokwi (ESP32)

Arquivos: [`wokwi/sketch.ino`](../wokwi/sketch.ino), [`wokwi/diagram.json`](../wokwi/diagram.json),
[`wokwi/libraries.txt`](../wokwi/libraries.txt).

## Montar o projeto
1. Em <https://wokwi.com/projects/new/esp32>, substitua `sketch.ino` e `diagram.json` pelos deste repositório.
2. Em *Library Manager*, adicione `LiquidCrystal I2C`, `ESP32Servo` e `ArduinoJson` (ou crie `libraries.txt` igual ao do repositório).
3. Rode **primeiro sem backend** (passo 32 do roteiro): a placa conecta no `Wokwi-GUEST`, não alcança a API e
   entra em `FALHA_REDE` com a cancela fechada (é o teste T09).
4. Exponha o backend por HTTPS (o simulador não enxerga `localhost`):
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Copie a URL `https://…trycloudflare.com` para `API_BASE` no sketch e para `APP_BASE_URL` no `.env`.
5. Gere a chave **só deste dispositivo** e cole em `DEVICE_KEY`:
   ```bash
   npm --prefix backend run device-key -- gate-centro-01
   ```
   O `DEVICE_SHARED_SECRET` nunca vai para o Wokwi. Se o projeto Wokwi for público, a chave do dispositivo fica
   visível: use-a só na demonstração e troque `DEVICE_SHARED_SECRET` depois (isso invalida as chaves antigas).
6. Salve o projeto (exige login no Wokwi) e anexe o link na entrega.

## Diagrama de ligação

| Componente | Pino do componente | ESP32 DevKit v1 |
|---|---|---|
| LCD 16x2 I2C (0x27) | SDA / SCL / VCC / GND | D21 / D22 / VIN (5 V) / GND |
| Servo (cancela) | PWM / V+ / GND | D13 / VIN / GND |
| HC-SR04 entrada | TRIG / ECHO / VCC / GND | D5 / D18 / VIN / GND |
| HC-SR04 saída | TRIG / ECHO / VCC / GND | D19 / D23 / VIN / GND |
| LED verde + 220 Ω | anodo (via resistor) / catodo | D26 / GND |
| LED vermelho + 220 Ω | anodo (via resistor) / catodo | D27 / GND |
| Botão ENTRADA (verde) | um lado / outro lado | D32 (INPUT_PULLUP) / GND |
| Botão SAIDA (azul) | um lado / outro lado | D33 (INPUT_PULLUP) / GND |
| Botão MANUT (amarelo) | um lado / outro lado | D25 (INPUT_PULLUP) / GND |

```
            +-----------------------------+
 HC-SR04 E  | D5  TRIG      D21 SDA  ---- | LCD 16x2 I2C
 (entrada)  | D18 ECHO      D22 SCL  ---- |
 HC-SR04 S  | D19 TRIG      D13 PWM  ---- | Servo (cancela)
 (saída)    | D23 ECHO      D26 -[220R]-> | LED verde  -> GND
 ENTRADA ---| D32           D27 -[220R]-> | LED vermelho -> GND
 SAIDA   ---| D33           VIN 5V ------ | VCC: LCD, servo, HC-SR04
 MANUT   ---| D25           GND --------- | GND comum
            +--- ESP32 DevKit v1 ---------+
```

### Consideração de engenharia: nível de tensão do HC-SR04
O HC-SR04 é alimentado em 5 V e devolve o **ECHO em 5 V**; os GPIOs do ESP32 suportam **3,3 V**. No Wokwi isso não
causa dano, mas numa montagem real o ECHO precisa de um divisor resistivo (ex.: 1 kΩ em série + 2 kΩ para GND →
≈3,3 V) ou conversor de nível, ou usar um sensor 3,3 V (HC-SR04P / RCWL-1601). O servo também deve ter fonte 5 V
própria com GND comum, porque o pico de corrente pode reiniciar o ESP32. O mesmo vale para o LCD I2C com pull-ups em 5 V.

## Estados do controlador

| Estado | O que faz | Sai para |
|---|---|---|
| `INICIALIZANDO` | configura pinos, LCD, servo; conecta Wi-Fi (até 15 s) e manda telemetria | `PRONTO` ou `FALHA_REDE` |
| `PRONTO` | cancela fechada; LCD mostra vagas livres; lê código no Serial e botões; telemetria a cada 30 s | `VALIDANDO`, `MANUTENCAO`, `FALHA_REDE` |
| `VALIDANDO` | envia `event_id` + código ao backend (timeout 5 s, 1 nova tentativa com o mesmo `event_id`) | `ACESSO_LIBERADO`, `ACESSO_NEGADO`, `FALHA_REDE` |
| `ACESSO_LIBERADO` | servo a 90°, LED verde; fecha após 5 s **e** com o sensor livre | `PRONTO` |
| `ACESSO_NEGADO` | cancela fechada, LED vermelho, motivo genérico no LCD por 3 s | `PRONTO` |
| `FALHA_REDE` | cancela fechada, LED vermelho piscando; **nunca libera sem o backend**; tenta reconectar a cada 6 s; ao voltar, envia alerta `FALHA_REDE_REPETIDA` se houve 3+ falhas | `PRONTO` |
| `MANUTENCAO` | ignora entrada/saída, LED vermelho, mantém telemetria | `PRONTO` (botão MANUT) |

Respostas HTTP 5xx (ex.: túnel ativo com backend parado) contam como backend indisponível → `FALHA_REDE`.

## Roteiro de teste no simulador
1. Ajuste o HC-SR04 de entrada para < 100 cm (clique no sensor e mova o controle de distância).
2. No Monitor Serial, digite o código da reserva paga (ex.: `K7P2QX9A`) e Enter.
3. Aperte ENTRADA → LCD `Entrada liberada`, LED verde, servo abre (T07). Afaste o "veículo" (> 100 cm) para fechar.
4. Repita com uma reserva não paga → `Pagto pendente`, LED vermelho (T08).
5. Pare o backend (Ctrl+C) e aperte ENTRADA → `Falha comunicacao`, cancela fechada (T09). Religue: volta a `PRONTO`.
6. Use o HC-SR04 de saída e o botão SAIDA para registrar a saída (T10); o ticket chega no Telegram.
7. Confira no painel do operador e no Firestore (`access_events`) que cada evento aparece uma única vez (passo 35).
