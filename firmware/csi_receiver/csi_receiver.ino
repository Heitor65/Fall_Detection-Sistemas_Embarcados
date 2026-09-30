/*
 * ESP32 #2 — RECEPTOR (cliente Wi-Fi + captura de CSI)
 *
 * Conecta na rede "ESP_Radar" criada pelo transmissor (ESP32 #1), envia um pacote UDP
 * de "sonda" ~50x por segundo e mede o CSI (Channel State Information) dos quadros de
 * resposta. Cada medida vai para o notebook pela USB, em texto:
 *
 *   CSI,<seq>,<ms>,<rssi>,<len>,<v0>,<v1>,...      (int8: imaginário, real por subportadora)
 *   STATUS,<ms>,<rssi>,<pacotes_por_s>,<descartados_fila_cheia>,<ignorados_802.11b>
 *
 * A detecção da queda NÃO acontece aqui: roda na "ponte" do notebook (fall-detection/bridge),
 * que também pode mandar comandos de volta por esta mesma serial:
 *   ALERT\n  → pisca os LEDs por 8 s (queda confirmada)
 *   CLEAR\n  → apaga o alerta
 *
 * Placa: "ESP32 Dev Module" (ESP32 clássico). Serial Monitor/ponte: 921600 baud.
 */
#include <WiFi.h>
#include <WiFiUdp.h>
#include "esp_wifi.h"

#if !defined(CONFIG_IDF_TARGET_ESP32)
#error "Este sketch é para o ESP32 clássico: o CSI de S2/S3/C3/C6 usa outra estrutura de configuração."
#endif

// Devem ser IGUAIS no transmissor.
static const char *AP_SSID = "ESP_Radar";
static const char *AP_PWD = "12345678";
static const uint8_t AP_CHANNEL = 6;
static const uint16_t UDP_PORT = 5005;

static const uint32_t SERIAL_BAUD = 921600;
static const uint32_t PROBE_INTERVAL_MS = 20;  // 50 sondas/s (=> ~50 amostras CSI/s)
static const uint8_t LED_PIN = 2;              // LED da placa
static const uint8_t EXT_LED_PIN = 19;         // LED externo (como no protótipo RSSI)
static const uint32_t ALERT_MS = 8000;

static const int CSI_BYTES = 128;  // LLTF: 64 subportadoras x (imag, real)

struct CsiSample {
  uint32_t seq;
  uint32_t ms;
  int8_t rssi;
  uint8_t len;
  int8_t data[CSI_BYTES];
};

static QueueHandle_t csiQueue;
static WiFiUDP udp;
static uint8_t apBssid[6];
static volatile bool haveBssid = false;
static volatile uint32_t seqNo = 0;
static volatile uint32_t rxCount = 0;
static volatile uint32_t dropped = 0;
static volatile uint32_t skipped11b = 0;

static uint32_t lastProbe = 0;
static uint32_t lastStatus = 0;
static uint32_t lastRxCount = 0;
static uint32_t alertUntil = 0;
static uint32_t probeSeq = 0;

// Executa na task do Wi-Fi: só copia para a fila e sai (nada de Serial aqui).
static void csiCallback(void *ctx, wifi_csi_info_t *info) {
  if (!info || !info->buf || info->len <= 0) return;
  // Só interessa o CSI dos quadros vindos do nosso transmissor.
  if (haveBssid && memcmp(info->mac, apBssid, 6) != 0) return;
  // Quadros 802.11b (DSSS/CCK: sig_mode 0 e rate 0-3, ex.: beacons a 1 Mbps) não têm
  // preâmbulo OFDM, então não trazem CSI útil.
  if (info->rx_ctrl.sig_mode == 0 && info->rx_ctrl.rate < 4) {
    skipped11b = skipped11b + 1;
    return;
  }

  CsiSample s;
  s.seq = seqNo;
  seqNo = seqNo + 1;
  s.ms = millis();
  s.rssi = info->rx_ctrl.rssi;
  s.len = info->len > CSI_BYTES ? CSI_BYTES : info->len;
  memcpy(s.data, info->buf, s.len);

  if (xQueueSend(csiQueue, &s, 0) == pdTRUE) {
    rxCount = rxCount + 1;
  } else {
    dropped = dropped + 1;
  }
}

static void setupCsi() {
  wifi_csi_config_t cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.lltf_en = true;            // preâmbulo legado: presente em todos os quadros OFDM
  cfg.htltf_en = false;          // sem HT-LTF => 128 bytes por amostra (menos tráfego na serial)
  cfg.stbc_htltf2_en = false;
  cfg.ltf_merge_en = true;
  cfg.channel_filter_en = false;  // CSI "cru", sem suavizar subportadoras vizinhas
  cfg.manu_scale = false;
  cfg.shift = 0;

  if (esp_wifi_set_csi_config(&cfg) != ESP_OK) Serial.println("[RX] ERRO: esp_wifi_set_csi_config");
  if (esp_wifi_set_csi_rx_cb(csiCallback, NULL) != ESP_OK) Serial.println("[RX] ERRO: esp_wifi_set_csi_rx_cb");
  if (esp_wifi_set_csi(true) != ESP_OK) Serial.println("[RX] ERRO: esp_wifi_set_csi");
}

