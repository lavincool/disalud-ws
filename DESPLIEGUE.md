# Despliegue

Guía completa para poner `disalud-ws` en marcha en un servidor **Ubuntu 26.04**
con Docker Compose y Cloudflare Tunnel.

## Cómo encaja todo

```
  navegador del médico    ─┐
  navegador del paciente  ─┼──▶  Cloudflare  ──▶  cloudflared  ──▶  contenedor ws
  disalud-org (Vercel)    ─┘     ws.disalud.org   (systemd)         127.0.0.1:8080
                                 TLS + dominio    túnel saliente    docker compose
                                                  └── mismo VPS (Ubuntu 26.04) ──┘
```

Lo importante: **el VPS no abre ningún puerto de entrada**. `cloudflared` sale
hacia Cloudflare (puerto 7844) y el tráfico vuelve por esa misma conexión. Por
eso aquí no hay Nginx, ni Caddy, ni certificados que renovar: el dominio, el
HTTPS y el certificado los pone Cloudflare.

## Antes de empezar

| Necesitas | Detalle |
|---|---|
| Un VPS con Ubuntu 26.04 | 1 vCPU y 1 GB de RAM sobran. La compilación de la imagen es lo más pesado. |
| Acceso `sudo` | Para instalar Docker y el servicio de `cloudflared`. |
| Un dominio en Cloudflare | La zona (p. ej. `disalud.org`) debe estar activa en tu cuenta. |
| Los secretos compartidos | Los mismos dos valores que pondrás en Vercel. Se generan en el paso 3. |

---

## 1. Instalar Docker

Repositorio oficial de Docker (versión más reciente, la recomendada):

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

> Si `apt-get update` se queja de que no existe el repositorio para el nombre en
> clave de 26.04 (pasa cuando Docker aún no ha publicado esa serie), sustituye
> `$(. /etc/os-release && echo "$VERSION_CODENAME")` por `noble` en la línea del
> `echo` y repite los dos últimos comandos. Los paquetes de 24.04 funcionan sin
> problema.

**Alternativa más corta**, con los paquetes que ya trae Ubuntu (versión algo más
antigua, suficiente para este proyecto):

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
```

En ambos casos, deja el servicio activo y añade tu usuario al grupo `docker`
para no tener que escribir `sudo` en cada comando:

```bash
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Cierra la sesión SSH y vuelve a entrar (o ejecuta `newgrp docker`) para que el
grupo surta efecto. Comprueba:

```bash
docker --version && docker compose version
```

## 2. Traer el código

```bash
sudo apt install -y git
git clone <url-del-repo> disalud-ws
cd disalud-ws
```

No hace falta instalar Node ni Bun en el servidor: todo se compila dentro de la
imagen.

## 3. Configurar el entorno

```bash
cp .env.example .env
openssl rand -base64 48    # para REALTIME_TICKET_SECRET
openssl rand -base64 48    # para REALTIME_INTERNAL_SECRET
nano .env
```

Rellena:

- `REALTIME_TICKET_SECRET` y `REALTIME_INTERNAL_SECRET` con los dos valores
  generados. Deben ser **distintos entre sí** y **distintos de `JWT_SECRET`** de
  la app: con ese secreto, un compromiso de este servidor permitiría acuñar
  cookies de sesión, que duran 365 días.
- `ALLOWED_ORIGINS` con el dominio de la **app**, no el de este servidor
  (`https://disalud.org,https://www.disalud.org`).

Los demás valores pueden quedarse como vienen. `.env` está en `.gitignore` y no
se copia a la imagen, pero aun así conviene `chmod 600 .env`.

## 4. Levantar el servicio

```bash
docker compose up -d --build
```

La primera vez tarda un par de minutos (instala dependencias y compila
TypeScript). Comprueba que arrancó sano:

```bash
docker compose ps                        # STATUS debe decir "healthy"
curl http://127.0.0.1:8080/health        # {"status":"ok",...}
docker compose logs -f ws                # "disalud-ws escuchando"
```

