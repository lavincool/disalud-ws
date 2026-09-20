# Cloudflare Tunnel

Guía monográfica de `cloudflared` para `disalud-ws` sobre **Ubuntu 26.04**: qué
instala, por qué cada opción está donde está y cómo comprobar que el camino
completo —navegador → Cloudflare → túnel → contenedor— funciona de verdad.

[DESPLIEGUE.md](DESPLIEGUE.md) cuenta el despliegue entero en orden y dedica al
túnel lo justo para dejarlo en marcha. Este documento es la otra mitad: el
detalle, los ajustes de la zona que afectan a Socket.IO y el diagnóstico cuando
algo no va. Si solo quieres levantarlo por primera vez, empieza por
`DESPLIEGUE.md` y vuelve aquí cuando necesites afinar.

---

## 1. Qué hace el túnel aquí

```
  navegador del médico    ─┐
  navegador del paciente  ─┼──▶  Cloudflare  ──▶  cloudflared  ──▶  contenedor ws
  disalud-org (Vercel)    ─┘     ws.disalud.org   (systemd)         127.0.0.1:8080
                                 TLS + dominio    túnel saliente    docker compose
                                                  └── mismo VPS (Ubuntu 26.04) ──┘
```

`cloudflared` es un demonio que abre **conexiones salientes** hacia la red de
Cloudflare por el puerto 7844 y deja que el tráfico de `ws.disalud.org` vuelva
por ellas. Consecuencias directas para este proyecto:

- **El VPS no abre ningún puerto de entrada.** No hay 80 ni 443 escuchando, así
  que no hay superficie que atacar ni IP de origen que descubrir.
- **No hay Nginx, Caddy ni certificados que renovar.** El dominio, el HTTPS y el
  certificado los pone Cloudflare.
- **El tramo local va en claro a propósito.** Entre `cloudflared` y el contenedor
  hay un `http://127.0.0.1:8080` que nunca sale de la máquina.

## 2. Lo que el túnel tiene que soportar

No es un sitio web estático. Por este hostname pasan tres clases de tráfico muy
distintas, y cada una impone algo:

| Tráfico | Quién lo genera | Qué exige del túnel |
|---|---|---|
| **WebSocket** en `/socket.io/` | Navegadores de médicos y pacientes | Conexiones abiertas durante horas, con upgrade de HTTP a WS |
| **Long-polling** en `/socket.io/` | Los mismos clientes cuando el WebSocket está bloqueado por un proxy de la clínica | Peticiones HTTP que quedan colgadas hasta 25 s antes de responder |
| **`POST /internal/emit`** | El servidor de `disalud-org` en Vercel | Petición servidor-a-servidor, sin navegador y sin JavaScript |
| **`GET /health`** | Tú, y cualquier monitor que añadas | Respuesta inmediata, nunca cacheada |

Las dos primeras filas explican la sección 9 (los ajustes de la zona) y la
sección 10 (los timeouts). La tercera es la que más sorpresas da: una petición
sin navegador es justo lo que algunas protecciones anti-bot bloquean.

## 3. Antes de empezar

| Necesitas | Comprobación |
|---|---|
| El contenedor ya corriendo | `curl http://127.0.0.1:8080/health` devuelve `{"status":"ok",...}` |
| Una zona activa en Cloudflare | `disalud.org` aparece en el panel con estado **Active** |
| Acceso `sudo` en el VPS | Para instalar el paquete y el servicio de systemd |
| Salida a internet por 7844 | Ver la sección 11; en la mayoría de VPS ya está permitida |

Si `/health` no responde, para aquí: el túnel no arregla un contenedor caído,
solo publica un 502 más bonito.

---

## 4. Instalar `cloudflared` en Ubuntu 26.04

### El repositorio de Cloudflare

Cloudflare publica un repositorio apt con la suite `any`, no una por versión de
Ubuntu. Eso significa que **26.04 no necesita ningún apaño**: el mismo
repositorio sirve aquí y en 24.04, a diferencia del de Docker, que sí va por
nombre en clave (ver la nota de `DESPLIEGUE.md`).

