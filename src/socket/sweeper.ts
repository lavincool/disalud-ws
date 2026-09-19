import { childLogger } from "../lib/logger.js";
import type { AppServer } from "./server.js";

const log = childLogger("sweeper");

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Cierra los sockets cuya ventana de validez venció.
 *
 * Un socket puede vivir horas, pero el ticket que lo abrió solo acreditaba la
 * sesión en ese instante. En lugar de consultar el estado de sesión desde aquí
 * (lo que exigiría darle a este servidor credenciales de la app), se impone un
 * TTL: el cliente lo renueva mientras Next le siga emitiendo tickets. Si el
 * usuario cierra sesión, Next deja de emitirlos y la conexión muere sola.
 *
 * El coste es una ventana de hasta `SOCKET_TTL_MINUTES` en la que un socket ya
 * inválido puede seguir recibiendo avisos sobre ese mismo usuario. Se asume a
 * cambio de que el VPS no custodie ninguna credencial de disalud-org.
 */
export function startSocketSweeper(
  io: AppServer,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => sweep(io), intervalMs);

  // No debe mantener vivo el proceso durante el apagado ordenado.
  timer.unref();

  return () => clearInterval(timer);
}

export function sweep(io: AppServer, now: number = Date.now()): number {
  let cerrados = 0;

  // Se recorren los sockets locales: con varias instancias, cada una vigila los
  // suyos, que es exactamente lo que hace falta.
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.validUntil > now) continue;

    socket.emit("session:expired");
    socket.disconnect(true);
    cerrados += 1;
    log.info({ userId: socket.data.userId }, "socket cerrado por ventana vencida");
  }

  return cerrados;
}
