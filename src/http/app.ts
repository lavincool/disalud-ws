import { Hono } from "hono";

import {
  REALTIME_PROTOCOL_VERSION,
  emitRequestSchema,
  type RealtimeEntry,
} from "../events.js";
import { childLogger } from "../lib/logger.js";
import { userRoom } from "../socket/rooms.js";
import type { AppServer } from "../socket/server.js";
import { isValidInternalBearer } from "./internal-auth.js";

const log = childLogger("http");

export type AppDeps = {
  io: AppServer;
  internalSecret: string;
  startedAt: number;
  /** Permite que el apagado ordenado deje de anunciarse sano al proxy. */
  isHealthy: () => boolean;
};

async function deliver(
  io: AppServer,
  entry: RealtimeEntry,
): Promise<{ userId: string; delivered: number }> {
  const room = userRoom(entry.userId);

  if (entry.name === "scan:detected") {
    io.to(room).emit("scan:detected", entry.payload);
  } else {
    io.to(room).emit("access:used", entry.payload);
  }

  // `delivered` es puramente informativo para depurar: la garantía de entrega la
  // da el pendiente que disalud-org guarda en KV, no este contador.
  const sockets = await io.in(room).fetchSockets();
  return { userId: entry.userId, delivered: sockets.length };
}

export function createHttpApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const healthy = deps.isHealthy();
    return c.json(
      {
        status: healthy ? "ok" : "shutting_down",
        uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
        connections: deps.io.engine.clientsCount,
        protocol: REALTIME_PROTOCOL_VERSION,
      },
      // 503 durante el apagado para que el proxy deje de mandar tráfico nuevo
      // antes de que se corten los sockets.
      healthy ? 200 : 503,
    );
  });

  app.post("/internal/emit", async (c) => {
    if (!isValidInternalBearer(c.req.header("authorization"), deps.internalSecret)) {
      return c.json({ ok: false, error: "No autorizado." }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Cuerpo JSON inválido." }, 400);
    }

    const parsed = emitRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
      log.warn({ issues }, "emisión rechazada por payload inválido");
      return c.json({ ok: false, error: "Payload inválido.", issues }, 400);
    }

    const results = [];
    for (const entry of parsed.data.entries) {
      results.push(await deliver(deps.io, entry));
    }

    log.info(
      { eventIds: parsed.data.entries.map((entry) => entry.payload.eventId), results },
      "avisos emitidos",
    );

    return c.json({ ok: true, results });
  });

  app.notFound((c) => c.json({ ok: false, error: "No encontrado." }, 404));

  return app;
}
