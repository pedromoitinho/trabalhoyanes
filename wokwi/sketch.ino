#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <LiquidCrystal_I2C.h>

const char* WIFI_SSID  = "Wokwi-GUEST";
const char* WIFI_PASS  = "";
const char* API_BASE   = "https://SEU-TUNEL.trycloudflare.com";
const char* DEVICE_ID  = "gate-centro-01";
const char* DEVICE_KEY = "COLE_A_CHAVE_DO_DISPOSITIVO";
const char* FIRMWARE   = "1.0.0";

const int PIN_TRIG_ENT = 5,  PIN_ECHO_ENT = 18;
const int PIN_TRIG_SAI = 19, PIN_ECHO_SAI = 23;
const int PIN_SERVO = 13;
const int PIN_LED_VERDE = 26, PIN_LED_VERMELHO = 27;
const int PIN_BTN_ENTRADA = 32, PIN_BTN_SAIDA = 33, PIN_BTN_MANUT = 25;

const int SERVO_FECHADA = 0, SERVO_ABERTA = 90;
const float DIST_VEICULO_CM = 100;
const unsigned long HTTP_TIMEOUT_MS = 5000;
const unsigned long TELEMETRIA_MS = 30000;
const unsigned long RECONEXAO_MS = 6000;
const unsigned long LIBERADO_MIN_MS = 5000;
const unsigned long NEGADO_MS = 3000;

enum Estado { INICIALIZANDO, PRONTO, VALIDANDO, ACESSO_LIBERADO, ACESSO_NEGADO, FALHA_REDE, MANUTENCAO };
const char* NOME_ESTADO[] = { "INICIALIZANDO", "PRONTO", "VALIDANDO", "ACESSO_LIBERADO", "ACESSO_NEGADO", "FALHA_REDE", "MANUTENCAO" };

LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo cancela;

Estado estado = INICIALIZANDO;
unsigned long desdeMs = 0, ultimaTelemetria = 0, ultimaReconexao = 0;
String codigo = "";
String bootId;
uint32_t contadorEventos = 0;
int falhasRede = 0;
bool cancelaAberta = false;
const char* ladoAberto = "ENTRY";
int livres = -1, total = -1;

struct Botao { int pino; bool anterior; unsigned long mudou; };
Botao btnEntrada = { PIN_BTN_ENTRADA, HIGH, 0 };
Botao btnSaida = { PIN_BTN_SAIDA, HIGH, 0 };
Botao btnManut = { PIN_BTN_MANUT, HIGH, 0 };

bool apertou(Botao& b) {
  bool atual = digitalRead(b.pino);
  if (atual != b.anterior && millis() - b.mudou > 50) {
    b.mudou = millis();
    b.anterior = atual;
    return atual == LOW;
  }
  return false;
}

float distanciaCm(int trig, int echo) {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);
  unsigned long us = pulseIn(echo, HIGH, 30000);
  return us == 0 ? 999 : us / 58.0;
}

bool veiculoEm(const char* lado) {
  return strcmp(lado, "ENTRY") == 0 ? distanciaCm(PIN_TRIG_ENT, PIN_ECHO_ENT) < DIST_VEICULO_CM
                                    : distanciaCm(PIN_TRIG_SAI, PIN_ECHO_SAI) < DIST_VEICULO_CM;
}

void mostrar(const String& l1, const String& l2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(l1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(l2.substring(0, 16));
}

void entrar(Estado novo, const String& l1, const String& l2) {
  estado = novo;
  desdeMs = millis();
  digitalWrite(PIN_LED_VERDE, novo == ACESSO_LIBERADO);
  digitalWrite(PIN_LED_VERMELHO, novo == ACESSO_NEGADO || novo == FALHA_REDE || novo == MANUTENCAO);
  cancelaAberta = (novo == ACESSO_LIBERADO);
  cancela.write(cancelaAberta ? SERVO_ABERTA : SERVO_FECHADA);
  mostrar(l1, l2);
  Serial.printf("[ESTADO] %s | %s | %s\n", NOME_ESTADO[novo], l1.c_str(), l2.c_str());
}

void telaPronto() {
  entrar(PRONTO, "SmartPark Pronto", livres >= 0 ? "Livres: " + String(livres) + "/" + String(total) : String("Codigo no Serial"));
}

int postJson(const char* rota, const String& corpo, String& resposta) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  String url = String(API_BASE) + rota;
  WiFiClientSecure tls;
  tls.setInsecure();
  WiFiClient simples;
  HTTPClient http;
  bool ok = url.startsWith("https://") ? http.begin(tls, url) : http.begin(simples, url);
  if (!ok) return -1;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int status = http.POST(corpo);
  if (status > 0) resposta = http.getString();
  http.end();
  return status;
}

bool backendIndisponivel(int status) { return status <= 0 || status >= 500; }

int enviarTelemetria(const char* alerta = nullptr) {
  JsonDocument t;
  t["state"] = NOME_ESTADO[estado];
  t["gate"] = cancelaAberta ? "OPEN" : "CLOSED";
  t["entry_cm"] = (int)distanciaCm(PIN_TRIG_ENT, PIN_ECHO_ENT);
  t["exit_cm"] = (int)distanciaCm(PIN_TRIG_SAI, PIN_ECHO_SAI);
  t["firmware_version"] = FIRMWARE;
  if (alerta) t["alert"] = alerta;
  String corpo, resposta;
  serializeJson(t, corpo);
  int status = postJson("/api/iot/telemetry", corpo, resposta);
  ultimaTelemetria = millis();
  Serial.printf("[TELEMETRIA] http=%d\n", status);
  if (status == 200) {
    JsonDocument r;
    if (!deserializeJson(r, resposta)) {
      livres = r["free"] | -1;
      total = r["total"] | -1;
    }
  }
  return status;
}

