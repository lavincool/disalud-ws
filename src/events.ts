import { z } from "zod";

// CONTRATO DE EVENTOS — espejo de `lib/realtime/events.ts` en disalud-org.
// Cambiar uno sin el otro rompe la conexión en silencio: hay un test en cada
// repo que congela estos nombres precisamente para que salte al compilar.
//
// Diferencia intencionada con el espejo de Next: aquí van además los esquemas de
// zod, porque este lado recibe datos por la red y tiene que validarlos.

export const REALTIME_PROTOCOL_VERSION = 1;

// Parámetros del ticket de handshake. Deben coincidir con `lib/realtime/ticket.ts`
// de disalud-org: si divergen, ningún cliente logra conectar.
export const TICKET_AUDIENCE = "disalud-ws";
export const TICKET_ISSUER = "disalud-org";
/** Vida del ticket. Corta a propósito: solo tiene que sobrevivir al handshake. */
export const TICKET_TTL_SECONDS = 60;

/** Códigos de rechazo del handshake. El cliente decide si reintenta según esto. */
export const HANDSHAKE_ERRORS = {
  missing: "ticket_missing",
  invalid: "ticket_invalid",
} as const;

export type HandshakeErrorCode =
  (typeof HANDSHAKE_ERRORS)[keyof typeof HANDSHAKE_ERRORS];

/** Cómo se identificó al paciente. */
export const scanMethodSchema = z.enum(["qr", "face"]);
export type ScanMethod = z.infer<typeof scanMethodSchema>;

/** Servidor → el médico que escaneó (handoff a su pantalla de consultorio). */
export const scanDetectedSchema = z.object({
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  /** UUID acuñado por Next. Misma clave en KV y en el socket: deduplica. */
  eventId: z.string().min(1).max(64),
  method: scanMethodSchema,
  at: z.iso.datetime(),
  ownerId: z.string().min(1).max(64),
  ownerName: z.string().min(1).max(200),
  ownerAvatar: z.string().max(2048),
  /** Ruta ya resuelta por `getPatientAccessPath()`. */
  accessPath: z.string().max(512).nullable(),
  /** `false` cuando el médico ya tenía acceso y solo volvió a escanear. */
  isNewGrant: z.boolean(),
});

export type ScanDetectedEvent = z.infer<typeof scanDetectedSchema>;

/** Servidor → el paciente escaneado (quién accedió a su expediente). */
export const accessUsedSchema = z.object({
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  eventId: z.string().min(1).max(64),
  method: scanMethodSchema,
  at: z.iso.datetime(),
  granteeId: z.string().min(1).max(64),
  granteeName: z.string().min(1).max(200),
  granteeAvatar: z.string().max(2048),
  granteeRole: z.string().min(1).max(32),
  isNewGrant: z.boolean(),
});

export type AccessUsedEvent = z.infer<typeof accessUsedSchema>;

/** Un aviso dirigido a un usuario concreto. */
export const realtimeEntrySchema = z.discriminatedUnion("name", [
  z.object({
    userId: z.string().min(1).max(64),
    name: z.literal("scan:detected"),
    payload: scanDetectedSchema,
  }),
  z.object({
    userId: z.string().min(1).max(64),
    name: z.literal("access:used"),
    payload: accessUsedSchema,
  }),
]);

export type RealtimeEntry = z.infer<typeof realtimeEntrySchema>;

/**
 * Cuerpo de `POST /internal/emit`. Los dos destinatarios de un escaneo viajan en
 * la misma petición: desde Vercel, un solo viaje de ida y vuelta en lugar de dos.
 */
export const emitRequestSchema = z.object({
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  entries: z.array(realtimeEntrySchema).min(1).max(8),
});

export type EmitRequest = z.infer<typeof emitRequestSchema>;

export type ServerToClientEvents = {
  "scan:detected": (event: ScanDetectedEvent) => void;
  "access:used": (event: AccessUsedEvent) => void;
  /** El socket superó su ventana de validez; el cliente no debe reintentar solo. */
  "session:expired": () => void;
};

export type ClientToServerEvents = {
  /**
   * Renueva la ventana de validez del socket con un ticket fresco. Si Next se
   * niega a emitirlo (sesión cerrada), el cliente simplemente deja de refrescar
   * y el barrido acaba cerrando la conexión.
   */
  "auth:refresh": (
    token: string,
    ack: (result: { ok: boolean }) => void,
  ) => void;
};

/** Identidad resuelta en el handshake y adjunta a cada socket. */
export type SocketData = {
  userId: string;
  role: string;
  /** Marca de tiempo (ms) tras la cual el barrido cierra este socket. */
  validUntil: number;
};
