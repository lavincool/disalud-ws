# disalud-ws

Servidor de tiempo real de DiSalud. Entrega por WebSocket los avisos de escaneo
(QR o rostro) a las dos partes implicadas: al médico que escanea —para el
traspaso entre sus dispositivos— y al paciente escaneado.

Sustituye al polling de 3 segundos que vivía en `HeaderNavbar.tsx` del repo
`disalud-org`.

- **Para desplegarlo**, ve a [DESPLIEGUE.md](DESPLIEGUE.md): Ubuntu 26.04,
  Docker Compose y Cloudflare Tunnel, paso a paso.
- **Para trabajar en él**, sigue con este documento.

## De un vistazo

| | |
|---|---|
| Runtime | Node 22 (se compila con Bun, se ejecuta con Node) |
| HTTP | Hono sobre `node:http` |
| Tiempo real | Socket.IO 4 (`polling` + `websocket`) |
| Autenticación | Tickets JWT de 60 s emitidos por `disalud-org` |
| Estado | Ninguno. Sin base de datos, sin caché, sin disco |
| Despliegue | Un contenedor con `docker compose`, expuesto por Cloudflare Tunnel |

## El servidor no guarda nada

Es una decisión de diseño, no una carencia:

- **La garantía de entrega vive en `disalud-org`**, que escribe cada aviso en su
  Vercel KV con 5 minutos de vigencia. Este servidor es la vía rápida; si está
  caído, el aviso sigue llegando en la siguiente carga de página.
- **No tiene credenciales de la app**: ni base de datos, ni KV, ni `JWT_SECRET`.
  Solo los dos secretos de más abajo. Un compromiso de este VPS no da acceso a
  datos de pacientes ni permite suplantar sesiones.
- **No hay Redis en la v1.** Con una sola instancia el adapter en memoria basta.
  Al escalar a varias, se define `REDIS_URL` y el adapter de Redis se activa
  solo (ver `src/lib/redis.ts`).

Como consecuencia, reiniciarlo no pierde nada: los clientes reconectan y los
avisos del hueco llegan por el camino lento.

## Autenticación

La cookie de sesión de la app (`disalud`) es `httpOnly`, `sameSite=lax` y sin
atributo `domain`, así que **nunca llega a este host**. En su lugar:

1. El cliente pide un **ticket** a una server action de `disalud-org`, que lo
   firma con `REALTIME_TICKET_SECRET` tras validar la sesión contra la base de
   datos. Dura 60 segundos.
2. El ticket viaja en `socket.handshake.auth.token`. Aquí solo se comprueban
   firma, vigencia, `aud` e `iss`.
3. Un socket conectado vale `SOCKET_TTL_MINUTES`. El cliente lo renueva con
   `auth:refresh` mientras `disalud-org` le siga emitiendo tickets. Si el usuario
   cierra sesión, deja de emitirlos y el barrido cierra la conexión.

De este modo la autoridad sobre la sesión sigue siendo Next, que ya hace la
verificación completa. El precio es una ventana de hasta `SOCKET_TTL_MINUTES` en
la que un socket ya inválido puede seguir recibiendo avisos sobre ese mismo
usuario; se asume a cambio de no poner credenciales de la app en el VPS.

> **Importante:** `REALTIME_TICKET_SECRET` debe ser **distinto** de `JWT_SECRET`.
> Con `JWT_SECRET`, un compromiso de este servidor permitiría acuñar cookies de
> sesión de la app, que duran 365 días. Genera cada secreto con
> `openssl rand -base64 48`.

## Contrato de eventos

`src/events.ts` es la fuente de verdad y es **espejo literal** de
`lib/realtime/events.ts` en `disalud-org`. Cambiar uno sin el otro rompe la
conexión: hay un test de contrato en cada repo para que salte antes.

### Servidor → cliente

| Evento | Destinatario | Contenido |
|---|---|---|
| `scan:detected` | el médico que escanea | paciente identificado y `accessPath` al que navegar |
| `access:used` | el paciente escaneado | quién accedió a su expediente y cuándo |
| `session:expired` | el socket afectado | su ventana de validez venció; no reintentar solo |

### Cliente → servidor

| Evento | Efecto |
|---|---|
| `auth:refresh(token, ack)` | Renueva la ventana con un ticket fresco. Responde `{ ok }`. |

### HTTP

| Ruta | Descripción |
|---|---|
| `GET /health` | Estado, conexiones abiertas y versión de protocolo. Devuelve 503 durante el apagado para que el proxy deje de mandar tráfico. |
| `POST /internal/emit` | Lo llama `disalud-org` con `Authorization: Bearer $REALTIME_INTERNAL_SECRET`. Los dos destinatarios de un escaneo viajan en la misma petición. |

