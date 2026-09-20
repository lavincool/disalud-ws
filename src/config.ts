import { z } from "zod";

// La configuración se valida una sola vez al arrancar y el proceso muere si algo
// falta. Es deliberado: a diferencia de la app de Next, que degrada a "sin
// realtime", este servidor no sirve para nada sin sus secretos.

const csv = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)).min(1));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  ALLOWED_ORIGINS: csv,

  // Mínimo 32 caracteres: son secretos compartidos con disalud-org y un valor
  // corto haría viable el ataque por fuerza bruta sobre la firma HS256.
  // Genéralos con `openssl rand -base64 48` y NUNCA reutilices JWT_SECRET aquí:
  // con ese secreto, un compromiso de este servidor permitiría acuñar cookies de
  // sesión de la app, que duran 365 días.
  REALTIME_TICKET_SECRET: z.string().min(32),
  REALTIME_INTERNAL_SECRET: z.string().min(32),

  // Ventana de validez de un socket ya conectado. El cliente la renueva con
  // `auth:refresh` mientras su sesión siga viva en disalud-org; cuando deja de
  // hacerlo (cierre de sesión, reseteo de contraseña) el barrido lo cierra.
  SOCKET_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(15),

  // Opcional y vacío por defecto: sin él, una sola instancia entrega los eventos,
  // que es lo que hace falta hoy. Al poner varias detrás de un balanceador, basta
  // con definirlo y el adapter se activa solo.
  REDIS_URL: z.string().default(""),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuración inválida en las variables de entorno:\n${detail}`);
  }

  return parsed.data;
}
