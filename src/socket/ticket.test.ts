import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";

import { TICKET_AUDIENCE, TICKET_ISSUER } from "../events.js";
import { verifyTicket } from "./ticket.js";

const SECRET = new TextEncoder().encode("secreto-de-pruebas-con-mas-de-32-caracteres");
const OTRO_SECRETO = new TextEncoder().encode("otro-secreto-distinto-de-mas-de-32-chars");

type TicketOverrides = {
  audience?: string;
  issuer?: string;
  expiration?: string | number;
  secret?: Uint8Array;
  subject?: string | null;
  role?: string;
};

async function mintTicket(overrides: TicketOverrides = {}): Promise<string> {
  const builder = new SignJWT({ role: overrides.role ?? "medic" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(overrides.audience ?? TICKET_AUDIENCE)
    .setIssuer(overrides.issuer ?? TICKET_ISSUER)
    .setExpirationTime(overrides.expiration ?? "60s");

  if (overrides.subject !== null) {
    builder.setSubject(overrides.subject ?? "usuario-1");
  }

  return builder.sign(overrides.secret ?? SECRET);
}

describe("verifyTicket", () => {
  test("acepta un ticket bien formado y devuelve la identidad", async () => {
    const claims = await verifyTicket(await mintTicket(), SECRET);
    expect(claims).toEqual({ userId: "usuario-1", role: "medic" });
  });

  test("rechaza un ticket firmado con otro secreto", async () => {
    const token = await mintTicket({ secret: OTRO_SECRETO });
    expect(await verifyTicket(token, SECRET)).toBeNull();
  });

  test("rechaza un ticket caducado", async () => {
    // `exp` en el pasado: jose lo rechaza por vigencia, no por firma.
    const token = await mintTicket({ expiration: Math.floor(Date.now() / 1000) - 10 });
    expect(await verifyTicket(token, SECRET)).toBeNull();
  });

  test("rechaza un ticket dirigido a otro servicio", async () => {
    const token = await mintTicket({ audience: "otro-servicio" });
    expect(await verifyTicket(token, SECRET)).toBeNull();
  });

  test("rechaza un ticket de otro emisor", async () => {
    const token = await mintTicket({ issuer: "impostor" });
    expect(await verifyTicket(token, SECRET)).toBeNull();
  });

  test("rechaza un ticket sin sujeto", async () => {
    const token = await mintTicket({ subject: null });
    expect(await verifyTicket(token, SECRET)).toBeNull();
  });

  test("rechaza basura y cadenas vacías sin lanzar", async () => {
    expect(await verifyTicket("", SECRET)).toBeNull();
    expect(await verifyTicket("no-es-un-jwt", SECRET)).toBeNull();
    expect(await verifyTicket("a.b.c", SECRET)).toBeNull();
  });

  test("rechaza un token con alg none", async () => {
    // El ataque clásico: quitar la firma declarando `alg: "none"`. Se congela
    // en un test porque es un fallo silencioso y catastrófico si se reintroduce.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: "usuario-1",
        aud: TICKET_AUDIENCE,
        iss: TICKET_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString("base64url");

    expect(await verifyTicket(`${header}.${payload}.`, SECRET)).toBeNull();
  });
});

export { mintTicket, SECRET };