Si el contenedor se reinicia en bucle, casi siempre es la configuración: los
logs dirán `Configuración inválida en las variables de entorno` y la línea
exacta que falta.

En este punto el servidor funciona, pero solo es accesible desde la propia
máquina. Falta el túnel.

## 5. Instalar cloudflared

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

Ese repositorio usa la suite `any`, así que sirve igual en 26.04 que en
cualquier otra versión.

## 6. Crear el túnel

### Opción A — desde el panel de Cloudflare (recomendada)

1. Entra en el panel de Cloudflare → **Zero Trust** → **Networks** → **Tunnels**
   → **Create a tunnel** → tipo **Cloudflared**.
2. Ponle un nombre (`disalud-ws`) y guarda.
3. En la pantalla de instalación, elige **Debian / Ubuntu** y copia el comando
   que te da, que incluye el token del túnel. Tiene esta forma:

   ```bash
   sudo cloudflared service install eyJhIjoiXXXXXXXX...
   ```

   Ejecútalo en el VPS. Deja `cloudflared` instalado como servicio de systemd,
   arrancado y habilitado en el arranque.
4. Vuelve al panel, pestaña **Public Hostname** → **Add a public hostname**:

   | Campo | Valor |
   |---|---|
   | Subdomain | `ws` |
   | Domain | `disalud.org` |
   | Type | `HTTP` |
   | URL | `localhost:8080` |

   El registro DNS lo crea Cloudflare solo; no tienes que tocarlo.

`cloudflared` corre en la propia máquina, así que `localhost:8080` es justo el
puerto que publica el contenedor en `127.0.0.1`. **Tipo `HTTP`, no `HTTPS`**: el tramo entre
`cloudflared` y el contenedor es local y va en claro a propósito; el TLS de cara
a internet lo pone Cloudflare.

### Opción B — cloudflared dentro del mismo compose

Si prefieres que el túnel viva en un contenedor junto al servidor, crea el túnel
en el panel igual que arriba pero, en vez del `service install`, añade un
`docker-compose.override.yml`:

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

Con `TUNNEL_TOKEN=...` en tu `.env`. En el **Public Hostname**, la URL pasa a ser
`http://ws:8080` (el nombre del servicio en la red de compose) en lugar de
`localhost:8080`. Ojo: en esta variante `cloudflared` no necesita el puerto
publicado en el host, así que puedes borrar la sección `ports` del
`docker-compose.yml`.

### Opción C — túnel gestionado en local (con fichero de configuración)

```bash
cloudflared tunnel login
cloudflared tunnel create disalud-ws
cloudflared tunnel route dns disalud-ws ws.disalud.org
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID-que-devolvió-create>
credentials-file: /home/<usuario>/.cloudflared/<UUID>.json
ingress:
  - hostname: ws.disalud.org
    service: http://localhost:8080
  - service: http_status:404
```

```bash
sudo cloudflared --config ~/.cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

## 7. Comprobar el túnel

```bash
sudo systemctl status cloudflared          # active (running)
sudo journalctl -u cloudflared -f          # "Registered tunnel connection"

curl https://ws.disalud.org/health
# {"status":"ok","uptimeSeconds":42,"connections":0,"protocol":1}

# El endpoint interno debe rechazar a quien no traiga el bearer:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ws.disalud.org/internal/emit
# 401

