# Guia da demonstração

Roteiro para montar, ajustar e apresentar o protótipo com **2 ESP32 + 1 notebook**.

> **Antes de tudo (véspera):** os dois sketches **compilam sem erros nem avisos** com `arduino-cli` no core
> esp32 **2.0.17** e **3.3.12** (placa `esp32:esp32:esp32`), mas **ainda não foram testados em hardware**.
> O código do notebook e a integração com o site foram testados com CSI simulado. Reserve tempo para
> gravar os ESP32 e ajustar os limiares no local.

## 0. Checklist do dia

- [ ] 2 ESP32 gravados (transmissor e receptor) — marque um deles com fita ("TX"/"RX").
- [ ] 2 cabos USB **de dados** (alguns cabos só carregam) + fonte/power bank para o TX.
- [ ] Notebook com Node.js ≥ 18 (`node -v`) e `git`. Sem internet na faculdade? Tudo roda local: instale as dependências **antes** (`npm install` nos dois repositórios).
- [ ] Driver da placa instalado (Gerenciador de Dispositivos → "Portas (COM e LPT)" mostra a placa).
- [ ] `senior-care/.env` criado (copie de `.env.example`; `NEXTAUTH_SECRET` qualquer string longa).
- [ ] `npm run db:seed` executado e a **apiKey** colada em `bridge/.env`.
- [ ] Navegador logado no dashboard, alarme sonoro ativado (1 clique em "Ativar alarme sonoro" — navegadores exigem interação) e volume do notebook ligado.
- [ ] Colchão/almofadas para a queda simulada. **Ninguém deve se machucar por causa de uma demo.**
- [ ] Plano B testado: `npm run simulate` na ponte (avise a banca que é simulação).

## 1. Montagem física

```
   [ESP32 TX]  ~~~~ área monitorada ~~~~  [ESP32 RX] ──USB──> [Notebook]
    (power bank)     (pessoa se move aqui)
```

- Distância: comece com **2–4 m**, módulos à **altura da cintura/peito** (mesa, tripé, cadeira), linha de visada livre.
- O transmissor precisa estar ligado **antes** do receptor (o receptor procura a rede `ESP_Radar`).
- Afaste os módulos de metal grande, micro-ondas e roteadores. Se a sala tiver muito Wi-Fi em 2,4 GHz, troque `AP_CHANNEL` nos **dois** sketches (1, 6 ou 11).

## 2. Ordem de inicialização

