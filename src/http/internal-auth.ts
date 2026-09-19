import { timingSafeEqual } from "node:crypto";

const PREFIX = "Bearer ";

/**
 * Compara el bearer de `POST /internal/emit` en tiempo constante.
 *
 * La comparación con `===` filtra por el tiempo de respuesta cuántos caracteres
 * iniciales acertó quien lo intenta, lo que permite adivinar el secreto byte a
 * byte. La diferencia de longitud sí se revela, y eso es aceptable.
 */
export function isValidInternalBearer(
  header: string | undefined | null,
  secret: string,
): boolean {
  if (!header || !header.startsWith(PREFIX)) return false;

  const provided = Buffer.from(header.slice(PREFIX.length), "utf8");
  const expected = Buffer.from(secret, "utf8");

  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
