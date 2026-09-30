// Detector de quedas baseado em CSI — regras determinísticas (sem modelo treinado).
//
// Ideia (mesma linha descrita no artigo: janela temporal + imobilidade após o impacto):
//   1. Cada pacote vira um vetor de amplitudes por subportadora, normalizado pela
//      média do pacote (remove variações de ganho/AGC do rádio).
//   2. "Índice de atividade" A(t): variabilidade temporal (desvio-padrão / média) de
//      cada subportadora numa janela curta (~0,6 s), média sobre as subportadoras.
//      Ambiente parado => A pequeno e estável; alguém se movendo => A sobe.
//   3. Calibração no início: a mediana de A com o ambiente parado é o "ruído base".
//      Todos os limiares são múltiplos dele, então se adaptam a cada sala/posição.
//   4. Máquina de estados:
//        monitoring → motion (A > base·motionRatio)
//        motion → evaluating quando o movimento acaba E o pico recente foi forte
//                 (≥ base·impactRatio) — um "impacto";
//        evaluating → FALL se a sala fica parada por stillSec; volta a monitoring
//                 (falso alarme) se o movimento continua/retoma.
//        alert → cooldown para não repetir o alerta.
//
// Limitações conhecidas (ver README): sentar/agachar rápido pode parecer queda; quedas
// lentas geram pico pequeno; os limiares padrão são um ponto de partida e devem ser
// ajustados com o hardware real (use --verbose e --record).