Primero, la clave de firma:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
```

Y ahora el repositorio. En 26.04 conviene usar el formato **deb822** (`.sources`),
que es el que apt espera hoy; el `.list` de una sola línea sigue funcionando pero
apt lo marca como heredado y lo avisa en cada `update`:

```bash
sudo tee /etc/apt/sources.list.d/cloudflared.sources >/dev/null <<'EOF'
Types: deb
URIs: https://pkg.cloudflare.com/cloudflared
Suites: any
Components: main
Signed-By: /usr/share/keyrings/cloudflare-main.gpg
EOF
```

```bash
sudo apt-get update && sudo apt-get install -y cloudflared
```

> **Si prefieres el formato de una línea** (idéntico al de la documentación de
> Cloudflare), es este, y son mutuamente excluyentes: ten uno u otro, nunca los
> dos, o apt se quejará del repositorio duplicado.
>
> ```bash
> echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
> ```

### Alternativa sin repositorio

Si prefieres no añadir un repositorio de terceros al sistema, instala el `.deb`
suelto. El coste es que las actualizaciones dejan de ser automáticas con
`apt upgrade` y tendrás que repetir este comando a mano:

```bash
curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
sudo dpkg -i /tmp/cloudflared.deb && rm /tmp/cloudflared.deb
```

### Comprobar

```bash
cloudflared --version
```

Instalar el paquete **no** arranca nada: `cloudflared` todavía no sabe a qué
túnel pertenece. Eso llega en el paso siguiente.

---

## 5. Elegir el modo de túnel

Hay tres formas de montarlo y conviene decidir a conciencia, porque cambia dónde
vive la configuración:

| | **A. Remoto (token)** | **B. Local (`config.yml`)** | **C. En el compose** |
|---|---|---|---|
| Dónde se configura el ingress | Panel de Cloudflare | Fichero en el VPS | Panel de Cloudflare |
| Dónde corre | systemd | systemd | Contenedor junto a `ws` |
| Cambiar la ruta sin tocar el VPS | Sí | No | Sí |
| Configuración versionable en git | No | Sí | Parcial |
| Recomendado para este proyecto | **Sí** | Si quieres todo en el repo | Si prefieres no instalar nada en el host |

La **ruta A** es la recomendada: hay un solo hostname y una sola ruta, no hay
nada que versionar, y poder corregir el puerto desde el panel a las tres de la
mañana sin entrar por SSH vale más que tener un YAML en el repo.

---

## 6. Ruta A — túnel remoto (recomendada)

### 6.1 Crear el túnel

1. Panel de Cloudflare → **Zero Trust** → **Networks** → **Tunnels** →
   **Create a tunnel** → tipo **Cloudflared**.
2. Nombre: `disalud-ws`. Guarda.
3. En la pantalla de instalación elige **Debian / Ubuntu**. Te dará un comando
   con el token del túnel incrustado.

### 6.2 Instalar el conector

Ya tienes el paquete, así que del comando que muestra el panel solo necesitas la
última parte:

```bash
sudo cloudflared service install eyJhIjoiXXXXXXXX...
```

Esto escribe el token en `/etc/cloudflared/config.yml`, registra
`cloudflared.service` en systemd y lo arranca habilitado para el arranque.

> **El token es un secreto de primer orden.** Quien lo tenga puede levantar una
> réplica del túnel y recibir tu tráfico. Asegura el fichero:
>
> ```bash
> sudo chmod 600 /etc/cloudflared/config.yml
> ```

Comprueba que levantó y que registró las conexiones:

```bash
sudo systemctl status cloudflared          # active (running)
sudo journalctl -u cloudflared -n 30 --no-pager
```

En el log deben aparecer cuatro líneas `Registered tunnel connection` con
`connIndex=0..3`: son las cuatro conexiones salientes que `cloudflared` abre
hacia al menos dos centros de datos distintos. Con eso, la caída de un centro de
datos no te deja sin servicio.

### 6.3 Publicar el hostname

En el túnel recién creado, pestaña **Public Hostname** → **Add a public
hostname**:

| Campo | Valor | Por qué |
|---|---|---|
| Subdomain | `ws` | |
| Domain | `disalud.org` | |
| Path | *(vacío)* | Todo el hostname va al mismo sitio: `/socket.io`, `/health` y `/internal/emit` |
| Type | `HTTP` | **No `HTTPS`**: el tramo hasta el contenedor es local y va en claro a propósito |
| URL | `localhost:8080` | El puerto que publica el contenedor en `127.0.0.1` |

El registro DNS lo crea Cloudflare solo, como un `CNAME` proxiado al UUID del
túnel. No tienes que tocar la pestaña DNS.

> Si cambiaste `PORT` en `.env`, la URL tiene que cambiar aquí también. Es la
> causa número uno de los 502 después de una modificación.

### 6.4 Parámetros de origen

Bajo **Additional application settings** hay un puñado de ajustes que controlan
cómo `cloudflared` habla con el contenedor. **Los valores por defecto son
correctos para este proyecto**; esta tabla está para que sepas qué significan
antes de tocar nada:

| Parámetro | Defecto | Qué hace aquí |
|---|---|---|
| `connectTimeout` | 30 s | Margen para abrir el TCP contra `localhost:8080`. En local sobra de largo. |
| `tcpKeepAlive` | 30 s | Keepalive hacia el contenedor. Mantiene viva la conexión que transporta el WebSocket. |
| `keepAliveTimeout` | 1 m 30 s | Cuándo descarta una conexión ociosa del pool. No afecta a los WebSockets activos. |
| `httpHostHeader` | *(vacío)* | Reescribiría el `Host`. No hace falta: el servidor no enruta por hostname. |
| `noTLSVerify` | `false` | Irrelevante con `Type: HTTP`. |
| `disableChunkedEncoding` | `false` | **Déjalo en `false`.** Activarlo estorba al long-polling. |

La opción de **Protect with Access** merece un apartado propio; está en la
sección 9.5, y la respuesta corta es que no.

---

## 7. Ruta B — túnel local con `config.yml`

Si prefieres que la configuración viva en el VPS (y opcionalmente en el repo),
el flujo cambia: se autentica el host una vez y el ingress pasa a un fichero.

```bash
cloudflared tunnel login          # abre una URL; autoriza la zona disalud.org
cloudflared tunnel create disalud-ws
cloudflared tunnel route dns disalud-ws ws.disalud.org
```

`create` imprime un UUID y deja un JSON de credenciales en `~/.cloudflared/`.
Con eso, el fichero de configuración:

```yaml
# /etc/cloudflared/config.yml
tunnel: <UUID-que-devolvió-create>
credentials-file: /etc/cloudflared/<UUID>.json

