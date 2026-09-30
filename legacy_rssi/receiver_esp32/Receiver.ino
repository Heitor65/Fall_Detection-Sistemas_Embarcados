#include <Arduino.h>
#include <WiFi.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define DEFAULT_SSID "ESP_Radar"
#define DEFAULT_PWD  "12345678"
#define LED_PIN 19

// --- PARÂMETROS DA QUEDA ---
// Quanto o sinal precisa pular (em dBm) para ser considerado um impacto
const int LIMITE_IMPACTO = 10; 
// Quanto o sinal pode variar (em dBm) para considerarmos que a pessoa está imóvel no chão
const int LIMITE_IMOBILIDADE = 3; 
// Tempo de avaliação após o impacto (em milissegundos)
const int TEMPO_AVALIACAO = 3000; 

void motion_detector(void *pvParameters) {
    int rssiAnterior = -50;
    bool possivelQueda = false;
    unsigned long tempoDoImpacto = 0;

    while (1) {
        if (WiFi.status() == WL_CONNECTED) {
            int rssiAtual = WiFi.RSSI();
            
            // Calcula a variação absoluta (Delta) do sinal
            int deltaRssi = abs(rssiAtual - rssiAnterior);

            if (!possivelQueda) {
                // ESTADO 1: Procurando por um movimento muito brusco (Impacto)
                if (deltaRssi >= LIMITE_IMPACTO) {
                    possivelQueda = true;
                    tempoDoImpacto = millis();
                    Serial.println("\n⚠️ [ALERTA] Variação brusca detectada! Avaliando imobilidade...");
                }
            } else {
                // ESTADO 2: Confirmando a queda (Imobilidade após o impacto)
                
                // Se passou o tempo de avaliação e a pessoa continuou parada
                if (millis() - tempoDoImpacto >= TEMPO_AVALIACAO) {
                    Serial.println("🚨 QUEDA CONFIRMADA! 🚨 Pessoa imóvel após impacto.");
                    digitalWrite(LED_PIN, HIGH);
                    vTaskDelay(pdMS_TO_TICKS(5000)); // Mantém o LED aceso por 5s
                    digitalWrite(LED_PIN, LOW);
                    
                    possivelQueda = false; // Reseta o sistema
                } 
                // Se a pessoa se mexer muito durante a avaliação, é alarme falso
                else if (deltaRssi > LIMITE_IMOBILIDADE) {
                    Serial.println("✅ Alarme falso. Movimento continuou (pessoa levantou ou sentou rápido).");
                    possivelQueda = false; // Reseta o sistema
                }
            }

            rssiAnterior = rssiAtual; // Atualiza para o próximo ciclo
            
        } else {
            Serial.println("Conexão perdida. Tentando reconectar...");
            digitalWrite(LED_PIN, LOW);
            possivelQueda = false;
        }
        
        // Lê o sinal 10 vezes por segundo (100ms) para captar a rapidez da queda
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n--- Iniciando Detector de Quedas (RSSI) ---");

    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);

    WiFi.mode(WIFI_STA);
    WiFi.begin(DEFAULT_SSID, DEFAULT_PWD);

    Serial.print("Conectando ao emissor ");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nConectado com sucesso!");

    // Inicia a task com prioridade alta
    xTaskCreate(
        motion_detector,
        "motion_detector",
        2048,
        NULL,
        5,
        NULL
    );
}

void loop() {
    vTaskDelay(pdMS_TO_TICKS(1000));
}