// Gerador de CSI sintético — serve para (1) testar o detector sem hardware,
// (2) ensaiar a demo e (3) ter um plano B se um ESP32 falhar na apresentação.
//
// É um modelo simplificado, NÃO física real: cada subportadora tem uma amplitude base
// (multipath estático) com ruído pequeno; movimento soma perturbações aleatórias
// por subportadora proporcionais a um "nível de movimento" ao longo do tempo.
// Os resultados com CSI real vão diferir — os limiares precisam ser ajustados no local.

const N_SUBCARRIERS = 52; // as mesmas 52 subportadoras úteis do LLTF

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cenário = lista de segmentos { sec, level, label }, level = intensidade do movimento
// (0 = sala parada; 1 ≈ caminhada; 3–4 ≈ impacto de queda).
export const SCENARIOS = {
  // Ensaio completo: calibração → caminhar → sentar → parada → queda → imóvel → levanta → queda → imóvel
  demo: [
    { sec: 10, level: 0, label: "calibração (sala parada)" },
    { sec: 8, level: 1, label: "caminhando" },
    { sec: 4, level: 0, label: "parado" },
    { sec: 1.2, level: 1.1, label: "sentando" },
    { sec: 8, level: 0, label: "sentado" },
    { sec: 0.7, level: 3.6, label: "QUEDA (impacto)" },
    { sec: 12, level: 0, label: "imóvel no chão" },
    { sec: 2, level: 1, label: "levantando" },
    { sec: 8, level: 0, label: "parado" },
  ],
  // Só atividade normal: NÃO deve gerar alerta.
  walk: [
    { sec: 10, level: 0, label: "calibração" },
    { sec: 15, level: 1, label: "caminhando" },
    { sec: 6, level: 0, label: "parado" },
    { sec: 1.2, level: 1.1, label: "sentando" },
    { sec: 8, level: 0, label: "sentado" },
  ],
  // Queda seguida de imobilidade: deve gerar exatamente 1 alerta.
  fall: [
    { sec: 10, level: 0, label: "calibração" },
    { sec: 5, level: 1, label: "caminhando" },
    { sec: 0.7, level: 3.6, label: "QUEDA (impacto)" },
    { sec: 12, level: 0, label: "imóvel no chão" },
  ],
  // Impacto forte, pausa curta, e a pessoa volta a se mover: falso alarme, sem alerta.
  stumble: [
    { sec: 10, level: 0, label: "calibração" },
    { sec: 5, level: 1, label: "caminhando" },
    { sec: 0.7, level: 3.6, label: "tropeço" },
    { sec: 1.5, level: 0, label: "pausa curta" },
    { sec: 8, level: 1, label: "recuperou e segue andando" },
    { sec: 5, level: 0, label: "parado" },
  ],
};

export function scenarioDuration(scenario) {
  return scenario.reduce((s, seg) => s + seg.sec, 0);
}

// Gera amostras { seq, ts, rssi, amps, label } na taxa dada. Determinístico por seed.
export function* generateSamples(scenario, { rate = 50, seed = 1 } = {}) {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const base = Array.from({ length: N_SUBCARRIERS }, () => 25 + rnd() * 35);
  const SIGMA_STILL = 0.02;
  const SIGMA_MOVE = 0.08;

  let seq = 0;
  let t = 0;
  for (const seg of scenario) {
    const n = Math.round(seg.sec * rate);
    for (let i = 0; i < n; i++, seq++, t = seq / rate) {
      // Impactos decaem rapidamente; movimento normal é sustentado com leve variação.
      const progress = i / Math.max(1, n - 1);
      const envelope = seg.level >= 2 ? Math.exp(-2.5 * progress) : 1;
      const level = seg.level * envelope * (0.85 + 0.3 * rnd());
      const agc = 1 + 0.05 * gauss(); // ganho do rádio varia pacote a pacote
      const amps = new Float64Array(N_SUBCARRIERS);
      for (let k = 0; k < N_SUBCARRIERS; k++) {
        const factor = 1 + SIGMA_STILL * gauss() + level * SIGMA_MOVE * gauss();
        amps[k] = Math.max(0.1, base[k] * agc * factor);
      }
      yield { seq, ts: t, rssi: -50 + Math.round(gauss()), amps, label: seg.label };
    }
  }
}
