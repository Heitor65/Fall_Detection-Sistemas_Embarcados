#!/usr/bin/env node
// Ponte do notebook: ESP32 (USB serial) → detector de quedas → SeniorCare (HTTP).
// Veja o README da raiz do repositório para o passo a passo da demo.

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FallDetector, DEFAULTS } from "./detector.js";
import { parseCsiLine, parseStatusLine } from "./csi-parser.js";
import { SeniorCareClient } from "./seniorcare-client.js";
import { SCENARIOS, generateSamples } from "./simulator.js";
import { SerialSource, listPorts } from "./serial-source.js";

const HELP = `
Uso: npm start -- [opções]

Fonte dos dados (uma delas; padrão = serial):
  --port <COMx|auto>      Porta serial do ESP32 receptor (padrão: auto-detecção)
  --baud <n>              Baud rate (padrão 921600 — igual ao firmware)
  --simulate [cenário]    CSI sintético sem hardware: ${Object.keys(SCENARIOS).join(" | ")} (padrão: demo)
  --loop                  Repete o cenário simulado indefinidamente
  --replay <arquivo>      Reprocessa uma gravação feita com --record (modo offline)
  --list-ports            Lista as portas seriais e sai

SeniorCare:
  --api-url <url>         Padrão: SENIORCARE_URL ou http://localhost:3000
  --api-key <chave>       Padrão: SENIORCARE_API_KEY
  --dry-run               Não envia nada ao site (só imprime)
  --upload                Com --replay: envia eventos ao site (por padrão replay é dry-run)

Ajuste do detector (ver bridge/src/detector.js):
  --calibration <s>  --motion-ratio <x>  --impact-ratio <x>  --still-sec <s>  --cooldown-sec <s>

Outros:
  --record <arquivo>      Grava as linhas CSI cruas (para o artigo / ajuste de limiares)
  --label <texto>         Rótulo escrito no cabeçalho da gravação (ex.: queda, caminhada)
  --speed <x>             Velocidade da simulação/replay (padrão 1 = tempo real; replay: 0 = o mais rápido)
  -v, --verbose           Uma linha de status por segundo (atividade, ruído base, limiares)
  -h, --help
`;

// ---------------------------------------------------------------- configuração

function loadDotEnv() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadDotEnv();

// `--simulate` sem valor (ou seguido de outra opção) usa o cenário "demo".
const rawArgs = process.argv.slice(2);
const simIdx = rawArgs.indexOf("--simulate");
if (simIdx !== -1 && (simIdx === rawArgs.length - 1 || rawArgs[simIdx + 1].startsWith("-"))) {
  rawArgs.splice(simIdx + 1, 0, "demo");
}

