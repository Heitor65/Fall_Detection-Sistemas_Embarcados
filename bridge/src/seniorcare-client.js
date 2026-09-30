// Cliente HTTP do backend SeniorCare (ver senior-care/app/api/ingest/*).
// Eventos (queda, offline) entram numa fila com reenvio: se o site cair por alguns
// segundos durante a demo, o alerta não se perde. Heartbeats não são reenviados.

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const MAX_QUEUE = 50;

export class SeniorCareClient {
  constructor({ baseUrl, apiKey, timeoutMs = 4000, log = console }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.queue = [];
    this.flushing = false;
    this.authFailureLogged = false;
  }

  async post(path, body) {
    const started = performance.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: res.status, ok: res.ok, ms: performance.now() - started, text: await res.text() };
  }

  async heartbeat(payload) {
    try {
      const r = await this.post("/api/ingest/heartbeat", payload);
      if (r.status === 401) this.warnAuth();
      return r.ok;
    } catch {
      return false;
    }
  }

  // Enfileira e tenta enviar. Retorna uma Promise resolvida com { ok, ms, attempts } quando
  // o evento for entregue (ou descartado por erro permanente).
  sendEvent(event) {
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    return new Promise((resolve) => {
      this.queue.push({ event, resolve, attempts: 0 });
      void this.flush();
    });
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        item.attempts++;
        try {
          const r = await this.post("/api/ingest/events", item.event);
          if (r.ok) {
            this.queue.shift();
            item.resolve({ ok: true, ms: r.ms, attempts: item.attempts });
            continue;
          }
          if (r.status === 401) this.warnAuth();
          if (r.status >= 400 && r.status < 500) {
            // Erro permanente (chave inválida, payload inválido): reenviar não adianta.
            this.log.error(`[senior-care] evento descartado: HTTP ${r.status} ${r.text.slice(0, 200)}`);
            this.queue.shift();
            item.resolve({ ok: false, ms: r.ms, attempts: item.attempts });
            continue;
          }
          this.log.error(`[senior-care] servidor respondeu HTTP ${r.status}; tentando de novo…`);
        } catch (err) {
          this.log.error(`[senior-care] sem conexão com o site (${err.cause?.code ?? err.message}); tentando de novo…`);
        }
        const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      this.flushing = false;
    }
  }

  warnAuth() {
    if (this.authFailureLogged) return;
    this.authFailureLogged = true;
    this.log.error(
      "[senior-care] 401 Não autorizado — SENIORCARE_API_KEY inválida. Gere/copie a chave de novo no dashboard (ou `npm run db:seed`)."
    );
  }
}
