import { getRequestListener } from "@hono/node-server";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadConfig } from "./config.js";
import { createHttpApp } from "./http/app.js";
import { childLogger, initLogger } from "./lib/logger.js";
import { closeAdapterClients, createAdapterClients } from "./lib/redis.js";
import { createSocketServer } from "./socket/server.js";
import { startSocketSweeper } from "./socket/sweeper.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.LOG_LEVEL);
  const log = childLogger("bootstrap");

  const startedAt = Date.now();
  let healthy = true;

  const adapterClients = createAdapterClients(config.REDIS_URL);

  // Socket.IO necesita el http.Server de Node, y la app de Hono necesita el `io`
  // para emitir. Se rompe la circularidad creando el servidor con un manejador
  // diferido que se asigna antes de empezar a escuchar.
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const httpServer = createServer((req, res) => {
    if (handler) handler(req, res);
    else res.writeHead(503).end();
  });

  const io = createSocketServer({ httpServer, config, adapterClients });

  const app = createHttpApp({
    io,
    internalSecret: config.REALTIME_INTERNAL_SECRET,
    startedAt,
    isHealthy: () => healthy,
  });
  handler = getRequestListener(app.fetch);

  const stopSweeper = startSocketSweeper(io);

  httpServer.listen(config.PORT, () => {
    log.info(
      {
        port: config.PORT,
        origins: config.ALLOWED_ORIGINS,
        socketTtlMinutes: config.SOCKET_TTL_MINUTES,
        adapter: adapterClients ? "redis" : "memoria",
      },
      "disalud-ws escuchando",
    );
  });

  let cerrando = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (cerrando) return;
    cerrando = true;
    log.info({ signal }, "apagando");

    stopSweeper();
    healthy = false;

    // Un apagado colgado no debe dejar el contenedor zombi.
    const killSwitch = setTimeout(() => process.exit(1), 20_000);
    killSwitch.unref();

    // Primero socket.io: cierra los sockets y el engine. Al revés,
    // `httpServer.close()` se quedaría esperando a conexiones aún vivas.
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closeAdapterClients(adapterClients);

    log.info("apagado completo");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  // El logger puede no estar listo si falla la configuración, así que este
  // último recurso escribe directamente a stderr.
  process.stderr.write(`disalud-ws no pudo arrancar: ${String(error)}\n`);
  process.exit(1);
});
