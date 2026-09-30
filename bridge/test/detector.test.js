import test from "node:test";
import assert from "node:assert/strict";
import { FallDetector } from "../src/detector.js";
import { SCENARIOS, generateSamples } from "../src/simulator.js";
import { parseCsiLine, parseStatusLine } from "../src/csi-parser.js";

function run(scenario, { seed = 1, options } = {}) {
  const det = new FallDetector(options);
  const events = [];
  for (const sample of generateSamples(scenario, { seed })) {
    for (const ev of det.push(sample).events) events.push({ ...ev, at: sample.ts });
  }
  return { det, events };
}

const kinds = (events) => events.map((e) => e.kind);

test("sala parada: calibra e não gera nenhum alerta", () => {
  const { det, events } = run([{ sec: 60, level: 0 }]);
  assert.deepEqual(kinds(events), ["calibrated"]);
  assert.equal(det.state, "monitoring");
});

test("atividade normal (caminhar, sentar) não gera queda — várias seeds", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { events } = run(SCENARIOS.walk, { seed });
    assert.ok(!kinds(events).includes("fall"), `seed ${seed}: ${JSON.stringify(kinds(events))}`);
  }
});

test("queda seguida de imobilidade gera exatamente 1 alerta — várias seeds", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { events } = run(SCENARIOS.fall, { seed });
    const falls = events.filter((e) => e.kind === "fall");
    assert.equal(falls.length, 1, `seed ${seed}: ${JSON.stringify(kinds(events))}`);
    assert.ok(falls[0].confidence >= 0.5 && falls[0].confidence <= 1);
    assert.ok(falls[0].stillSeconds >= 3);
  }
});

test("alerta sai poucos segundos depois do impacto (impacto em t=15,0 s)", () => {
  const { events } = run(SCENARIOS.fall);
  const fall = events.find((e) => e.kind === "fall");
  assert.ok(fall.at > 15 && fall.at < 15 + 8, `alerta em t=${fall.at}`);
});

test("impacto seguido de movimento contínuo é falso alarme, sem queda", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { events } = run(SCENARIOS.stumble, { seed });
    assert.ok(!kinds(events).includes("fall"), `seed ${seed}: ${JSON.stringify(kinds(events))}`);
    assert.ok(kinds(events).includes("false_alarm"), `seed ${seed}: ${JSON.stringify(kinds(events))}`);
  }
});

test("cenário demo completo: sentar não dispara e a queda gera um único alerta", () => {
  const { events } = run(SCENARIOS.demo);
  assert.equal(events.filter((e) => e.kind === "fall").length, 1);
});

test("buraco longo de pacotes não gera alerta falso", () => {
  const det = new FallDetector();
  const samples = [...generateSamples([{ sec: 15, level: 0 }])];
  const events = [];
  for (const s of samples) {
    // remove 2 s de pacotes no meio, depois da calibração
    if (s.ts > 11 && s.ts < 13) continue;
    events.push(...det.push(s).events);
  }
  assert.ok(!events.some((e) => e.kind === "fall"));
});

test("parser: linha CSI válida vira 52 amplitudes", () => {
  const values = Array.from({ length: 128 }, (_, i) => (i % 2 ? 10 : -10));
  const parsed = parseCsiLine(`CSI,7,1234,-48,128,${values.join(",")}`);
  assert.equal(parsed.seq, 7);
  assert.equal(parsed.ts, 1.234);
  assert.equal(parsed.rssi, -48);
  assert.equal(parsed.amps.length, 52);
  assert.ok(Math.abs(parsed.amps[0] - Math.hypot(10, 10)) < 1e-9);
});

test("parser: linhas truncadas/lixo são ignoradas", () => {
  assert.equal(parseCsiLine("CSI,7,1234,-48,128,1,2,3"), null);
  assert.equal(parseCsiLine("ets Jun  8 2016 00:22:57"), null);
  assert.equal(parseCsiLine("CSI,a,b,c,d,e,f"), null);
  assert.deepEqual(parseStatusLine("STATUS,5000,-50,49"), { ts: 5, rssi: -50, pps: 49 });
});
