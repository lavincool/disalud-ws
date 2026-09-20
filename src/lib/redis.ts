import { Redis } from "ioredis";
import { childLogger } from "./logger.js";

const log = childLogger("redis");

export type AdapterClients = { pub: Redis; sub: Redis };

/**
 * Conexiones para el adapter de Socket.IO, solo si hay `REDIS_URL`.
 *
 * Con una única instancia no hace falta: el adapter en memoria entrega igual.
 * Redis solo aporta cuando haya varias instancias detrás de un balanceador, así
 * que en v1 devuelve `null` y no se despliega ningún servicio extra.
 *
 * Nótese que aquí Redis NO guarda nada: los avisos pendientes viven en el KV de
 * disalud-org, que es quien puede garantizarlos aunque este servidor esté caído.
 */
export function createAdapterClients(url: string): AdapterClients | null {
  if (!url) return null;

  const pub = new Redis(url, {
    retryStrategy: (times) => Math.min(times * 200, 2000),
    maxRetriesPerRequest: 2,
  });
  // Una conexión en modo suscripción no puede ejecutar comandos normales, por eso
  // el adapter necesita dos.
  const sub = pub.duplicate();

  for (const [role, client] of [
    ["pub", pub],
    ["sub", sub],
  ] as const) {
    client.on("error", (error: Error) => {
      log.error({ role, err: error.message }, "error de conexión con Redis");
    });
  }

  return { pub, sub };
}

export async function closeAdapterClients(
  clients: AdapterClients | null,
): Promise<void> {
  if (!clients) return;
  await Promise.allSettled([clients.pub.quit(), clients.sub.quit()]);
}
