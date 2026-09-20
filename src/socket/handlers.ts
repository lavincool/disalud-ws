import { childLogger } from "../lib/logger.js";
import { userRoom } from "./rooms.js";
import type { AppSocket } from "./server.js";
import { verifyTicket } from "./ticket.js";

const log = childLogger("socket");

export type HandlerDeps = {
  ticketSecret: Uint8Array;
  socketTtlMs: number;
};

export function registerHandlers(socket: AppSocket, deps: HandlerDeps): void {
  const { userId, role } = socket.data;

  void socket.join(userRoom(userId));
  log.info({ userId, role, socketId: socket.id }, "socket conectado");

  // Renovación de la ventana de validez. El cliente acuña un ticket nuevo cada
  // pocos minutos; si su sesión en disalud-org ya no existe, Next se niega a
  // emitirlo, el cliente deja de refrescar y el barrido cierra este socket.
  // Así la autoridad sobre la sesión sigue siendo Next, sin que este servidor
  // necesite acceso a la base de datos ni al KV.
  socket.on("auth:refresh", (token, ack) => {
    void (async () => {
      const claims =
        typeof token === "string" ? await verifyTicket(token, deps.ticketSecret) : null;

      // Un ticket de otra persona no sirve para prolongar este socket.
      if (!claims || claims.userId !== userId) {
        if (typeof ack === "function") ack({ ok: false });
        return;
      }

      socket.data.validUntil = Date.now() + deps.socketTtlMs;
      if (typeof ack === "function") ack({ ok: true });
    })();
  });

  socket.on("disconnect", (reason) => {
    log.debug({ userId, socketId: socket.id, reason }, "socket desconectado");
  });
}