# Aplica a todos los servicios de abajo.
originRequest:
  connectTimeout: 30s
  tcpKeepAlive: 30s

ingress:
  # Todo el hostname al contenedor: /socket.io, /health y /internal/emit.
  - hostname: ws.disalud.org
    service: http://localhost:8080

  # Regla final obligatoria: cualquier otra cosa recibe un 404 sin llegar al origen.
  - service: http_status:404
```

Mueve las credenciales a `/etc/cloudflared/`, valida e instala:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/<UUID>.json

cloudflared tunnel ingress validate                    # "Validating rules... OK"
cloudflared tunnel ingress rule https://ws.disalud.org/socket.io/   # debe casar la regla 1

sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

La ventaja de esta ruta: `cloudflared tunnel ingress validate` te dice si el YAML
está bien **antes** de reiniciar nada, y `cloudflared tunnel info disalud-ws`
funciona desde la línea de comandos (en la ruta A no, porque requiere el
`cert.pem` que deja `tunnel login`). La desventaja: cada cambio exige SSH y un
reinicio del servicio.

---

## 8. Ruta C — `cloudflared` dentro del compose

Crea el túnel en el panel como en la ruta A, pero en vez de `service install`
añade un `docker-compose.override.yml` junto al compose del repo:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
    depends_on: [ws]
```

Con `TUNNEL_TOKEN=...` añadido a tu `.env`. Dos cambios que **no** son
opcionales:

