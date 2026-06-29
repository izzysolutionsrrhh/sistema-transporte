require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const db = require('./db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH ─────────────────────────────────────────────────────────────────────

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('\n⚠️  ERROR: Variables de entorno ADMIN_USER y ADMIN_PASS son requeridas.');
  console.error('   Creá un archivo .env o seteá las variables en tu servicio de hosting.\n');
  process.exit(1);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const tokens = new Set();

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { usuario, clave } = req.body;
  if (usuario === ADMIN_USER && clave === ADMIN_PASS) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    tokens.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: 'Usuario o clave incorrectos' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  tokens.delete(req.headers['x-admin-token']);
  res.json({ ok: true });
});

// ─── REST API ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/recorrido/:codigo', async (req, res) => {
  const data = await db.getEstadoRecorrido(req.params.codigo.toUpperCase());
  if (!data) return res.status(404).json({ error: 'Código de recorrido no encontrado' });
  res.json(data);
});

app.get('/api/dashboard', async (req, res) => {
  res.json(await db.getEstadoTodos());
});

app.get('/api/chofer/:codigo/historial', async (req, res) => {
  const data = await db.getHistorialChofer(req.params.codigo.toUpperCase());
  if (!data) return res.status(404).json({ error: 'Recorrido no encontrado' });
  res.json(data);
});

app.get('/api/admin/recorridos', requireAdmin, async (req, res) => {
  res.json(await db.getAllRecorridosConPasajeros());
});

app.post('/api/admin/recorrido', requireAdmin, async (req, res) => {
  const { nombre, codigo } = req.body;
  if (!nombre?.trim() || !codigo?.trim())
    return res.status(400).json({ error: 'Nombre y código son requeridos' });
  try {
    const id = await db.crearRecorrido(nombre.trim(), codigo.trim().toUpperCase());
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'Esa placa ya está en uso' });
  }
});

app.delete('/api/admin/recorrido/:id', requireAdmin, async (req, res) => {
  await db.eliminarRecorrido(req.params.id);
  io.emit('estado_completo', await db.getEstadoTodos());
  res.json({ ok: true });
});

app.post('/api/admin/pasajero', requireAdmin, async (req, res) => {
  const { nombre, recorrido_id } = req.body;
  if (!nombre?.trim() || !recorrido_id)
    return res.status(400).json({ error: 'Nombre y recorrido son requeridos' });
  const id = await db.crearPasajero(nombre.trim(), recorrido_id);
  res.json({ id });
});

app.delete('/api/admin/pasajero/:id', requireAdmin, async (req, res) => {
  await db.eliminarPasajero(req.params.id);
  io.emit('estado_completo', await db.getEstadoTodos());
  res.json({ ok: true });
});

app.post('/api/admin/importar', requireAdmin, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!filas.length) return res.status(400).json({ error: 'El archivo está vacío' });
    const resultado = await db.importarRecorridos(filas);
    io.emit('estado_completo', await db.getEstadoTodos());
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: 'Error leyendo el archivo: ' + err.message });
  }
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  const { recorrido_id } = req.body;
  await db.resetSesionHoy(recorrido_id);
  io.emit('estado_completo', await db.getEstadoTodos());
  res.json({ ok: true });
});

app.post('/api/admin/aviso', requireAdmin, async (req, res) => {
  const { recorrido_id, pasajero_id } = req.body;
  if (!recorrido_id || !pasajero_id) return res.status(400).json({ error: 'Faltan datos' });
  const estadoRec = await db.marcarAviso(recorrido_id, pasajero_id, hora());
  io.to(`r:${estadoRec.recorrido.codigo}`).emit('estado_recorrido', estadoRec);
  io.emit('estado_completo', await db.getEstadoTodos());
  res.json({ ok: true });
});

app.delete('/api/admin/aviso', requireAdmin, async (req, res) => {
  const { recorrido_id, pasajero_id } = req.body;
  const estadoRec = await db.desmarcarAviso(recorrido_id, pasajero_id);
  if (estadoRec) io.to(`r:${estadoRec.recorrido.codigo}`).emit('estado_recorrido', estadoRec);
  io.emit('estado_completo', await db.getEstadoTodos());
  res.json({ ok: true });
});

app.get('/api/admin/reportes', requireAdmin, async (req, res) => {
  res.json(await db.listarReportes());
});