# Y el transporte de socket.io debe responder con su paquete de apertura:
curl -s "https://ws.disalud.org/socket.io/?EIO=4&transport=polling"
# 0{"sid":"...","upgrades":["websocket"],...}
```

Ese `upgrades:["websocket"]` confirma que el camino hasta el WebSocket está
abierto. Cloudflare Tunnel soporta WebSockets de forma nativa y la opción
**WebSockets** de la zona (panel → **Network**) viene activada por defecto; si
alguien la apagó, los clientes seguirán funcionando por long-polling, pero más
lentos.

## 8. Conectar disalud-org

En Vercel, en el proyecto `disalud-org`, define:

```
REALTIME_URL=https://ws.disalud.org
REALTIME_TICKET_SECRET=<el mismo de aquí>
REALTIME_INTERNAL_SECRET=<el mismo de aquí>
```

Y vuelve a desplegar. Despliega **primero este servidor**: mientras `REALTIME_URL`
no esté definida, la app degrada sola a «sin avisos en vivo» y no falla nada.

## 9. Cerrar el servidor

Como nadie entra por puertos, el firewall puede quedarse en lo mínimo:

```bash
sudo ufw allow OpenSSH
sudo ufw enable
```

No abras 80 ni 443: no hacen falta. Lo único que necesita el túnel es salida
hacia Cloudflare por el puerto 7844 (TCP/UDP), que suele estar permitida.

---

## Operación diaria

| Qué quieres | Comando |
|---|---|
| Ver el estado | `docker compose ps` |
| Ver los logs | `docker compose logs -f ws` |
| Últimas 100 líneas | `docker compose logs --tail=100 ws` |
| Salud y nº de conexiones | `curl http://127.0.0.1:8080/health` |
| Reiniciar | `docker compose restart ws` |
| Parar | `docker compose down` |
| Actualizar a la última versión | `git pull && docker compose up -d --build` |
| Liberar imágenes viejas | `docker image prune -f` |
| Logs del túnel | `sudo journalctl -u cloudflared -f` |
| Reiniciar el túnel | `sudo systemctl restart cloudflared` |
| Actualizar cloudflared | `sudo apt-get update && sudo apt-get install --only-upgrade cloudflared && sudo systemctl restart cloudflared` |

Tras un reinicio del VPS no hay que hacer nada: el contenedor tiene
`restart: unless-stopped` y `cloudflared` queda habilitado como servicio.

**Al actualizar** hay unos segundos de corte mientras se reconstruye la imagen.
Los clientes reconectan solos, y los avisos que caigan en ese hueco siguen
llegando: `disalud-org` los guarda en su KV con 5 minutos de vigencia y los
entrega en la siguiente carga de página.

**Si cambias el contrato de eventos** (`src/events.ts`), despliega este servidor
y `disalud-org` juntos: el test de contrato de cada repo existe para que la
divergencia salte antes de llegar aquí.

---

## Problemas frecuentes

| Síntoma | Causa y arreglo |
|---|---|
| `docker compose up` dice que no encuentra `.env` | No lo copiaste. `cp .env.example .env` y rellénalo. |
| El contenedor reinicia en bucle | `docker compose logs ws`: casi siempre `Configuración inválida`, con la variable que falta. Los secretos necesitan 32 caracteres como mínimo. |
| `permission denied` al hablar con Docker | Falta el grupo: `sudo usermod -aG docker $USER` y volver a entrar por SSH. |
| `bind: address already in use` | Otro proceso ocupa el 8080. Cambia `PORT` en `.env` y actualiza la URL del Public Hostname. |
| Error 502 en `https://ws.disalud.org` | El túnel llega pero el contenedor no responde. Mira `docker compose ps` y que la URL del Public Hostname coincida con `PORT`. |
| Error 1033 o DNS que no resuelve | El túnel no está conectado: `sudo systemctl status cloudflared`. |
| En el navegador: error de CORS | Falta el origen de la app en `ALLOWED_ORIGINS`. Va el dominio de `disalud.org`, no el de este servidor. Tras cambiarlo, `docker compose up -d`. |
| El socket conecta y se cae enseguida (`ticket_invalid`) | `REALTIME_TICKET_SECRET` no es idéntico aquí y en Vercel. Ojo con los saltos de línea al copiar. |
| `/internal/emit` devuelve 401 desde la app | `REALTIME_INTERNAL_SECRET` distinto entre los dos sitios. |
| Los sockets se caen cada ~2 minutos | Suele ser un proxy o cortafuegos intermedio del cliente. El respaldo por long-polling mantiene la app usable; no hay nada que tocar en el servidor. |
| No pongas Cloudflare Access delante | Este hostname lo consumen navegadores y el servidor de Vercel, no personas con sesión de Zero Trust. La protección de `/internal/emit` es el bearer secreto. |
