// Leitura da serial (USB) do ESP32 receptor, com detecção automática da porta e
// reconexão se o cabo for puxado.

// Fabricantes de USB-serial mais comuns em placas ESP32: CP210x, CH340, FTDI, Espressif nativo.
const ESP_USB_VENDORS = new Set(["10c4", "1a86", "0403", "303a"]);

async function loadSerialport() {
  try {
    return await import("serialport");
  } catch {
    throw new Error("Pacote 'serialport' não instalado. Rode `npm install` dentro de fall-detection/bridge.");
  }
}

export async function listPorts() {
  const { SerialPort } = await loadSerialport();
  return SerialPort.list();
}

async function resolvePort(requested) {
  if (requested && requested !== "auto") return requested;
  const ports = await listPorts();
  const candidates = ports.filter((p) => p.vendorId && ESP_USB_VENDORS.has(p.vendorId.toLowerCase()));
  if (candidates.length === 1) return candidates[0].path;
  const describe = (list) => list.map((p) => `  ${p.path}  ${p.manufacturer ?? ""} ${p.vendorId ?? ""}:${p.productId ?? ""}`).join("\n");
  if (candidates.length === 0) {
    throw new Error(
      `Nenhum ESP32 encontrado na USB. Portas vistas:\n${describe(ports) || "  (nenhuma)"}\n` +
        "Conecte o receptor, instale o driver CP210x/CH340 se necessário, ou passe --port COMx."
    );
  }
  throw new Error(`Mais de um candidato — escolha com --port:\n${describe(candidates)}`);
}

export class SerialSource {
  constructor({ path = "auto", baud = 921600, onLine, onState, log = console }) {
    Object.assign(this, { path, baud, onLine, onState, log });
    this.port = null;
    this.stopped = false;
  }

  async start() {
    await this.connect(true);
  }

  async connect(first = false) {
    if (this.stopped) return;
    try {
      const { SerialPort } = await loadSerialport();
      const { ReadlineParser } = await import("@serialport/parser-readline");
      const path = await resolvePort(this.path);
      const port = new SerialPort({ path, baudRate: this.baud, autoOpen: false });
      await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
      this.port = port;
      this.log.log(`[serial] conectado em ${path} @ ${this.baud} baud`);
      this.onState?.("connected");

      const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
      parser.on("data", (line) => this.onLine(line.replace(/\r$/, "")));
      const lost = (err) => {
        if (this.port !== port) return;
        this.port = null;
        this.onState?.("disconnected");
        if (!this.stopped) {
          this.log.error(`[serial] conexão perdida${err ? ` (${err.message})` : ""}; tentando reconectar…`);
          setTimeout(() => this.connect(), 2000);
        }
      };
      port.on("close", () => lost());
      port.on("error", lost);
    } catch (err) {
      // Na primeira tentativa o erro é de configuração (porta errada): falhar rápido e claro.
      if (first) throw err;
      this.log.error(`[serial] ${err.message.split("\n")[0]}; nova tentativa em 2 s…`);
      setTimeout(() => this.connect(), 2000);
    }
  }

  write(text) {
    if (this.port?.isOpen) this.port.write(text);
  }

  async stop() {
    this.stopped = true;
    const port = this.port;
    this.port = null;
    if (port?.isOpen) await new Promise((r) => port.close(() => r()));
  }
}