const { values: args } = parseArgs({
  args: rawArgs,
  options: {
    port: { type: "string" },
    baud: { type: "string" },
    simulate: { type: "string" },
    loop: { type: "boolean" },
    replay: { type: "string" },
    "list-ports": { type: "boolean" },
    "api-url": { type: "string" },
    "api-key": { type: "string" },
    "dry-run": { type: "boolean" },
    upload: { type: "boolean" },
    calibration: { type: "string" },
    "motion-ratio": { type: "string" },
    "impact-ratio": { type: "string" },
    "still-sec": { type: "string" },
    "cooldown-sec": { type: "string" },
    record: { type: "string" },
    label: { type: "string" },
    speed: { type: "string" },
    verbose: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
  strict: true,
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args["list-ports"]) {
  const ports = await listPorts();
  for (const p of ports) console.log(`${p.path}\t${p.manufacturer ?? ""}\t${p.vendorId ?? ""}:${p.productId ?? ""}`);
  if (!ports.length) console.log("(nenhuma porta serial encontrada)");
  process.exit(0);
}

const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Valor inválido para ${name}: ${v}`);
  return n;
};

const detectorOptions = Object.fromEntries(
  Object.entries({
    calibrationSec: num(args.calibration, "--calibration"),
    motionRatio: num(args["motion-ratio"], "--motion-ratio"),
    impactRatio: num(args["impact-ratio"], "--impact-ratio"),
    stillSec: num(args["still-sec"], "--still-sec"),
    cooldownSec: num(args["cooldown-sec"], "--cooldown-sec"),
  }).filter(([, v]) => v !== undefined)
);

const mode = args.replay ? "replay" : args.simulate !== undefined ? "simulate" : "serial";
const scenarioName = args.simulate ?? "demo";
if (args.simulate && !SCENARIOS[args.simulate]) {
  console.error(`Cenário desconhecido "${args.simulate}". Opções: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
const speed = num(args.speed, "--speed") ?? (mode === "replay" ? 0 : 1);
const dryRun = args["dry-run"] || (mode === "replay" && !args.upload);
const verbose = !!args.verbose;
const apiUrl = args["api-url"] || process.env.SENIORCARE_URL || "http://localhost:3000";
const apiKey = args["api-key"] || process.env.SENIORCARE_API_KEY || "";

if (!dryRun && !apiKey) {
  console.error(
    "Falta a chave do dispositivo. Defina SENIORCARE_API_KEY em bridge/.env (copie de .env.example),\n" +
      "passe --api-key, ou rode com --dry-run para testar sem o site."
  );
  process.exit(1);
}

// ---------------------------------------------------------------- estado

let detector = new FallDetector(detectorOptions);
const cfg = { ...DEFAULTS, ...detectorOptions };
const client = dryRun ? null : new SeniorCareClient({ baseUrl: apiUrl, apiKey });
let serial = null;
let recordStream = null;

let lastPacketWall = 0;
let everGotPackets = false;
let offlineReported = false;
let packetsThisSecond = 0;
let pps = 0;
let lastStatus = detector.status(null);
let lastState = null;
let serialConnected = false;
let lastNoCsiHint = 0;
let lastEspPps = null;

const stamp = () => new Date().toLocaleTimeString("pt-BR");
const log = (msg) => console.log(`${stamp()}  ${msg}`);

// ---------------------------------------------------------------- pipeline

function handleSample(sample) {
  lastPacketWall = Date.now();
  everGotPackets = true;
  offlineReported = false;
  packetsThisSecond++;

  const { status, events } = detector.push(sample);
  lastStatus = { ...status, rssi: sample.rssi };

  if (status.state !== lastState) {
    if (status.state === "calibrating" && lastState === null) {
      log(`Calibrando por ${cfg.calibrationSec} s — mantenha o ambiente PARADO (ninguém andando entre os ESP32).`);
    }
    lastState = status.state;
  }

  for (const ev of events) handleDetectorEvent(ev, sample);
  return status;
}

function handleDetectorEvent(ev) {
  switch (ev.kind) {
    case "calibrated":
      log(
        `Calibração concluída — ruído base ${ev.baseline.toFixed(4)} | movimento > ${detector.motionThreshold.toFixed(4)} | ` +
          `impacto > ${detector.impactThreshold.toFixed(4)}. Monitorando.`
      );
      break;
    case "recalibrating":
      log(`Recalibrando (${ev.reason}). Mantenha o ambiente parado.`);
      break;
    case "movement":
      if (verbose) log(`movimento normal (pico ${ev.peakRatio.toFixed(1)}× o ruído, ${ev.movementSec.toFixed(1)} s)`);
      break;
    case "impact":
      log(`⚠  Possível impacto (pico ${ev.peakRatio.toFixed(1)}× o ruído base) — avaliando imobilidade por ${cfg.stillSec} s…`);
      break;
    case "false_alarm":
      log("✅ Movimento retomado — falso alarme descartado.");
      break;
    case "fall":
      void reportFall(ev);
      break;
  }
}

async function reportFall(ev) {
  const detectedAt = new Date();
  log(
    `🚨 QUEDA DETECTADA — pico ${ev.peakRatio.toFixed(1)}×, imóvel ${ev.stillSeconds.toFixed(1)} s, índice ${Math.round(ev.confidence * 100)}%`
  );
  serial?.write("ALERT\n");

  if (!client) {
    log("   (dry-run: nada enviado ao SeniorCare)");
    return;
  }
  const result = await client.sendEvent({
    type: "fall_detected",
    message: "Queda detectada pelo sensor Wi-Fi — pessoa imóvel após o impacto.",
    confidence: Number(ev.confidence.toFixed(3)),
    timestamp: detectedAt.toISOString(),
    details: {
      source: "csi-bridge",
      peakRatio: Number(ev.peakRatio.toFixed(2)),
      stillSeconds: Number(ev.stillSeconds.toFixed(2)),
      baseline: Number((detector.baseline ?? 0).toFixed(5)),
    },
  });
  if (result.ok) {
    log(`   → alerta entregue ao SeniorCare em ${result.ms.toFixed(0)} ms (tentativas: ${result.attempts})`);
  } else {
    log("   → NÃO foi possível entregar o alerta ao SeniorCare (veja o erro acima).");
  }
}

// ---------------------------------------------------------------- tarefas periódicas

const tick = setInterval(() => {
  pps = packetsThisSecond;
  packetsThisSecond = 0;
  const now = Date.now();
  const silentMs = now - lastPacketWall;

  if (verbose) {
    const s = lastStatus;
    const base = s.baseline ? s.baseline.toFixed(4) : "  -  ";
    const ratio = s.ratio ? `${s.ratio.toFixed(1)}×` : "-";
    log(
      `[${s.state.padEnd(11)}] pacotes/s=${String(pps).padStart(3)}  atividade=${s.activity.toFixed(4)}  ruído-base=${base}  (${ratio})  rssi=${s.rssi ?? "-"}` +
        (lastEspPps !== null ? `  esp32-pps=${lastEspPps}` : "")
    );
  }

  if (everGotPackets && silentMs > 5000 && !offlineReported && mode !== "replay") {
    offlineReported = true;
    log("⚠  Sem pacotes CSI há 5 s — verifique os ESP32 (transmissor ligado? cabo USB?).");
    void client?.sendEvent({ type: "device_offline", message: "Sensor sem sinal — sem pacotes CSI do ESP32." });
  }
  if (mode === "serial" && serialConnected && !everGotPackets && now - lastNoCsiHint > 15000 && silentMs > 8000) {
    lastNoCsiHint = now;
    log("Serial conectada, mas nenhum pacote CSI chegou ainda. O transmissor (ESP32 #1) está ligado? O receptor conectou ao Wi-Fi 'ESP_Radar'?");
  }
  if (client && silentMs < 3000) {
    void client.heartbeat({
      state: lastStatus.state,
      activity: Number(lastStatus.activity.toFixed(5)),
      rssi: lastStatus.rssi ?? undefined,
    });
  }
}, 1000);

// ---------------------------------------------------------------- fontes de dados

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Entrega os itens respeitando o relógio (ts em segundos) na velocidade pedida;
// speed 0 = o mais rápido possível.
async function paced(iterable, getTs, onItem) {
  const wallStart = performance.now();
  let firstTs = null;
  let count = 0;
  for (const item of iterable) {
    const ts = getTs(item);
    firstTs ??= ts;
    if (speed > 0) {
      const wait = ((ts - firstTs) * 1000) / speed - (performance.now() - wallStart);
      if (wait > 2) await sleep(wait);
    } else if (++count % 2000 === 0) {
      await sleep(0); // deixa o event loop respirar em replays longos
    }
    onItem(item);
  }
}

async function runSimulation() {
  log(`Simulação "${scenarioName}" (${speed}× tempo real) — CSI sintético, sem hardware.`);
  do {
    let lastLabel = "";
    detectorReset();
    await paced(generateSamples(SCENARIOS[scenarioName]), (s) => s.ts, (s) => {
      if (s.label !== lastLabel) {
        lastLabel = s.label;
        log(`[sim ${s.ts.toFixed(0).padStart(3)} s] ${s.label}`);
      }
      handleSample(s);
    });
    // segura um instante para os últimos eventos serem enviados
    await sleep(1500);
  } while (args.loop);
}

function detectorReset() {
  // Um novo ciclo do cenário recalibra do zero (o simulador reinicia o relógio em 0).
  detector = new FallDetector(detectorOptions);
  lastState = null;
}

async function runReplay() {
  const lines = fs.readFileSync(args.replay, "utf8").split(/\r?\n/);
  const header = lines.filter((l) => l.startsWith("#")).join(" ");
  log(`Replay de ${args.replay}${header ? `  ${header}` : ""}${dryRun ? "  (dry-run)" : ""}`);
  const samples = lines.map(parseCsiLine).filter(Boolean);
  if (!samples.length) throw new Error("Nenhuma linha CSI válida no arquivo.");
  let falls = 0;
  await paced(samples, (s) => s.ts, (s) => {
    const before = detector.state;
    handleSample(s);
    if (before !== "alert" && detector.state === "alert") falls++;
  });
  log(`Replay concluído: ${samples.length} pacotes, ${falls} queda(s) detectada(s).`);
  await sleep(1000);
}

async function runSerial() {
  if (args.record) {
    recordStream = fs.createWriteStream(args.record, { flags: "a" });
    recordStream.write(`# label=${args.label ?? "sem-rotulo"} start=${new Date().toISOString()} baud=${args.baud ?? 921600}\n`);
    log(`Gravando CSI cru em ${args.record} (rótulo: ${args.label ?? "sem-rotulo"})`);
  }
  serial = new SerialSource({
    path: args.port || process.env.SERIAL_PORT || "auto",
    baud: num(args.baud, "--baud") ?? 921600,
    log: { log, error: (m) => log(m) },
    onState: (s) => {
      serialConnected = s === "connected";
    },
    onLine: (line) => {
      if (line.startsWith("CSI,")) {
        recordStream?.write(line + "\n");
        const sample = parseCsiLine(line);
        if (sample) handleSample(sample);
        return;
      }
      const status = parseStatusLine(line);
      if (status) {
        lastEspPps = status.pps;
        return;
      }
      if (line.trim()) log(`[esp32] ${line.trim()}`);
    },
  });
  await serial.start();
  log("Aguardando pacotes CSI do receptor… (Ctrl+C para sair)");
  await new Promise(() => {}); // roda até Ctrl+C
}

// ---------------------------------------------------------------- encerramento

async function shutdown(code = 0) {
  clearInterval(tick);
  if (client) {
    // dá alguns segundos para eventos pendentes saírem
    for (let i = 0; i < 30 && (client.queue.length || client.flushing); i++) await sleep(100);
  }
  await serial?.stop();
  recordStream?.end();
  process.exit(code);
}
process.on("SIGINT", () => {
  console.log("\nEncerrando…");
  void shutdown(0);
});

log(
  `Modo: ${mode}${dryRun ? " (dry-run)" : ` → ${apiUrl}`} | limiares: movimento ×${cfg.motionRatio}, impacto ×${cfg.impactRatio}, imóvel ${cfg.stillSec} s` +
    (Object.keys(detectorOptions).length ? "  [ajustados por linha de comando]" : "")
);

try {
  if (mode === "simulate") await runSimulation();
  else if (mode === "replay") await runReplay();
  else await runSerial();
  await shutdown(0);
} catch (err) {
  console.error(`\nErro: ${err.message}`);
  await shutdown(1);
}