1. Ligue o TX (ESP32 #1). Serial Monitor (115200): `AP 'ESP_Radar' no canal 6`.
2. Ligue o RX (ESP32 #2) no notebook. Serial Monitor (921600): `[RX] conectado!` e linhas `CSI,...`.
   **Feche o Serial Monitor** antes de rodar a ponte — só um programa pode usar a porta.
3. `senior-care`: `npm run dev`. Abra `http://localhost:3000` (a porta aparece no terminal; se a 3000 estiver ocupada, o Next usa 3001 — ajuste `NEXTAUTH_URL` no `.env` e `SENIORCARE_URL` na ponte).
4. `bridge`: `npm start`. Aguarde `Calibração concluída`. **Durante os 8 s de calibração, a área entre os módulos deve estar parada.**
5. No dashboard, o card "Status do Dispositivo" deve mostrar **Conectado**, o estado *Monitorando* e o gráfico de atividade.

## 3. Ajuste fino (o passo mais importante)

Os limiares padrão vêm de simulação; com sinal real precisam de ajuste. Rode com `--verbose`:

```bash
npm start -- --verbose
```

Uma linha por segundo:

```
[monitoring ] pacotes/s= 49  atividade=0.0210  ruído-base=0.0193  (1.1×)  rssi=-47
```

- **`pacotes/s`** deve ficar perto de 50. Muito menor (< 20) ⇒ problema de Wi-Fi/canal/cabo (veja Troubleshooting).
- **Parado**: a razão `(x×)` deve ficar em ~1×. Se oscilar acima de 2×, o ambiente está ruidoso (alguém se mexendo, ventilador, interferência).
- **Caminhando entre os módulos**: anote a razão típica (ex.: 3–5×).
- **Cair sobre o colchão**: anote o pico (a ponte imprime `Possível impacto (pico N×)`).

Regra prática: `--impact-ratio` entre o pico da caminhada/sentar e o pico da queda.

```bash
npm start -- --motion-ratio 2 --impact-ratio 5 --still-sec 3
```

| Sintoma | Ajuste |
|---|---|
| Aparece "Possível impacto" e logo "falso alarme" numa queda real | a pessoa ainda se mexeu (≥ 1 s) durante a avaliação: fique imóvel após cair, ou aumente `--motion-ratio` (ex.: 3) para tolerar movimento residual |
| Queda real não gera nem "Possível impacto" | pico abaixo do limiar: **reduza `--impact-ratio`** (ex.: 4) |
| Andar/sentar gera queda | **aumente `--impact-ratio`** (ex.: 8) ou `--still-sec` (ex.: 4) |
| "Recalibrando (movimento contínuo…)" | havia movimento na calibração; reinicie a ponte com o ambiente parado |
| Alerta demora | reduza `--still-sec` (mín. razoável ~2 s) |

## 4. Roteiro sugerido de apresentação (~5 min)

1. **Problema** (PIT §1): quedas sem socorro em idosos que moram sozinhos; câmeras e wearables têm problemas de privacidade/aceitação.
2. **Solução**: mostre os dois ESP32 — "Wi-Fi como radar", sem câmera.
3. **Site**: dashboard "Monitorando", gráfico de atividade reagindo quando alguém anda.
4. **Demo**: uma pessoa caminha (atividade sobe, **sem** alerta) → queda controlada sobre colchão → fica imóvel → banner vermelho + alarme + evento no histórico.
5. **Resolver** o alerta no site ("Marcar como resolvido").
6. **Honestidade técnica** (a banca valoriza): regras calibradas no local, sem ML treinado ainda, falsos positivos ao sentar rápido, quedas lentas podem passar, precisa de recalibração se mudar o ambiente, LGPD (dados de saúde/comportamento).
7. **Próximos passos**: dataset rotulado → Random Forest/SVM/DL, MQTT, notificações, multi-cômodo.

Botão **"Testar alerta (queda simulada)"** no card do dispositivo gera uma queda marcada como `[TESTE]` — útil para mostrar a tela/som sem depender do sinal (deixe claro que é teste).

## 5. Troubleshooting

| Problema | Causa provável / solução |
|---|---|
| `Nenhum ESP32 encontrado na USB` | Cabo só de carga, driver ausente, ou placa não é CP210x/CH340. Rode `node src/index.js --list-ports` e passe `--port COMx`. |
| `Opening COMx: Access denied` | Serial Monitor/Arduino IDE ainda aberto. Feche. |
| Linhas ilegíveis no Serial Monitor | Baud errado: o receptor usa **921600**, o transmissor **115200**. |
| Receptor não conecta (`[RX] sem resposta`) | TX desligado, SSID/senha/canal diferentes entre os sketches, ou TX muito longe. |
| Ponte: "Serial conectada, mas nenhum pacote CSI" | RX conectou mas não recebe ecos: TX precisa mostrar `receptores conectados: 1`. Reinicie o RX. |
| `pacotes/s` baixo ou zero | Canal congestionado (troque `AP_CHANNEL`), distância excessiva, cabo USB ruim. |
| Erro de compilação no `csi_receiver` | Confirme a placa **ESP32 Dev Module** (não S3/C3/C6 — o sketch avisa com `#error`) e o pacote esp32 2.0.17 ou 3.3.x (as versões testadas). |
| `pacotes/s` = 0 mas o receptor conectou | O TX precisa mostrar `receptores conectados: 1` e `ecos/s ≈ 50`. No `STATUS` do receptor, o 5º campo (ignorados 802.11b) crescendo com o 3º campo em 0 indica que o transmissor está respondendo a 1 Mbps (sem CSI): reinicie os dois ESP32 e aproxime-os. |
| `401 Não autorizado` na ponte | `SENIORCARE_API_KEY` errada/antiga. Rode `npm run db:seed` de novo (gera nova chave) e atualize `bridge/.env`. |
| `sem conexão com o site` | `npm run dev` não está rodando, ou porta diferente em `SENIORCARE_URL`. A ponte guarda o alerta e reenvia sozinha. |
| Dashboard mostra "Offline" | Ponte parada, ou sem pacotes CSI (>15 s sem heartbeat). |
| Sem som no alarme | Clique em "Ativar alarme sonoro" (o navegador bloqueia áudio sem clique) e cheque o volume. |
| `npm install` avisa "allow-scripts" (npm recente) | O `serialport` já traz binários prontos; se `--list-ports` funciona, ignore. Senão: `npm approve-scripts`. |

## 6. Mensagens de LED (receptor)

- LED aceso/apagado fixo: sem alerta.
- Pisca rápido por 8 s: a ponte confirmou uma queda (`ALERT` recebido pela serial).
