// Formato das linhas que o firmware do receptor escreve na serial:
//
//   CSI,<seq>,<ms>,<rssi>,<len>,<v0>,<v1>,...,<v(len-1)>
//
// <v> são int8 na ordem [imaginário, real] por subportadora (como o ESP-IDF entrega).
// Outras linhas (STATUS,... / "# comentário" / logs de boot) não são amostras.

// Com LLTF (len = 128) são 64 subportadoras; as das pontas (0-5, 59-63) e a central
// (32, DC) são sempre nulas e só adicionariam ruído à métrica.
const LLTF_SUBCARRIERS = 64;
const VALID_LLTF = [];
for (let k = 6; k <= 58; k++) if (k !== 32) VALID_LLTF.push(k);

export function parseCsiLine(line) {
  if (!line.startsWith("CSI,")) return null;
  const f = line.trim().split(",");
  if (f.length < 7) return null;

  const seq = Number(f[1]);
  const ms = Number(f[2]);
  const rssi = Number(f[3]);
  const len = Number(f[4]);
  if (![seq, ms, rssi, len].every(Number.isFinite)) return null;
  if (len < 2 || f.length - 5 !== len) return null; // linha truncada/corrompida na serial

  const raw = new Int8Array(len);
  for (let i = 0; i < len; i++) {
    const v = Number(f[5 + i]);
    if (!Number.isFinite(v)) return null;
    raw[i] = v;
  }

  const pairs = Math.floor(len / 2);
  const idx = pairs >= LLTF_SUBCARRIERS ? VALID_LLTF : Array.from({ length: pairs }, (_, i) => i);
  const amps = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const k = idx[i];
    amps[i] = Math.hypot(raw[2 * k], raw[2 * k + 1]);
  }

  return { seq, ts: ms / 1000, rssi, amps };
}

export function parseStatusLine(line) {
  // STATUS,<ms>,<rssi>,<packets_per_second>
  if (!line.startsWith("STATUS,")) return null;
  const f = line.trim().split(",");
  const [ms, rssi, pps] = [Number(f[1]), Number(f[2]), Number(f[3])];
  return [ms, rssi, pps].every(Number.isFinite) ? { ts: ms / 1000, rssi, pps } : null;
}