1. En el **Public Hostname**, la URL pasa a ser `http://ws:8080`: el nombre del
   servicio en la red de compose, no `localhost` (dentro del contenedor de
   `cloudflared`, `localhost` es él mismo).
2. Puedes borrar la sección `ports` de `docker-compose.yml`. Con el túnel en la
   misma red de compose, ya no hace falta publicar el puerto en el host, y así
   el servicio deja de ser accesible incluso desde la propia máquina.

Si en cambio dejas `ports` y pones `HOST_BIND=0.0.0.0` para que el contenedor de
`cloudflared` llegue por la IP del host, asegúrate de cerrar el 8080 en el
firewall. La opción limpia es la red de compose.

---

## 9. Ajustes de la zona que afectan a Socket.IO

Aquí es donde se pierden las tardes. Todo esto se configura en el panel de la
**zona** (`disalud.org`), no en el túnel.

### 9.1 WebSockets

Panel → **Network** → **WebSockets**. Viene **activado por defecto** y tiene que
seguir así. Si alguien lo apagó, los clientes no dejan de funcionar —Socket.IO
cae a long-polling— pero los avisos llegan con más latencia y el servidor
aguanta muchas menos conexiones por el mismo tráfico.

### 9.2 Bot Fight Mode — la trampa de este proyecto

**Este es el ajuste que más probablemente te rompa el despliegue**, y el síntoma
no se parece a la causa.

`POST /internal/emit` lo hace el servidor de Vercel: sin navegador, sin
JavaScript, sin cabeceras de Chrome. Es exactamente el perfil que **Bot Fight
Mode** (plan Free) desafía. Cuando lo hace, Vercel recibe un HTML de desafío en
vez de tu JSON, los avisos dejan de llegar en vivo y en los logs de este
servidor **no aparece nada**, porque la petición nunca llegó al túnel.

Lo peor de Bot Fight Mode es que **no se puede exceptuar**: corre fuera del
motor de reglas, así que una regla WAF con acción *Skip* no le afecta. Las
opciones reales son dos: apagarlo, o subir a un plan con **Super Bot Fight
Mode**, que sí admite excepciones.

Si estás en Pro o superior con Super Bot Fight Mode, hay además una pauta
específica de Cloudflare para quien usa túneles: **deja «Definitely automated»
en *Allow***. Con la acción de bloqueo o desafío, el propio upgrade a WebSocket
puede fallar con `websocket: bad handshake`.

Y si quieres conservar el desafío para el resto del sitio, crea una regla
personalizada con acción *Skip* → *All Super Bot Fight Mode rules* sobre:

```
(http.host eq "ws.disalud.org")
```

El hostname entero, no solo `/internal/emit`: el handshake de Socket.IO también
es tráfico automatizado a ojos del clasificador.

> Que `/internal/emit` quede fuera del anti-bot no lo deja desprotegido: exige
> `Authorization: Bearer $REALTIME_INTERNAL_SECRET` y responde 401 sin él. Esa es
> su defensa, y es la adecuada para un endpoint servidor-a-servidor.

### 9.3 Rate limiting

Si tienes reglas de límite de tasa en la zona, **excluye este hostname**. Un solo
cliente en long-polling genera una petición cada pocos segundos de forma
sostenida y perfectamente legítima; cualquier umbral pensado para páginas web lo
tomará por abuso. Añade `http.host ne "ws.disalud.org"` a la expresión de tus
reglas existentes.

### 9.4 Caché

Con la configuración por defecto de Cloudflare no hay problema: solo se cachean
extensiones estáticas conocidas, y aquí no hay ninguna. Pero si alguien creó una
Cache Rule de *Cache Everything* para el dominio, este hostname tiene que quedar
fuera —cachear `/socket.io/` rompería el transporte y cachear `/health` te haría
ver `ok` mientras el contenedor está caído. Regla defensiva, si quieres
asegurarte:

**Cache Rules** → nueva regla → si `http.host eq "ws.disalud.org"` → *Bypass
cache*.

### 9.5 Cloudflare Access: no

