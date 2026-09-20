import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getRequestListener } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createServer, type Server as HttpServer } from "node:http";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";

import { loadConfig } from "./config.js";
import { initLogger } from "./lib/logger.js";
import { REALTIME_PROTOCOL_VERSION, type RealtimeEntry } from "./events.js";
import { createHttpApp } from "./http/app.js";
import { createSocketServer, type AppServer } from "./socket/server.js";
import { sweep } from "./socket/sweeper.js";
import { mintTicket } from "./socket/ticket.test.js";

const TICKET_SECRET = "secreto-de-pruebas-con-mas-de-32-caracteres";
const INTERNAL_SECRET = "secreto-interno-de-pruebas-con-32-chars";

let httpServer: HttpServer;
let io: AppServer;
let baseUrl: string;
const clientes: ClientSocket[] = [];

function scanEntry(userId: string, eventId: string): RealtimeEntry {
  return {
    userId,
    name: "scan:detected",
    payload: {
      v: REALTIME_PROTOCOL_VERSION,
      eventId,
      method: "qr",
      at: new Date().toISOString(),
      ownerId: "paciente-1",
      ownerName: "Ana Paciente",
      ownerAvatar: "",
      accessPath: "/panel/paciente/paciente-1",
      isNewGrant: true,
    },
  };
}

async function emit(entries: RealtimeEntry[], bearer = INTERNAL_SECRET) {
  return fetch(`${baseUrl}/internal/emit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ v: REALTIME_PROTOCOL_VERSION, entries }),
  });
}

/** Conecta un cliente y espera a que el handshake termine (bien o mal). */
function connect(token: string): Promise<ClientSocket> {
  const socket = createClient(baseUrl, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });
  clientes.push(socket);

  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => reject(error));
  });
}

/** Espera un evento concreto, o resuelve a `null` si no llega a tiempo. */
function waitFor<T>(socket: ClientSocket, event: string, ms = 500): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

beforeAll(async () => {
  initLogger("fatal");

  const config = loadConfig({
    // El puerto de la configuración no se usa aquí: más abajo se escucha en un
    // puerto efímero para que las pruebas no choquen entre sí.
    ALLOWED_ORIGINS: "http://localhost:3000",
    REALTIME_TICKET_SECRET: TICKET_SECRET,
    REALTIME_INTERNAL_SECRET: INTERNAL_SECRET,
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);

  let handler: ReturnType<typeof getRequestListener> | null = null;
  httpServer = createServer((req, res) => handler?.(req, res));
  io = createSocketServer({ httpServer, config, adapterClients: null });

  const app = createHttpApp({
    io,
    internalSecret: config.REALTIME_INTERNAL_SECRET,
    startedAt: Date.now(),
    isHealthy: () => true,
  });
  handler = getRequestListener(app.fetch);

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const cliente of clientes) cliente.disconnect();
  if (!io) return;

  // `io.close()` cierra también el servidor HTTP, pero se queda esperando a las
  // conexiones keep-alive que dejaron los `fetch` de las pruebas. Destruirlas a
  // mano es lo que evita que el hook agote su tiempo.
  const cerrado = new Promise<void>((resolve) => io.close(() => resolve()));
  httpServer.closeAllConnections();
  await cerrado;
});

describe("GET /health", () => {
  test("responde 200 con el estado del servidor", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string; protocol: number };
    expect(body.status).toBe("ok");
    expect(body.protocol).toBe(REALTIME_PROTOCOL_VERSION);
  });
});

describe("POST /internal/emit", () => {
  test("rechaza sin bearer", async () => {
    const response = await fetch(`${baseUrl}/internal/emit`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  test("rechaza con un bearer incorrecto", async () => {
    const response = await emit([scanEntry("u1", "e1")], "secreto-equivocado-de-32-caract");
    expect(response.status).toBe(401);
  });

  test("rechaza un payload que no cumple el contrato", async () => {
    const response = await fetch(`${baseUrl}/internal/emit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({ v: REALTIME_PROTOCOL_VERSION, entries: [{ userId: "u1" }] }),
    });
    expect(response.status).toBe(400);
  });

  test("acepta aunque el destinatario no esté conectado", async () => {
    const response = await emit([scanEntry("nadie", "e2")]);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { results: { delivered: number }[] };
    expect(body.results[0]?.delivered).toBe(0);
  });
});

