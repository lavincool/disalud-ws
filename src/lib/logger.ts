import pino from "pino";

let instance: pino.Logger | null = null;

/**
 * Logger raíz. Se inicializa desde `index.ts` con el nivel de la configuración;
 * el resto de módulos pide hijos con `childLogger` para que cada línea lleve su
 * origen sin tener que repetirlo en cada llamada.
 */
export function initLogger(level: string): pino.Logger {
  instance = pino({
    level,
    // La hora la pone el runtime del contenedor; ISO es lo que esperan los
    // agregadores de logs habituales.
    timestamp: pino.stdTimeFunctions.isoTime,
    // Nunca se registra el ticket ni el bearer interno: son credenciales.
    redact: {
      paths: ["token", "*.token", "authorization", "*.authorization"],
      censor: "[oculto]",
    },
  });
  return instance;
}

export function logger(): pino.Logger {
  if (!instance) instance = initLogger(process.env.LOG_LEVEL ?? "info");
  return instance;
}

export function childLogger(name: string): pino.Logger {
  return logger().child({ name });
}