Es tentador poner Access delante de un hostname interno, pero aquí sería un
error. Este hostname lo consumen navegadores de pacientes y el servidor de
Vercel, no personas con sesión de Zero Trust. Access pondría una pantalla de
login por delante y rompería a la vez el handshake de Socket.IO y
`/internal/emit`.

La autenticación de este servicio ya está resuelta en otra capa: tickets JWT de
60 segundos para los sockets y un bearer secreto para el endpoint interno.

### 9.6 SSL/TLS y redirecciones

El modo de cifrado de la zona (**Full**, **Full (strict)**) no afecta al tramo
del túnel, que no usa TLS. **Always Use HTTPS** puede quedarse activado sin
problema: los clientes usan `wss://` y `https://` desde el principio.

---

## 10. Timeouts: por qué esta app cabe en los límites

Cloudflare impone límites a las conexiones que atraviesan su red. Merece la pena
verlos junto a los valores de `src/socket/server.ts`, porque la conclusión es
tranquilizadora:

| Límite de Cloudflare | Valor | Qué hace este servidor | ¿Choca? |
|---|---|---|---|
| Proxy Read Timeout (error 524) | 125 s | Una petición de long-polling se resuelve como muy tarde con el ping, a los 25 s | No, con holgura de 5× |
| Proxy Write Timeout | 30 s | Las respuestas son JSON diminutos | No |
| Idle timeout de WebSocket | Cierra la conexión si no viaja nada en ningún sentido | `pingInterval: 25_000` manda un ping cada 25 s | No |
| Reinicios de la red de Cloudflare | Pueden cortar WebSockets en cualquier momento | El cliente reconecta solo; `connectionStateRecovery` restaura la sesión si vuelve en menos de 2 minutos | Se absorbe |

Es decir: los `pingInterval: 25_000` y `pingTimeout: 20_000` del servidor no son
arbitrarios, son justo lo que mantiene la conexión viva bajo estos límites. Si
alguna vez los subes, revisa esta tabla antes.

La última fila importa para entender un comportamiento normal: Cloudflare
reinicia servidores cuando despliega código, y eso termina WebSockets. Ver
reconexiones esporádicas en los logs **no es un fallo**; es el modo de operación
esperado, y la app está construida para ello.

---

## 11. El firewall del VPS

`cloudflared` solo necesita **salida** al puerto 7844, TCP y UDP. Nada de
entrada:

```bash
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status verbose
```

`ufw` permite todo el tráfico saliente por defecto, así que con esto basta. No
abras 80 ni 443: no hacen falta.

**Si tu proveedor filtra el tráfico saliente**, permite 7844 TCP y UDP hacia los
rangos de Cloudflare Tunnel. El UDP es para QUIC, que es el protocolo preferido;
si solo puedes abrir TCP, fuerza HTTP/2 añadiendo una línea a
`/etc/cloudflared/config.yml`:

```yaml
protocol: http2
```

Y reinicia con `sudo systemctl restart cloudflared`. Tendrás algo menos de
rendimiento, pero el túnel funciona igual.

Para saber si es tu caso, el síntoma en el log es explícito:

```bash
sudo journalctl -u cloudflared | grep -iE 'quic|i/o timeout|DialContext'
```

Un `failed to dial a quic connection` seguido de conexiones que sí se registran
significa que UDP está bloqueado y `cloudflared` ya cayó a HTTP/2 solo. Un
`DialContext error: dial tcp ...: i/o timeout` **además** del anterior significa
que ambos están bloqueados y el túnel no puede conectar en absoluto.

El puerto 443 saliente es opcional: solo lo usan la autoactualización y la
validación de JWT de Access, ninguna de las cuales necesitamos.

---

## 12. Verificación

Cuatro niveles, de menos a más profundo. Si el nivel N falla, no sigas al N+1.

### Nivel 1 — el túnel está arriba

```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 20 --no-pager | grep -i 'registered tunnel connection'
```

Esperado: cuatro conexiones registradas. En el panel, el túnel aparece como
**Healthy**.

### Nivel 2 — HTTP llega al contenedor