describe("handshake", () => {
  test("rechaza la conexión sin ticket", async () => {
    await expect(connect("")).rejects.toThrow();
  });

  test("rechaza un ticket caducado", async () => {
    const token = await mintTicket({ expiration: Math.floor(Date.now() / 1000) - 10 });
    await expect(connect(token)).rejects.toThrow();
  });

  test("acepta un ticket válido", async () => {
    const socket = await connect(await mintTicket({ subject: "medico-1" }));
    expect(socket.connected).toBe(true);
  });
});

describe("entrega de avisos", () => {
  test("el destinatario recibe el evento íntegro", async () => {
    const socket = await connect(await mintTicket({ subject: "medico-2" }));
    const recibido = waitFor<{ eventId: string; ownerName: string }>(socket, "scan:detected");

    await emit([scanEntry("medico-2", "evento-abc")]);

    const evento = await recibido;
    expect(evento?.eventId).toBe("evento-abc");
    expect(evento?.ownerName).toBe("Ana Paciente");
  });

  test("un aviso dirigido a otro usuario NO llega", async () => {
    // Es el aislamiento entre salas: si esto falla, un médico vería los escaneos
    // de otro. Es la prueba que de verdad importa de todo el archivo.
    const socket = await connect(await mintTicket({ subject: "medico-3" }));
    const recibido = waitFor(socket, "scan:detected");

    await emit([scanEntry("medico-4", "evento-ajeno")]);

    expect(await recibido).toBeNull();
  });

  test("los dos destinatarios de un escaneo se entregan en una sola petición", async () => {
    const medico = await connect(await mintTicket({ subject: "medico-5" }));
    const paciente = await connect(await mintTicket({ subject: "paciente-5", role: "patient" }));

    const enMedico = waitFor<{ eventId: string }>(medico, "scan:detected");
    const enPaciente = waitFor<{ granteeName: string }>(paciente, "access:used");

    await emit([
      scanEntry("medico-5", "evento-doble"),
      {
        userId: "paciente-5",
        name: "access:used",
        payload: {
          v: REALTIME_PROTOCOL_VERSION,
          eventId: "evento-doble",
          method: "qr",
          at: new Date().toISOString(),
          granteeId: "medico-5",
          granteeName: "Dr. Quien Escanea",
          granteeAvatar: "",
          granteeRole: "medic",
          isNewGrant: true,
        },
      },
    ]);

    expect((await enMedico)?.eventId).toBe("evento-doble");
    expect((await enPaciente)?.granteeName).toBe("Dr. Quien Escanea");
  });
});

describe("renovación y caducidad del socket", () => {
  test("auth:refresh acepta un ticket propio y rechaza el de otro", async () => {
    const socket = await connect(await mintTicket({ subject: "medico-6" }));

    const propio = await socket
      .timeout(1000)
      .emitWithAck("auth:refresh", await mintTicket({ subject: "medico-6" }));
    expect(propio).toEqual({ ok: true });

    const ajeno = await socket
      .timeout(1000)
      .emitWithAck("auth:refresh", await mintTicket({ subject: "otro-medico" }));
    expect(ajeno).toEqual({ ok: false });
  });

  test("el barrido cierra los sockets cuya ventana venció", async () => {
    const socket = await connect(await mintTicket({ subject: "medico-7" }));
    const expirado = waitFor(socket, "session:expired", 1000);

    // Se barre con una marca de tiempo muy futura para no esperar 15 minutos.
    const cerrados = sweep(io, Date.now() + 24 * 60 * 60 * 1000);
    expect(cerrados).toBeGreaterThan(0);

    expect(await expirado).not.toBeUndefined();
    await Bun.sleep(50);
    expect(socket.connected).toBe(false);
  });
});
