# disalud-ws

Servidor de tiempo real de DiSalud. Entrega por WebSocket los avisos de escaneo
(QR o rostro) a las dos partes implicadas: al médico que escanea —para el
traspaso entre sus dispositivos— y al paciente escaneado.

Sustituye al polling de 3 segundos que vivía en `HeaderNavbar.tsx` del repo
`disalud-org`.

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

## Desarrollo

```bash
bun install
cp .env.example .env     # rellena los dos secretos
bun run dev              # recarga en caliente
```

| Script | Qué hace |
|---|---|
| `bun run dev` | Arranca con recarga en caliente. |
| `bun run build` | Compila a `dist/` con `tsconfig.build.json` (sin pruebas). |
| `bun run start` | Ejecuta `dist/index.js` con Node. |
| `bun test` | Unitarias e integración real de socket.io en puerto efímero. |
| `bun run lint` / `bun run typecheck` | ESLint y `tsc --noEmit`. |

Se compila con bun y se **ejecuta con Node**: `engine.io` está mucho más rodado
sobre Node, y este proceso mantiene conexiones abiertas durante horas.

## Despliegue en un VPS

```bash
cp .env.example .env     # rellena ALLOWED_ORIGINS y los dos secretos
# Ajusta el dominio en el Caddyfile (por defecto ws.disalud.org)
docker compose up -d --build
docker compose logs -f ws
```

Caddy termina TLS con certificado automático y reenvía el upgrade de WebSocket
sin configuración extra. En `Caddyfile` está comentado el equivalente para Nginx,
donde hay que acordarse de `proxy_read_timeout` (su valor por defecto de 60 s
corta los sockets inactivos en silencio).

Luego, en Vercel, define en `disalud-org`:

```
REALTIME_URL=https://ws.disalud.org
REALTIME_TICKET_SECRET=<el mismo de aquí>
REALTIME_INTERNAL_SECRET=<el mismo de aquí>
```

Despliega **primero este servidor**: mientras `REALTIME_URL` no esté definida, la
app degrada sola a "sin avisos en vivo" y no falla nada.

## Variables de entorno

Ver `.env.example`, que documenta cada una.
