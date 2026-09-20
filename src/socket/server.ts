import { createAdapter } from "@socket.io/redis-adapter";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";

import type { Config } from "../config.js";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from "../events.js";
import { childLogger } from "../lib/logger.js";
import type { AdapterClients } from "../lib/redis.js";
import { createHandshakeAuth } from "./auth.js";
import { registerHandlers } from "./handlers.js";

const log = childLogger("socket-server");

type InterServerEvents = Record<string, never>;

export type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type CreateSocketServerOptions = {
  httpServer: HttpServer;
  config: Config;
  adapterClients: AdapterClients | null;
};

export function createSocketServer(options: CreateSocketServerOptions): AppServer {
  const { httpServer, config, adapterClients } = options;

  const io: AppServer = new Server(httpServer, {
    path: "/socket.io",
    // El handshake de socket.io empieza con un XHR normal desde el dominio de la
    // app a este host, así que el CORS explícito es obligatorio en producción.
    // `credentials: false` porque la autenticación va por ticket, no por cookie.
    cors: {
      origin: config.ALLOWED_ORIGINS,
      credentials: false,
    },
    serveClient: false,
    // No se restringe a `websocket`: en redes de clínica y tras proxies
    // corporativos el WebSocket crudo se bloquea a menudo, y el respaldo por
    // long-polling es justo lo que mantiene la app usable ahí.
    transports: ["polling", "websocket"],
    // Cubre el caso del móvil que se duerme o cambia de red: al volver en menos
    // de dos minutos, la sesión del socket se restaura sin rehacer el handshake.
    connectionStateRecovery: { maxDisconnectionDuration: 120_000 },
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  if (adapterClients) {
    io.adapter(createAdapter(adapterClients.pub, adapterClients.sub));
    log.info("adapter de Redis activo");
  }

  const socketTtlMs = config.SOCKET_TTL_MINUTES * 60_000;
  const ticketSecret = new TextEncoder().encode(config.REALTIME_TICKET_SECRET);

  io.use(createHandshakeAuth({ ticketSecret, socketTtlMs }));

  io.on("connection", (socket) => {
    registerHandlers(socket, { ticketSecret, socketTtlMs });
  });

  return io;
}
