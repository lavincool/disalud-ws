import { jwtVerify } from "jose";

import { TICKET_AUDIENCE, TICKET_ISSUER } from "../events.js";

export type TicketClaims = {
  userId: string;
  role: string;
};

/**
 * Verifica un ticket de handshake emitido por disalud-org.
 *
 * El ticket es una aserción de 60 segundos que Next firma DESPUÉS de haber
 * validado la sesión a fondo contra Turso (`lib/auth/current-user.ts`). Por eso
 * aquí basta con comprobar firma, vigencia y destinatario: este servidor no
 * necesita —ni debe tener— credenciales de la base de datos ni del KV de la app.
 */
export async function verifyTicket(
  token: string,
  secret: Uint8Array,
): Promise<TicketClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      audience: TICKET_AUDIENCE,
      issuer: TICKET_ISSUER,
      // Fijar el algoritmo evita el clásico ataque de degradar a `alg: "none"`.
      algorithms: ["HS256"],
    });

    const userId = typeof payload.sub === "string" ? payload.sub : "";
    if (!userId) return null;

    return {
      userId,
      role: typeof payload.role === "string" ? payload.role : "",
    };
  } catch {
    return null;
  }
}
