import type { Socket } from "socket.io";

import { HANDSHAKE_ERRORS, type HandshakeErrorCode } from "../events.js";
import { verifyTicket } from "./ticket.js";

/** Error de handshake con código estable para que el cliente sepa si reintentar. */
function handshakeError(code: HandshakeErrorCode, message: string): Error {
  const error = new Error(message) as Error & { data?: { code: string } };
  error.data = { code };
  return error;
}

export type HandshakeAuthDeps = {
  ticketSecret: Uint8Array;
  socketTtlMs: number;
};

export function createHandshakeAuth(deps: HandshakeAuthDeps) {
  return async function handshakeAuth(
    socket: Socket,
    next: (err?: Error) => void,
  ): Promise<void> {
    const raw = socket.handshake.auth?.token;
    const token = typeof raw === "string" ? raw : "";

    if (!token) {
      next(handshakeError(HANDSHAKE_ERRORS.missing, "Falta el ticket de conexión."));
      return;
    }

    const claims = await verifyTicket(token, deps.ticketSecret);
    if (!claims) {
      next(handshakeError(HANDSHAKE_ERRORS.invalid, "Ticket inválido o caducado."));
      return;
    }

    socket.data = {
      userId: claims.userId,
      role: claims.role,
      validUntil: Date.now() + deps.socketTtlMs,
    };

    next();
  };
}