void solicitarAcesso(const char* tipo) {
  if (codigo.length() == 0) {
    entrar(ACESSO_NEGADO, "Digite o codigo", "no Monitor Serial");
    return;
  }
  if (!veiculoEm(tipo)) {
    entrar(ACESSO_NEGADO, "Sem veiculo", "diante do sensor");
    return;
  }
  String eventId = String(DEVICE_ID) + "-" + bootId + "-" + String(++contadorEventos);
  entrar(VALIDANDO, "Validando...", codigo);
  JsonDocument req;
  req["event_id"] = eventId;
  req["type"] = tipo;
  req["code"] = codigo;
  String corpo, resposta;
  serializeJson(req, corpo);
  int status = postJson("/api/iot/access-request", corpo, resposta);
  if (backendIndisponivel(status)) status = postJson("/api/iot/access-request", corpo, resposta);
  Serial.printf("[ACESSO] evento=%s tipo=%s http=%d\n", eventId.c_str(), tipo, status);
  codigo = "";
  if (backendIndisponivel(status)) {
    falhasRede++;
    entrar(FALHA_REDE, "Falha comunicacao", "Cancela fechada");
    return;
  }
  JsonDocument res;
  bool liberar = status == 200 && !deserializeJson(res, resposta) && (res["allow"] | false);
  const char* msg = res["message"] | (liberar ? "Liberado" : "Acesso negado");
  ladoAberto = tipo;
  if (liberar) entrar(ACESSO_LIBERADO, msg, "Siga em frente");
  else entrar(ACESSO_NEGADO, msg, "Cancela fechada");
}

void lerSerial() {
  while (Serial.available()) {
    String linha = Serial.readStringUntil('\n');
    linha.trim();
    linha.toUpperCase();
    if (linha.length() == 0) continue;
    codigo = linha;
    Serial.printf("[SERIAL] codigo %s recebido; aperte ENTRADA ou SAIDA\n", codigo.c_str());
    if (estado == PRONTO) mostrar("Codigo: " + codigo, "Aperte ENT/SAI");
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG_ENT, OUTPUT);
  pinMode(PIN_ECHO_ENT, INPUT);
  pinMode(PIN_TRIG_SAI, OUTPUT);
  pinMode(PIN_ECHO_SAI, INPUT);
  pinMode(PIN_LED_VERDE, OUTPUT);
  pinMode(PIN_LED_VERMELHO, OUTPUT);
  pinMode(PIN_BTN_ENTRADA, INPUT_PULLUP);
  pinMode(PIN_BTN_SAIDA, INPUT_PULLUP);
  pinMode(PIN_BTN_MANUT, INPUT_PULLUP);
  lcd.init();
  lcd.backlight();
  cancela.setPeriodHertz(50);
  cancela.attach(PIN_SERVO, 500, 2400);
  bootId = String(esp_random(), HEX);

  entrar(INICIALIZANDO, "SmartPark IoT", "Conectando WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 15000) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    entrar(FALHA_REDE, "Sem WiFi", "Cancela fechada");
    return;
  }
  Serial.printf("[WIFI] conectado, IP %s\n", WiFi.localIP().toString().c_str());
  if (backendIndisponivel(enviarTelemetria())) {
    falhasRede++;
    entrar(FALHA_REDE, "Falha comunicacao", "Cancela fechada");
  } else {
    telaPronto();
  }
}

void loop() {
  lerSerial();
  bool ent = apertou(btnEntrada), sai = apertou(btnSaida), man = apertou(btnManut);
  unsigned long agora = millis();

  switch (estado) {
    case PRONTO:
      if (man) entrar(MANUTENCAO, "EM MANUTENCAO", "Acesso suspenso");
      else if (WiFi.status() != WL_CONNECTED) entrar(FALHA_REDE, "Sem WiFi", "Cancela fechada");
      else if (ent) solicitarAcesso("ENTRY");
      else if (sai) solicitarAcesso("EXIT");
      else if (agora - ultimaTelemetria > TELEMETRIA_MS) {
        if (backendIndisponivel(enviarTelemetria())) {
          falhasRede++;
          entrar(FALHA_REDE, "Falha comunicacao", "Cancela fechada");
        } else if (codigo.length() == 0) {
          telaPronto();
        }
      }
      break;

    case ACESSO_LIBERADO:
      if (agora - desdeMs > LIBERADO_MIN_MS && !veiculoEm(ladoAberto)) telaPronto();
      break;

    case ACESSO_NEGADO:
      if (agora - desdeMs > NEGADO_MS) telaPronto();
      break;

    case FALHA_REDE:
      digitalWrite(PIN_LED_VERMELHO, (agora / 500) % 2);
      if (ent || sai) Serial.println("[FALHA_REDE] solicitacao recusada: sem validacao do backend");
      if (agora - ultimaReconexao > RECONEXAO_MS) {
        ultimaReconexao = agora;
        if (WiFi.status() != WL_CONNECTED) {
          Serial.println("[WIFI] reconectando...");
          WiFi.reconnect();
        } else if (!backendIndisponivel(enviarTelemetria(falhasRede >= 3 ? "FALHA_REDE_REPETIDA" : nullptr))) {
          Serial.printf("[REDE] backend acessivel de novo apos %d falha(s)\n", falhasRede);
          falhasRede = 0;
          telaPronto();
        } else {
          falhasRede++;
        }
      }
      break;

    case MANUTENCAO:
      if (ent || sai) Serial.println("[MANUTENCAO] solicitacao ignorada");
      if (man) telaPronto();
      else if (agora - ultimaTelemetria > TELEMETRIA_MS) enviarTelemetria();
      break;

    default:
      break;
  }
  delay(10);
}