```bash
curl https://ws.disalud.org/health
# {"status":"ok","uptimeSeconds":42,"connections":0,"protocol":1}
```

Ese `protocol: 1` es `REALTIME_PROTOCOL_VERSION`, y tiene que coincidir con el de
`disalud-org`.

Comprueba también que el endpoint interno rechaza a quien no trae el bearer —y,
de paso, que Cloudflare no está interponiendo un desafío:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ws.disalud.org/internal/emit
# 401
```

**Un 401 es la respuesta correcta.** Si ves un 403, un 503 o HTML con la palabra
«challenge», no es tu servidor: es Bot Fight Mode (sección 9.2).

### Nivel 3 — el transporte de Socket.IO

```bash
curl -s "https://ws.disalud.org/socket.io/?EIO=4&transport=polling"
# 0{"sid":"...","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,...}
```

Dos cosas que mirar: `upgrades:["websocket"]` confirma que el camino hasta el
WebSocket está abierto, y `pingInterval:25000` confirma que estás hablando con
**tu** servidor y no con una página de error.

Y el CORS, que es lo que usa el navegador de verdad:

```bash
curl -sI -H "Origin: https://disalud.org" "https://ws.disalud.org/socket.io/?EIO=4&transport=polling" | grep -i access-control
# access-control-allow-origin: https://disalud.org
```

Si esa cabecera no aparece, el origen no está en `ALLOWED_ORIGINS` de tu `.env`.
Va el dominio de la **app**, no el de este servidor.

### Nivel 4 — handshake completo con un ticket real

Los tres niveles anteriores no prueban la autenticación. Este script firma un
ticket de prueba con el mismo secreto que usa el servidor y completa el
handshake entero a través del túnel. Ejecútalo en el VPS, desde el directorio del
repo:

```bash
#!/usr/bin/env bash
# verificar-tunel.sh — handshake completo de Socket.IO a través del túnel.
set -euo pipefail

HOST="${1:-https://ws.disalud.org}"
ORIGIN="${2:-https://disalud.org}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# El servidor usa el secreto tal cual (bytes UTF-8), no decodificado de base64.
SECRET="$(grep -E '^REALTIME_TICKET_SECRET=' .env | cut -d= -f2-)"
NOW="$(date +%s)"

HEADER='{"alg":"HS256","typ":"JWT"}'
PAYLOAD="{\"sub\":\"prueba-cloudflared\",\"role\":\"doctor\",\"aud\":\"disalud-ws\",\"iss\":\"disalud-org\",\"iat\":${NOW},\"exp\":$((NOW+60))}"

H="$(printf '%s' "$HEADER"  | b64url)"
P="$(printf '%s' "$PAYLOAD" | b64url)"
SIG="$(printf '%s' "$H.$P" | openssl dgst -sha256 -hmac "$SECRET" -binary | b64url)"
TICKET="$H.$P.$SIG"

# 1) Abrir la sesión de Engine.IO y quedarnos con el sid.
OPEN="$(curl -s -H "Origin: $ORIGIN" "$HOST/socket.io/?EIO=4&transport=polling")"
SID="$(printf '%s' "$OPEN" | grep -o '"sid":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$SID" ] || { echo "FALLO: sin sid. Respuesta: $OPEN"; exit 1; }
echo "sid obtenido: $SID"

# 2) Enviar el paquete CONNECT del namespace con el ticket.
curl -s -o /dev/null -X POST \
  -H "Origin: $ORIGIN" -H 'Content-Type: text/plain;charset=UTF-8' \
  --data-raw "40{\"token\":\"$TICKET\"}" \
  "$HOST/socket.io/?EIO=4&transport=polling&sid=$SID"

# 3) Leer el veredicto del servidor.
RES="$(curl -s -H "Origin: $ORIGIN" "$HOST/socket.io/?EIO=4&transport=polling&sid=$SID")"
echo "respuesta: $RES"

case "$RES" in
  40*) echo "OK — handshake aceptado; el túnel y la autenticación funcionan." ;;
  44*) echo "FALLO — ticket rechazado. Revisa REALTIME_TICKET_SECRET." ;;
  *)   echo "FALLO — respuesta inesperada." ;;
