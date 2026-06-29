# Sistema de Seguimiento de Recorridos en Tiempo Real

Sistema web para el seguimiento en tiempo real de recorridos de transporte empresarial. Los choferes marcan el estado de cada pasajero desde su celular, y la oficina ve el avance en vivo desde un dashboard.

---

## Pantallas

| Pantalla | URL | Para quién |
|---|---|---|
| Dashboard | `/dashboard.html` | Oficina — vista en tiempo real de todos los recorridos |
| App Chofer | `/chofer.html` | Chofer — marcado de pasajeros desde el celular |
| Panel Admin | `/admin.html` | Administrador — gestión de recorridos, pasajeros y reportes |

---

## Funcionalidades

### Chofer
- Ingresa con la **placa de su vehículo**
- Inicia el recorrido del día o registra que no asistirá
- Marca cada pasajero como **Recogido** o **No estaba**
- Al terminar, registra la llegada a la oficina
- Puede salir y volver: el estado del día se recupera automáticamente
- Ve un historial de sus sesiones anteriores por fecha

### Dashboard (oficina)
- Ve todos los recorridos activos en tiempo real
- Progreso por recorrido: recogidos / no estaban / avisaron / total
- Alerta cuando un chofer llega a la oficina

### Panel Admin
- Crear y eliminar recorridos y pasajeros
- Marcar pasajeros que **avisaron que no van** (se refleja en tiempo real en la app del chofer)
- Generar reportes diarios por fecha
- Descargar reportes en **Excel (.xlsx)** con dos hojas: Resumen y Detalle de pasajeros
- Reiniciar la sesión del día de un recorrido

### Estados de pasajero

| Estado | Quién lo marca | Descripción |
|---|---|---|
| ✓ Recogido | Chofer | El chofer pasó y lo subió |
| ✗ No estaba | Chofer | El chofer pasó pero no estaba |
| 📵 Avisó que no va | Admin | El pasajero avisó con anticipación |

---

## Stack tecnológico

- **Backend:** Node.js + Express + Socket.io
- **Base de datos:** PostgreSQL (`pg`)
- **Reportes:** SheetJS (`xlsx`)
- **Autenticación admin:** Token en memoria + rate limiting
- **Frontend:** HTML + CSS + JS vanilla (sin frameworks)

---

## Deploy en Render (recomendado)

### 1. Crear la base de datos

1. En Render → **New +** → **PostgreSQL**
2. Elegir plan **Free** y región **Oregon**
3. Copiar la **Internal Database URL** una vez creada

### 2. Crear el Web Service

1. En Render → **New +** → **Web Service**
2. Conectar el repositorio de GitHub
3. Configurar:

| Campo | Valor |
|---|---|
| Branch | `main` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Plan | Free |

4. Agregar las siguientes **variables de entorno**:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Internal Database URL de PostgreSQL (Render la provee) |
| `ADMIN_USER` | Usuario del panel de administración |
| `ADMIN_PASS` | Contraseña del panel de administración |

5. Hacer clic en **Create Web Service**

Las tablas de la base de datos se crean automáticamente en el primer arranque.

> **Nota:** El plan Free de Render duerme el servidor tras 15 minutos sin tráfico. Se recomienda configurar un ping cada 10 minutos con [UptimeRobot](https://uptimerobot.com) apuntando a `/health`.

---

## Instalación local

### Requisitos
- Node.js 18 o superior
- PostgreSQL (local o remoto, por ejemplo [Supabase](https://supabase.com) free tier)

### Pasos

```bash
# 1. Clonar el repositorio
git clone git@github.com:izzysolutionsrrhh/sistema-transporte.git
cd sistema-transporte

# 2. Instalar dependencias
npm install

# 3. Crear el archivo de variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# 4. Iniciar el servidor
node server.js
```

### Variables de entorno (`.env`)

```env
DATABASE_URL=postgresql://usuario:contraseña@host:5432/nombre_db
ADMIN_USER=tu_usuario
ADMIN_PASS=tu_contraseña
PORT=3000
ALLOWED_ORIGIN=*
```

---

## Estructura del proyecto

```
sistema-transporte/
├── server.js          # Servidor Express + Socket.io
├── db.js              # Capa de datos (PostgreSQL)
├── public/
│   ├── chofer.html    # App móvil para choferes
│   ├── dashboard.html # Dashboard de oficina
│   └── admin.html     # Panel de administración
├── .env.example       # Plantilla de variables de entorno
└── package.json
```

---

## API REST

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/api/recorrido/:placa` | Estado actual de un recorrido |
| GET | `/api/dashboard` | Estado de todos los recorridos |
| GET | `/api/chofer/:placa/historial` | Historial de sesiones del chofer |
| POST | `/api/admin/login` | Iniciar sesión admin |
| POST | `/api/admin/logout` | Cerrar sesión admin |
| GET | `/api/admin/recorridos` | Listar recorridos y pasajeros |
| POST | `/api/admin/recorrido` | Crear recorrido |
| DELETE | `/api/admin/recorrido/:id` | Eliminar recorrido |
| POST | `/api/admin/pasajero` | Agregar pasajero |
| DELETE | `/api/admin/pasajero/:id` | Eliminar pasajero |
| POST | `/api/admin/aviso` | Marcar pasajero como "avisó" |
| DELETE | `/api/admin/aviso` | Desmarcar aviso |
| POST | `/api/admin/reporte/generar` | Generar reporte de una fecha |
| GET | `/api/admin/reporte/:fecha/xlsx` | Descargar reporte Excel |
| POST | `/api/admin/reset` | Reiniciar sesión del día |

---

## Ramas

| Rama | Propósito |
|---|---|
| `main` | Producción — código estable deployado en Render |
| `develop` | Desarrollo — todos los cambios van aquí primero |

---

## Licencia

Proyecto privado — todos los derechos reservados.
