import { describe, expect, test } from "bun:test";

import {
  REALTIME_PROTOCOL_VERSION,
  TICKET_AUDIENCE,
  TICKET_ISSUER,
  TICKET_TTL_SECONDS,
  accessUsedSchema,
  emitRequestSchema,
  scanDetectedSchema,
} from "./events.js";

// Espejo de `lib/realtime/events.test.ts` en disalud-org. No validan lógica:
// existen para que, si alguien cambia un nombre de evento o una clave del
// payload en un repo y no en el otro, falle el CI en vez de romperse la
// conexión en producción.

const scanDetected = {
  v: REALTIME_PROTOCOL_VERSION,
  eventId: "id",
  method: "qr" as const,
  at: "2026-01-01T00:00:00.000Z",
  ownerId: "o",
  ownerName: "n",
  ownerAvatar: "",
  accessPath: null,
  isNewGrant: true,
};

const accessUsed = {
  v: REALTIME_PROTOCOL_VERSION,
  eventId: "id",
  method: "face" as const,
  at: "2026-01-01T00:00:00.000Z",
  granteeId: "g",
  granteeName: "n",
  granteeAvatar: "",
  granteeRole: "medic",
  isNewGrant: false,
};

describe("contrato compartido con disalud-org", () => {
  test("la versión de protocolo no cambia sin querer", () => {
    expect(REALTIME_PROTOCOL_VERSION).toBe(1);
  });

  test("los parámetros del ticket coinciden con los de la app", () => {
    expect(TICKET_AUDIENCE).toBe("disalud-ws");
    expect(TICKET_ISSUER).toBe("disalud-org");
    expect(TICKET_TTL_SECONDS).toBe(60);
  });

  test("acepta los dos payloads acordados", () => {
    expect(scanDetectedSchema.safeParse(scanDetected).success).toBe(true);
    expect(accessUsedSchema.safeParse(accessUsed).success).toBe(true);
  });

  test("rechaza un payload al que le falta una clave del contrato", () => {
    const { ownerName: _omitido, ...incompleto } = scanDetected;
    expect(scanDetectedSchema.safeParse(incompleto).success).toBe(false);
  });

  test("rechaza una versión de protocolo que no entiende", () => {
    expect(
      emitRequestSchema.safeParse({
        v: REALTIME_PROTOCOL_VERSION + 1,
        entries: [{ userId: "u", name: "scan:detected", payload: scanDetected }],
      }).success,
    ).toBe(false);
  });

  test("rechaza un nombre de evento desconocido", () => {
    expect(
      emitRequestSchema.safeParse({
        v: REALTIME_PROTOCOL_VERSION,
        entries: [{ userId: "u", name: "scan:inventado", payload: scanDetected }],
      }).success,
    ).toBe(false);
  });

  test("exige al menos un destinatario y acota cuántos caben", () => {
    expect(
      emitRequestSchema.safeParse({ v: REALTIME_PROTOCOL_VERSION, entries: [] }).success,
    ).toBe(false);
  });
});