esac
```

```bash
chmod +x verificar-tunel.sh && ./verificar-tunel.sh
```

Un `40{"sid":"..."}` significa que el ticket se verificó y el socket entró en su
sala: el camino completo funciona de extremo a extremo. Un
`44{"message":"Ticket inválido o caducado.","data":{"code":"ticket_invalid"}}`
apunta al secreto, casi siempre por un salto de línea colado al copiarlo.

El ticket vive 60 segundos y no deja nada en el servidor, así que el script es
seguro de repetir. Aun así, no lo dejes en un `history` compartido ni lo ejecutes
con el secreto en la línea de comandos.

---

## 13. Observabilidad

`cloudflared` puede exponer métricas de Prometheus y dos endpoints de estado en
una dirección local. Añade a `/etc/cloudflared/config.yml`:

```yaml
metrics: 127.0.0.1:2000
```

Reinicia y tendrás:

```bash
curl -s http://127.0.0.1:2000/ready
# {"status":200,"readyConnections":4,...}

curl -s http://127.0.0.1:2000/metrics | grep -E '^cloudflared_tunnel_(ha_connections|total_requests)'
```

`readyConnections` es la métrica útil para vigilar: mientras sea ≥ 1 el túnel
sirve tráfico; un 0 sostenido significa que perdiste todas las conexiones con
Cloudflare. Escuchando en `127.0.0.1` no queda expuesto.

Para el día a día, los logs siguen siendo lo más directo:

```bash
sudo journalctl -u cloudflared -f              # en vivo
sudo journalctl -u cloudflared --since '1 hour ago' -p warning
```

Y en el panel, **Zero Trust** → **Networks** → **Tunnels** muestra el estado del
conector, su versión y cuándo se vio por última vez.

---

## 14. Alta disponibilidad con réplicas

Un solo `cloudflared` ya abre cuatro conexiones a dos o más centros de datos, así
que la red de Cloudflare no es el punto débil. El punto débil es el VPS: si se
reinicia, el servicio cae con él.

Si eso llega a importar, una **réplica** es otra instancia de `cloudflared`, en
otra máquina, apuntando al mismo túnel (mismo token). El tráfico va a la más
cercana geográficamente y se admiten hasta 25. En el panel: el túnel →
**Add a replica**.

Para este proyecto hay que entender una cosa antes de montarlo: **una réplica en
otra máquina necesita su propio contenedor `ws` corriendo ahí**, porque
`service: localhost:8080` es local a cada host. Y en cuanto haya dos instancias
del servidor, los sockets quedan repartidos entre ellas y un aviso emitido en una
no alcanza a los clientes de la otra. Ese es justo el momento de definir
`REDIS_URL`: el adapter de Redis se activa solo y vuelve a unir las dos mitades
(ver `src/lib/redis.ts`).

Mientras el proyecto siga con una sola instancia, las réplicas no aportan: lo que
hay que vigilar es el VPS, no el túnel.

---

## 15. Operación

| Qué quieres | Comando |
|---|---|
| Estado del servicio | `sudo systemctl status cloudflared` |
| Logs en vivo | `sudo journalctl -u cloudflared -f` |
| Reiniciar el túnel | `sudo systemctl restart cloudflared` |
| Actualizar `cloudflared` | `sudo apt-get update && sudo apt-get install --only-upgrade cloudflared && sudo systemctl restart cloudflared` |
| Ver conexiones activas | `curl -s http://127.0.0.1:2000/ready` |
| Validar el YAML (ruta B) | `cloudflared tunnel ingress validate` |

Un par de notas sobre el ciclo de vida:

- **La unidad de systemd arranca con `--no-autoupdate`.** `cloudflared` no se
  actualiza solo; lo haces tú por apt. Conviene hacerlo cada pocos meses.
- **Reiniciar el túnel corta los WebSockets abiertos.** Los clientes reconectan
  solos en segundos y los avisos de ese hueco siguen llegando por el camino lento
  (el KV de `disalud-org`, con 5 minutos de vigencia). No hay ventana de
  mantenimiento que negociar.