export const DEFAULTS = {
  windowSec: 0.6, // janela do desvio-padrão por subportadora
  smoothAlpha: 0.25, // suavização exponencial de A (por pacote)
  calibrationSec: 8, // ambiente parado no início
  motionRatio: 2.5, // A > base * motionRatio => movimento
  impactRatio: 6, // pico recente > base * impactRatio => impacto
  impactWindowSec: 2.5, // janela onde se procura o pico antes do fim do movimento
  settleSec: 0.5, // A precisa ficar abaixo do limiar de movimento por isso p/ o movimento "acabar"
  stillSec: 3, // imobilidade exigida após o impacto
  resumeSec: 1.0, // movimento acumulado durante a avaliação que cancela (falso alarme)
  cooldownSec: 20, // silêncio após um alerta
  minBaseline: 0.004, // piso do ruído base (sala "perfeita" não pode gerar limiar ~0)
  baselineAdapt: 0.0005, // deriva lenta do ruído base enquanto tudo está calmo
  recalibrateAfterSec: 45, // movimento contínuo por tanto tempo => ruído base provavelmente errado
  maxGapSec: 1.0, // buraco maior entre pacotes invalida a janela
  minWindowSamples: 8,
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class FallDetector {
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...options };
    this.baseline = null;
    this.startCalibration(null);
    this.win = [];
    this.sum = null;
    this.sumSq = null;
    this.activity = 0;
    this.smoothed = null;
    this.lastT = null;
    this.pushes = 0;
    this.peaks = [];
  }

  startCalibration(t) {
    this.state = "calibrating";
    this.calStart = t;
    this.calSamples = [];
    this.moveStart = null;
    this.quietSince = null;
    this.evalStart = null;
    this.movingAcc = 0;
    this.evalPeak = 0;
  }

  clearWindow() {
    this.win = [];
    this.sum = null;
    this.sumSq = null;
    this.smoothed = null;
    this.peaks = [];
  }

  get motionThreshold() {
    return (this.baseline ?? 0) * this.cfg.motionRatio;
  }
  get impactThreshold() {
    return (this.baseline ?? 0) * this.cfg.impactRatio;
  }

  // sample: { ts (s), rssi, amps: Float64Array }. Retorna { status, events }.
  push(sample) {
    const c = this.cfg;
    const t = sample.ts;
    const events = [];

    // Buraco/recuo no tempo (perda de pacotes, ESP reiniciado): a janela deixou de ser contínua.
    if (this.lastT !== null && (t - this.lastT > c.maxGapSec || t < this.lastT)) {
      this.clearWindow();
      if (this.state === "evaluating" || this.state === "motion") {
        this.state = "monitoring";
        this.moveStart = this.quietSince = this.evalStart = null;
        this.movingAcc = 0;
      }
    }
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;

    this.updateActivity(sample, t);

    if (this.smoothed !== null && this.win.length >= c.minWindowSamples) {
      this.advance(t, dt, events);
    }

    return { status: this.status(sample.rssi), events };
  }

  updateActivity(sample, t) {
    const amps = sample.amps;
    const n = amps.length;
    let mean = 0;
    for (let k = 0; k < n; k++) mean += amps[k];
    mean /= n;
    if (!(mean > 0)) return; // pacote sem sinal

    const shape = new Float64Array(n);
    for (let k = 0; k < n; k++) shape[k] = amps[k] / mean;

    if (!this.sum || this.sum.length !== n) {
      this.sum = new Float64Array(n);
      this.sumSq = new Float64Array(n);
      this.win = [];
    }
    this.win.push({ t, shape });
    for (let k = 0; k < n; k++) {
      this.sum[k] += shape[k];
      this.sumSq[k] += shape[k] * shape[k];
    }
    while (this.win.length && this.win[0].t < t - this.cfg.windowSec) {
      const old = this.win.shift().shape;
      for (let k = 0; k < n; k++) {
        this.sum[k] -= old[k];
        this.sumSq[k] -= old[k] * old[k];
      }
    }
    // Evita deriva numérica acumulada em execuções longas.
    if (++this.pushes % 5000 === 0) this.recomputeSums(n);

    const m = this.win.length;
    if (m < this.cfg.minWindowSamples) return;
    let total = 0;
    for (let k = 0; k < n; k++) {
      const mu = this.sum[k] / m;
      const variance = Math.max(0, this.sumSq[k] / m - mu * mu);
      total += Math.sqrt(variance) / (mu || 1);
    }
    this.activity = total / n;
    this.smoothed =
      this.smoothed === null ? this.activity : this.smoothed + this.cfg.smoothAlpha * (this.activity - this.smoothed);
  }

  recomputeSums(n) {
    this.sum.fill(0);
    this.sumSq.fill(0);
    for (const { shape } of this.win) {
      for (let k = 0; k < n; k++) {
        this.sum[k] += shape[k];
        this.sumSq[k] += shape[k] * shape[k];
      }
    }
  }

  advance(t, dt, events) {
    const c = this.cfg;
    const a = this.smoothed;

    if (this.state === "calibrating") {
      if (this.calStart === null) this.calStart = t;
      this.calSamples.push(a);
      if (t - this.calStart >= c.calibrationSec && this.calSamples.length >= 20) {
        this.baseline = Math.max(median(this.calSamples), c.minBaseline);
        this.state = "monitoring";
        this.peaks = [];
        events.push({ kind: "calibrated", baseline: this.baseline });
      }
      return;
    }

    // Pico recente de A (para julgar o "impacto" quando o movimento terminar).
    this.peaks.push({ t, a });
    while (this.peaks.length && this.peaks[0].t < t - c.impactWindowSec) this.peaks.shift();

    const moving = a > this.motionThreshold;

    switch (this.state) {
      case "monitoring":
        if (moving) {
          this.state = "motion";
          this.moveStart = t;
          this.quietSince = null;
        } else {
          this.baseline = Math.max(c.minBaseline, this.baseline + c.baselineAdapt * (a - this.baseline));
        }
        break;

      case "motion": {
        if (moving) {
          this.quietSince = null;
          if (t - this.moveStart > c.recalibrateAfterSec) {
            this.startCalibration(t);
            events.push({ kind: "recalibrating", reason: "movimento contínuo por muito tempo" });
          }
          break;
        }
        this.quietSince ??= t;
        if (t - this.quietSince < c.settleSec) break;

        const peak = Math.max(...this.peaks.map((p) => p.a));
        const peakRatio = peak / this.baseline;
        const movementSec = this.quietSince - this.moveStart;
        if (peakRatio >= c.impactRatio) {
          this.state = "evaluating";
          this.evalStart = this.quietSince;
          this.evalPeak = peakRatio;
          this.movingAcc = 0;
          events.push({ kind: "impact", peakRatio, movementSec });
        } else {
          this.state = "monitoring";
          events.push({ kind: "movement", peakRatio, movementSec });
        }
        this.moveStart = this.quietSince = null;
        break;
      }

      case "evaluating": {
        if (moving) this.movingAcc += dt;
        if (this.movingAcc >= c.resumeSec) {
          this.state = "monitoring";
          events.push({ kind: "false_alarm", peakRatio: this.evalPeak });
          this.evalStart = null;
          break;
        }
        const stillSeconds = t - this.evalStart;
        if (stillSeconds >= c.stillSec) {
          const s = clamp((this.evalPeak - c.impactRatio) / c.impactRatio, 0, 1);
          const q = clamp(1 - this.movingAcc / c.resumeSec, 0, 1);
          events.push({
            kind: "fall",
            peakRatio: this.evalPeak,
            stillSeconds,
            // Índice heurístico (0,5–1,0): quanto o pico passou do limiar e quão parada ficou a sala.
            // NÃO é uma probabilidade calibrada.
            confidence: 0.5 + 0.25 * s + 0.25 * q,
          });
          this.state = "alert";
          this.alertUntil = t + c.cooldownSec;
          this.evalStart = null;
        }
        break;
      }

      case "alert":
        if (t >= this.alertUntil) {
          this.state = "monitoring";
          this.peaks = [];
        }
        break;
    }
  }

  status(rssi) {
    return {
      state: this.state,
      activity: this.smoothed ?? 0,
      baseline: this.baseline,
      ratio: this.baseline ? (this.smoothed ?? 0) / this.baseline : null,
      rssi,
    };
  }
}
