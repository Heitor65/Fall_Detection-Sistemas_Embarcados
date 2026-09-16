#include <ESP8266WiFi.h>

#define AP_SSID "ESP_Radar"
#define AP_PWD  "12345678"

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n--- Iniciando ESP8266 como Emissor (AP) ---");

    WiFi.mode(WIFI_AP);
    
    // Inicia a rede
    WiFi.softAP(AP_SSID, AP_PWD, 1, false, 1);

    IPAddress myIP = WiFi.softAPIP();
    Serial.print("Rede criada com sucesso! IP do AP: ");
    Serial.println(myIP);
}

void loop() {
    // Verifica quantos dispositivos (stations) estão conectados na rede do ESP8266
    int stationsConnected = WiFi.softAPgetStationNum();
    
    Serial.print("[Emissor] Emitindo sinal ('");
    Serial.print(AP_SSID);
    Serial.print("') | Dispositivos conectados: ");
    Serial.println(stationsConnected);
    
    // Aguarda 2 segundos para não flodar o monitor serial
    delay(2000);
}