- **Reiniciar el contenedor no requiere tocar el túnel.** `cloudflared` reintenta
  contra `localhost:8080` y vuelve solo en cuanto el contenedor responde. En ese
  intervalo, Cloudflare devuelve 502.
- **Rotar el token** (si se filtró): borra el túnel en el panel, crea uno nuevo y
  repite `sudo cloudflared service install <token-nuevo>`. El hostname público
  hay que volver a declararlo en el túnel nuevo.

---

## 16. Problemas frecuentes

| Síntoma | Causa y arreglo |
|---|---|
| **Error 1033** («Argo Tunnel error») | El túnel no está conectado. `sudo systemctl status cloudflared` y mira el log: casi siempre es el token o la salida por 7844. |
| **Error 502 / 504** | El túnel llega pero el contenedor no responde. `docker compose ps` y comprueba que la URL del Public Hostname coincide con `PORT` de `.env`. |
| **Error 1016** | El registro DNS apunta a un túnel que ya no existe. Borra el `CNAME` huérfano en la pestaña DNS y vuelve a declarar el Public Hostname. |
| **Error 524** | Una respuesta tardó más de 125 s. No debería pasar aquí (ver sección 10); si pasa, el contenedor está bloqueado, no el túnel. |
| **HTML de desafío en vez de JSON** | Bot Fight Mode contra `/internal/emit`. Sección 9.2. |
| **`websocket: bad handshake` en los logs** | Super Bot Fight Mode con «Definitely automated» en bloqueo o desafío. Ponlo en *Allow*. |
| **Todo va pero por polling, nunca por WebSocket** | **WebSockets** desactivado en la zona (panel → **Network**), o un proxy corporativo en la red del cliente. Lo segundo no tiene arreglo desde aquí y es justo el caso que el long-polling cubre. |
| **`failed to dial a quic connection`** | UDP 7844 bloqueado. Si el túnel igualmente conecta, ya cayó a HTTP/2 y puedes ignorarlo; si no, añade `protocol: http2` (sección 11). |
| **`DialContext error: ... i/o timeout`** | TCP 7844 bloqueado. Habla con el proveedor: sin ese puerto el túnel no funciona. |
| **`cloudflared service is already installed`** | Queda una instalación previa. `sudo cloudflared service uninstall` y repite. |
| **CORS en el navegador** | Falta el origen en `ALLOWED_ORIGINS`. Va el dominio de la app (`https://disalud.org`), no el de este servidor. Tras cambiarlo, `docker compose up -d`. |
| **`apt` avisa de formato heredado** | Tienes el repositorio en `.list`. Pásalo a `.sources` (sección 4) y borra el `.list`. |
| **El socket conecta y se cae enseguida** | No es el túnel: `REALTIME_TICKET_SECRET` difiere entre este servidor y Vercel. Confírmalo con el script del nivel 4. |

Cuando dudes de si el problema está en Cloudflare o en el contenedor, la prueba
que lo separa en un solo comando es esta:

```bash
curl -s http://127.0.0.1:8080/health && echo '  <- contenedor'
curl -s https://ws.disalud.org/health && echo '  <- a través del túnel'
```

Si el primero responde y el segundo no, el problema está entre Cloudflare y
`cloudflared`. Si falla el primero, el túnel es inocente.

---

## 17. Desinstalar

Para revertirlo todo en el VPS:

```bash
sudo cloudflared service uninstall
sudo apt-get remove --purge -y cloudflared
sudo rm -rf /etc/cloudflared /usr/share/keyrings/cloudflare-main.gpg
sudo rm -f /etc/apt/sources.list.d/cloudflared.sources /etc/apt/sources.list.d/cloudflared.list
```

Y en el panel de Cloudflare, borra el túnel y el registro DNS de `ws`. Ten en
cuenta que, a partir de ese momento, el servidor solo es accesible desde la
propia máquina: si quieres exponerlo de otra forma, necesitarás un proxy inverso,
un certificado y abrir puertos —justamente lo que el túnel evitaba.