static void connectWifi() {
  haveBssid = false;
  Serial.printf("[RX] conectando em '%s'", AP_SSID);
  WiFi.begin(AP_SSID, AP_PWD, AP_CHANNEL);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - start > 15000) {
      Serial.println("\n[RX] sem resposta — o transmissor está ligado? Tentando de novo…");
      WiFi.disconnect();
      delay(200);
      WiFi.begin(AP_SSID, AP_PWD, AP_CHANNEL);
      start = millis();
    }
  }
  Serial.println();
  memcpy(apBssid, WiFi.BSSID(), 6);
  haveBssid = true;
  Serial.printf("[RX] conectado! IP %s | RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
}

static void setAlert(bool on) {
  alertUntil = on ? millis() + ALERT_MS : 0;
  if (!on) {
    digitalWrite(LED_PIN, LOW);
    digitalWrite(EXT_LED_PIN, LOW);
  }
}

static void handleCommand(const String &cmd) {
  if (cmd == "ALERT") {
    setAlert(true);
    Serial.println("[RX] ALERTA recebido do notebook");
  } else if (cmd == "CLEAR") {
    setAlert(false);
  }
}

static void printSample(const CsiSample &s) {
  char line[720];
  int n = snprintf(line, sizeof(line), "CSI,%lu,%lu,%d,%u", (unsigned long)s.seq, (unsigned long)s.ms, (int)s.rssi, (unsigned)s.len);
  for (int i = 0; i < s.len && n < (int)sizeof(line) - 8; i++) {
    n += snprintf(line + n, sizeof(line) - n, ",%d", (int)s.data[i]);
  }
  line[n++] = '\n';
  Serial.write((const uint8_t *)line, n);
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(500);
  Serial.println();
  Serial.println("# ESP32 #2: RECEPTOR (CSI) — 921600 baud");

  pinMode(LED_PIN, OUTPUT);
  pinMode(EXT_LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  digitalWrite(EXT_LED_PIN, LOW);

  csiQueue = xQueueCreate(32, sizeof(CsiSample));

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem-sleep atrasaria as respostas e distorceria a taxa de amostragem
  connectWifi();
  setupCsi();
  udp.begin(UDP_PORT);  // porta de origem das sondas => os ecos voltam para cá
}

void loop() {
  uint32_t now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[RX] conexão perdida — reconectando…");
    connectWifi();
    now = millis();
  }

  // 1) sonda UDP (o eco do transmissor é o quadro cujo CSI medimos)
  if (now - lastProbe >= PROBE_INTERVAL_MS) {
    lastProbe = (now - lastProbe > 5 * PROBE_INTERVAL_MS) ? now : lastProbe + PROBE_INTERVAL_MS;
    udp.beginPacket(WiFi.gatewayIP(), UDP_PORT);
    udp.write((const uint8_t *)&probeSeq, sizeof(probeSeq));
    udp.endPacket();
    probeSeq++;
  }

  // 2) descarta os ecos (só o CSI importa, não o conteúdo)
  uint8_t sink[16];
  while (udp.parsePacket() > 0) udp.read(sink, sizeof(sink));

  // 3) envia as amostras CSI pendentes ao notebook
  CsiSample s;
  for (int i = 0; i < 8 && xQueueReceive(csiQueue, &s, 0) == pdTRUE; i++) printSample(s);

  // 4) comandos vindos do notebook
  static String cmd;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      cmd.trim();
      if (cmd.length()) handleCommand(cmd);
      cmd = "";
    } else if (cmd.length() < 32) {
      cmd += c;
    }
  }

  // 5) LEDs de alerta (pisca 4x/s) e status 1x/s
  if (alertUntil) {
    if ((int32_t)(now - alertUntil) >= 0) {
      setAlert(false);
    } else {
      bool on = (now / 125) % 2;
      digitalWrite(LED_PIN, on);
      digitalWrite(EXT_LED_PIN, on);
    }
  }
  if (now - lastStatus >= 1000) {
    lastStatus = now;
    uint32_t total = rxCount;
    Serial.printf("STATUS,%lu,%d,%lu,%lu,%lu\n", (unsigned long)now, WiFi.RSSI(), (unsigned long)(total - lastRxCount), (unsigned long)dropped,
                  (unsigned long)skipped11b);
    lastRxCount = total;
  }

  delay(1);
}