## Estructura del código

| Fichero | Qué hay dentro |
|---|---|
| `src/index.ts` | Arranque, orden de inicialización y apagado ordenado con `SIGTERM`. |
| `src/config.ts` | Lectura y validación de las variables de entorno con zod. Si falta algo, el proceso muere al arrancar. |
| `src/events.ts` | El contrato compartido con `disalud-org`, más los esquemas de zod que validan lo que entra por la red. |
| `src/http/app.ts` | La app de Hono: `/health` y `/internal/emit`. |
| `src/http/internal-auth.ts` | Comparación del bearer interno en tiempo constante. |
| `src/socket/server.ts` | Construcción del servidor de Socket.IO: CORS, transportes, pings, adapter. |
| `src/socket/auth.ts` | Middleware de handshake: sin ticket válido no se entra. |
| `src/socket/ticket.ts` | Verificación del JWT del ticket (HS256 fijo, `aud` e `iss` comprobados). |
| `src/socket/handlers.ts` | Sala por usuario, `auth:refresh` y desconexión. |
| `src/socket/rooms.ts` | Nombres de sala en un solo sitio. |
| `src/socket/sweeper.ts` | Barrido periódico que cierra los sockets con la ventana vencida. |
| `src/lib/redis.ts` | Clientes del adapter, solo si hay `REDIS_URL`. |
| `src/lib/logger.ts` | `pino`, con los tokens y bearers censurados. |

Las pruebas viven junto al código (`*.test.ts`), igual que en `disalud-org`.

## Desarrollo en local

Necesitas [Bun](https://bun.sh) (1.3 o superior). Node hace falta solo para
ejecutar lo compilado.

```bash
bun install
cp .env.example .env     # rellena los dos secretos
bun run dev              # recarga en caliente
```

Para probar contra la app en local, añade `http://localhost:3000` a
`ALLOWED_ORIGINS`.

| Script | Qué hace |
|---|---|
| `bun run dev` | Arranca con recarga en caliente. |
| `bun run build` | Compila a `dist/` con `tsconfig.build.json` (sin pruebas). |
| `bun run start` | Ejecuta `dist/index.js` con Node. |
| `bun test` | Unitarias e integración real de socket.io en puerto efímero. |
| `bun run lint` / `bun run typecheck` | ESLint y `tsc --noEmit`. |

Se compila con bun y se **ejecuta con Node**: `engine.io` está mucho más rodado
sobre Node, y este proceso mantiene conexiones abiertas durante horas.

Si prefieres probar la imagen tal cual se despliega, `docker compose up --build`
levanta lo mismo que en producción contra tu `.env`.

## Variables de entorno

`.env.example` documenta cada una y sirve de plantilla: `cp .env.example .env`.

| Variable | Obligatoria | Por defecto | Para qué |
|---|---|---|---|
| `ALLOWED_ORIGINS` | sí | — | Orígenes permitidos en CORS y handshake, separados por comas. Es el dominio de la **app**, no el de este servidor. |
| `REALTIME_TICKET_SECRET` | sí | — | Firma de los tickets de conexión. Mínimo 32 caracteres. El mismo valor que en `disalud-org`. |
| `REALTIME_INTERNAL_SECRET` | sí | — | Bearer de `POST /internal/emit`. Mínimo 32 caracteres. |
| `PORT` | no | `8080` | Puerto de escucha, dentro y fuera del contenedor. |
| `HOST_BIND` | no | `127.0.0.1` | Interfaz del host donde publica el puerto. Solo la lee `docker compose`. |
| `SOCKET_TTL_MINUTES` | no | `15` | Ventana de validez de un socket ya conectado. |
| `REDIS_URL` | no | vacío | Activa el adapter de Redis. Solo hace falta con varias instancias. |
| `LOG_LEVEL` | no | `info` | Nivel de `pino`: `trace`…`fatal`. |

## Despliegue

Un solo contenedor, sin reverse proxy: **Cloudflare Tunnel** pone el dominio, el
HTTPS y el certificado, y no hace falta abrir ningún puerto de entrada en el VPS.

Con Docker y el túnel ya instalados, desplegar es:

```bash
cp .env.example .env     # rellena ALLOWED_ORIGINS y los dos secretos
docker compose up -d --build
docker compose logs -f ws
```

La instalación completa —Docker en Ubuntu 26.04, `cloudflared`, el túnel, las
variables en Vercel, la operación diaria y los fallos habituales— está en
[DESPLIEGUE.md](DESPLIEGUE.md).
