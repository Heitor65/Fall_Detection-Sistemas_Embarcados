# Protótipo RSSI (legado)

Primeira versão do projeto: detecção de queda pela **variação do RSSI** (potência do sinal, em dBm)
entre um emissor ESP8266 (AP) e um receptor ESP32.

Foi substituída pela versão CSI (`../firmware` + `../bridge`) porque:

- só há **ESP32** disponíveis (o emissor aqui era um ESP8266);
- o RSSI é um único número inteiro por pacote e varia bastante por multipath/interferência,
  enquanto o CSI dá amplitude/fase por subportadora (visão mais rica do canal);
- a lógica antiga rodava toda no ESP32 e não tinha caminho para enviar o alerta a lugar nenhum.

Mantido apenas como referência histórica. `receiver_esp32/Receiver.ino` e
`transmitter_esp8266/Transmitter.ino` são os arquivos originais (apenas movidos/renomeados).