app.post('/api/admin/reporte/generar', requireAdmin, async (req, res) => {
  const { fecha } = req.body;
  res.json(await db.guardarReporte(fecha || undefined));
});

app.get('/api/admin/reporte/:fecha/xlsx', requireAdmin, async (req, res) => {
  const reporte = await db.getReporte(req.params.fecha);
  if (!reporte) return res.status(404).json({ error: 'Reporte no encontrado' });

  const estadoLabel = { completado: 'Completado', en_recorrido: 'En recorrido', no_asistio: 'No asistió', pendiente: 'Pendiente' };
  const tipoLabel   = { recogido: 'Recogido', no_estaba: 'No estaba', aviso: 'Avisó que no va', pendiente: 'Pendiente' };

  const wsResumen = XLSX.utils.aoa_to_sheet([
    [`Reporte de Recorridos — ${reporte.fecha}   (generado: ${reporte.generado})`],
    [],
    ['Recorrido', 'Placa', 'Estado', 'Hora inicio', 'Hora llegada', 'Total pasajeros', 'Recogidos', 'No estaban', 'Avisaron'],
    ...reporte.recorridos.map(r => [
      r.nombre, r.placa, estadoLabel[r.estado] || r.estado,
      r.hora_inicio || '-', r.hora_llegada || '-',
      r.total_pasajeros, r.recogidos, r.no_estaban, r.avisaron,
    ]),
  ]);
  wsResumen['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 15 }, { wch: 13 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  wsResumen['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }];

  const wsDetalle = XLSX.utils.aoa_to_sheet([
    ['Recorrido', 'Placa', 'Pasajero', 'Estado', 'Hora'],
    ...reporte.recorridos.flatMap(r =>
      r.detalle.map(p => [r.nombre, r.placa, p.nombre, tipoLabel[p.tipo] || p.tipo, p.hora || '-'])
    ),
  ]);
  wsDetalle['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 28 }, { wch: 18 }, { wch: 10 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');
  XLSX.utils.book_append_sheet(wb, wsDetalle, 'Detalle pasajeros');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="reporte-${reporte.fecha}.xlsx"`);
  res.send(buffer);
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('join_dashboard', async () => {
    socket.join('dashboard');
    socket.emit('estado_completo', await db.getEstadoTodos());
  });

  socket.on('join_recorrido', ({ codigo }) => {
    socket.join(`r:${codigo}`);
  });

  socket.on('iniciar_recorrido', async ({ codigo }) => {
    const estado = await db.iniciarRecorrido(codigo, hora());
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
  });

  socket.on('marcar_pasajero', async ({ sesion_id, pasajero_id, codigo, tipo }) => {
    const estado = await db.marcarPasajero(sesion_id, pasajero_id, hora(), tipo);
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
  });

  socket.on('llegar_oficina', async ({ sesion_id, codigo }) => {
    const horaLlegada = hora();
    const estado = await db.llegarOficina(sesion_id, horaLlegada);
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
    await db.guardarReporte();
    io.to('dashboard').emit('alerta_llegada', {
      recorrido: estado.recorrido.nombre,
      hora: horaLlegada,
      retirados: estado.retiros.filter(r => r.tipo === 'recogido').length,
      total: estado.pasajeros.length,
    });
  });

  socket.on('no_asistir', async ({ codigo }) => {
    const estado = await db.noAsistir(codigo);
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
  });
});

async function broadcastActualizacion(codigo, estadoRecorrido) {
  io.to(`r:${codigo}`).emit('estado_recorrido', estadoRecorrido);
  io.to('dashboard').emit('estado_completo', await db.getEstadoTodos());
}

function hora() {
  return new Date().toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

db.initDB().then(() => {
  httpServer.listen(PORT, '0.0.0.0', () => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    let localIP = 'localhost';
    for (const iface of Object.values(nets).flat()) {
      if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
    }
    console.log('\n========================================');
    console.log('  SISTEMA DE RECORRIDOS - Iniciado');
    console.log('========================================');
    console.log(`\n  Dashboard (oficina):`);
    console.log(`  http://${localIP}:${PORT}/dashboard.html`);
    console.log(`\n  App choferes (celular):`);
    console.log(`  http://${localIP}:${PORT}/chofer.html`);
    console.log(`\n  Panel admin:`);
    console.log(`  http://${localIP}:${PORT}/admin.html`);
    console.log('\n========================================\n');
  });
}).catch(err => {
  console.error('Error conectando a la base de datos:', err.message);
  process.exit(1);
});
