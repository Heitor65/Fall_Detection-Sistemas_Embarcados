/*
 * ESP32 #1 — TRANSMISSOR (Access Point + eco UDP)
 *
 * Cria a rede Wi-Fi "ESP_Radar" e devolve (eco) cada pacote UDP que o receptor
 * (ESP32 #2) enviar. Essas respostas são os quadros Wi-Fi cujo CSI o receptor mede:
 * quando uma pessoa se move entre os dois módulos, o CSI desses quadros muda.
 *
 * Por que eco e não broadcast? Quadros broadcast saem do AP na taxa mais baixa
 * (802.11b) e não carregam CSI utilizável. Quadros unicast a um cliente usam taxas
 * OFDM/HT, que têm CSI.
 *
 * Placa: "ESP32 Dev Module" (ESP32 clássico). Alimente por USB/power bank e posicione
 * a alguns metros do receptor, com a área monitorada entre os dois.
 */
#include <WiFi.h>
#include <WiFiUdp.h>

// Devem ser IGUAIS no receptor.
static const char *AP_SSID = "ESP_Radar";
static const char *AP_PWD = "12345678";
static const uint8_t AP_CHANNEL = 6;
static const uint16_t UDP_PORT = 5005;

// LED de status: pisca quando há um receptor conectado.
static const uint8_t LED_PIN = 2;

WiFiUDP udp;
static uint32_t echoed = 0;
static uint32_t lastReport = 0;

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("--- ESP32 #1: TRANSMISSOR (AP + eco UDP) ---");

  pinMode(LED_PIN, OUTPUT);

  WiFi.mode(WIFI_AP);
  // softAP(ssid, senha, canal, oculto, max_conexoes)
  if (!WiFi.softAP(AP_SSID, AP_PWD, AP_CHANNEL, 0, 2)) {
    Serial.println("ERRO: falha ao criar o AP");
  }
  Serial.print("AP '");
  Serial.print(AP_SSID);
  Serial.print("' no canal ");
  Serial.print(AP_CHANNEL);
  Serial.print(" — IP ");
  Serial.println(WiFi.softAPIP());

  udp.begin(UDP_PORT);
}

void loop() {
  int size = udp.parsePacket();
  if (size > 0) {
    uint8_t buf[64];
    int n = udp.read(buf, sizeof(buf));
    if (n > 0) {
      // devolve o mesmo conteúdo ao remetente (unicast)
      udp.beginPacket(udp.remoteIP(), udp.remotePort());
      udp.write(buf, n);
      udp.endPacket();
      echoed++;
    }
  } else {
    delay(1);
  }

  uint32_t now = millis();
  if (now - lastReport >= 2000) {
    uint32_t elapsed = now - lastReport;
    lastReport = now;
    int stations = WiFi.softAPgetStationNum();
    digitalWrite(LED_PIN, stations > 0 ? HIGH : LOW);
    Serial.printf("[TX] receptores conectados: %d | ecos/s: %u\n", stations, (unsigned)(echoed * 1000UL / elapsed));
    echoed = 0;
  }
}
