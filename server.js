require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ExcelJS = require('exceljs');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const db = require('./db');
const { parsearRecorridosExcel } = require('./importar');
const { hashClave, verificarClave } = require('./auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

app.set('trust proxy', 1);
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

const tokens = new Map(); // token -> { empresa_id, usuario }

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  const info = token && tokens.get(token);
  if (!info) return res.status(401).json({ error: 'No autorizado' });
  req.empresa_id = info.empresa_id;
  next();
}

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { usuario, clave } = req.body;
  if (!usuario || !clave) return res.status(400).json({ error: 'Usuario y clave son requeridos' });
  const u = await db.getUsuarioAdmin(usuario.trim());
  if (!u || !verificarClave(clave, u.clave_hash))
    return res.status(401).json({ error: 'Usuario o clave incorrectos' });
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { empresa_id: u.empresa_id, usuario: u.usuario });
  res.json({ token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  tokens.delete(req.headers['x-admin-token']);
  res.json({ ok: true });
});

// ─── AUTH GESTIÓN (usuarios creados desde el panel admin) ────────────────────

const gestionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const gestionTokens = new Map(); // token -> { empresa_id, usuario }

function requireGestion(req, res, next) {
  const token = req.headers['x-gestion-token'];
  const info = token && gestionTokens.get(token);
  if (!info) return res.status(401).json({ error: 'No autorizado' });
  req.empresa_id = info.empresa_id;
  next();
}

app.post('/api/gestion/login', gestionLimiter, async (req, res) => {
  const { usuario, clave } = req.body;
  if (!usuario || !clave) return res.status(400).json({ error: 'Usuario y clave son requeridos' });
  const u = await db.getUsuarioGestion(usuario.trim());
  if (!u || !verificarClave(clave, u.clave_hash))
    return res.status(401).json({ error: 'Usuario o clave incorrectos' });
  const token = crypto.randomBytes(32).toString('hex');
  gestionTokens.set(token, { empresa_id: u.empresa_id, usuario: u.usuario });
  res.json({ token, usuario: u.usuario });
});

app.post('/api/gestion/logout', requireGestion, (req, res) => {
  gestionTokens.delete(req.headers['x-gestion-token']);
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
  const empresa_id = req.query.empresa
    ? await db.getEmpresaIdPorSlug(req.query.empresa)
    : await db.getEmpresaIdPorDefecto();
  if (!empresa_id) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json(await db.getEstadoTodos(empresa_id));
});

app.get('/api/chofer/:codigo/historial', async (req, res) => {
  const data = await db.getHistorialChofer(req.params.codigo.toUpperCase());
  if (!data) return res.status(404).json({ error: 'Recorrido no encontrado' });
  res.json(data);
});

app.get('/api/admin/recorridos', requireAdmin, async (req, res) => {
  res.json(await db.getAllRecorridosConPasajeros(req.empresa_id));
});

app.post('/api/admin/recorrido', requireAdmin, async (req, res) => {
  const { nombre, codigo } = req.body;
  if (!nombre?.trim() || !codigo?.trim())
    return res.status(400).json({ error: 'Nombre y código son requeridos' });
  try {
    const id = await db.crearRecorrido(nombre.trim(), codigo.trim().toUpperCase(), req.empresa_id);
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'Esa placa ya está en uso' });
  }
});

app.put('/api/admin/recorrido/:id', requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  await db.editarRecorrido(req.params.id, nombre.trim(), req.empresa_id);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.delete('/api/admin/recorrido/:id', requireAdmin, async (req, res) => {
  await db.eliminarRecorrido(req.params.id, req.empresa_id);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.post('/api/admin/pasajero', requireAdmin, async (req, res) => {
  const { nombre, recorrido_id } = req.body;
  if (!nombre?.trim() || !recorrido_id)
    return res.status(400).json({ error: 'Nombre y recorrido son requeridos' });
  try {
    const id = await db.crearPasajero(nombre.trim(), recorrido_id, req.empresa_id);
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'Recorrido no encontrado' });
  }
});

app.put('/api/admin/pasajero/:id', requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  await db.editarPasajero(req.params.id, nombre.trim(), req.empresa_id);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.delete('/api/admin/pasajero/:id', requireAdmin, async (req, res) => {
  await db.eliminarPasajero(req.params.id, req.empresa_id);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

// ─── Usuarios de gestión (administrados desde el panel admin) ────────────────

app.get('/api/admin/usuarios', requireAdmin, async (req, res) => {
  res.json(await db.listarUsuariosGestion(req.empresa_id));
});

app.post('/api/admin/usuario', requireAdmin, async (req, res) => {
  const { usuario, clave } = req.body;
  if (!usuario?.trim() || !clave)
    return res.status(400).json({ error: 'Usuario y clave son requeridos' });
  if (clave.length < 6)
    return res.status(400).json({ error: 'La clave debe tener al menos 6 caracteres' });
  try {
    const id = await db.crearUsuarioGestion(usuario.trim(), hashClave(clave), req.empresa_id);
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'Ese usuario ya existe' });
  }
});

app.delete('/api/admin/usuario/:id', requireAdmin, async (req, res) => {
  await db.eliminarUsuarioGestion(req.params.id, req.empresa_id);
  res.json({ ok: true });
});

// ─── API de gestión (alta de choferes y pasajeros) ───────────────────────────

app.get('/api/gestion/recorridos', requireGestion, async (req, res) => {
  res.json(await db.getAllRecorridosConPasajeros(req.empresa_id));
});

app.post('/api/gestion/recorrido', requireGestion, async (req, res) => {
  const { nombre, codigo } = req.body;
  if (!nombre?.trim() || !codigo?.trim())
    return res.status(400).json({ error: 'Nombre y placa son requeridos' });
  try {
    const id = await db.crearRecorrido(nombre.trim(), codigo.trim().toUpperCase(), req.empresa_id);
    io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'Esa placa ya está en uso' });
  }
});

app.post('/api/gestion/pasajero', requireGestion, async (req, res) => {
  const { nombre, recorrido_id } = req.body;
  if (!nombre?.trim() || !recorrido_id)
    return res.status(400).json({ error: 'Nombre y recorrido son requeridos' });
  try {
    const id = await db.crearPasajero(nombre.trim(), recorrido_id, req.empresa_id);
    io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'Recorrido no encontrado' });
  }
});

app.put('/api/gestion/recorrido/:id', requireGestion, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  await db.editarRecorrido(req.params.id, nombre.trim(), req.empresa_id);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.put('/api/gestion/pasajero/:id', requireGestion, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  await db.editarPasajero(req.params.id, nombre.trim(), req.empresa_id);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.delete('/api/gestion/pasajero/:id', requireGestion, async (req, res) => {
  await db.eliminarPasajero(req.params.id, req.empresa_id);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.post('/api/admin/importar', requireAdmin, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  try {
    const { error, recorridos } = await parsearRecorridosExcel(req.file.buffer);
    if (error) return res.status(400).json({ error });
    const resultado = await db.importarRecorridos(recorridos, req.empresa_id);
    io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: 'Error leyendo el archivo: ' + err.message });
  }
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  const { recorrido_id } = req.body;
  await db.resetSesionHoy(recorrido_id, req.empresa_id);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.post('/api/admin/aviso', requireAdmin, async (req, res) => {
  const { recorrido_id, pasajero_id } = req.body;
  if (!recorrido_id || !pasajero_id) return res.status(400).json({ error: 'Faltan datos' });
  const estadoRec = await db.marcarAviso(recorrido_id, pasajero_id, hora(), req.empresa_id);
  if (!estadoRec) return res.status(404).json({ error: 'Recorrido no encontrado' });
  io.to(`empresa:${estadoRec.recorrido.empresa_id}:r:${estadoRec.recorrido.codigo}`).emit('estado_recorrido', estadoRec);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.delete('/api/admin/aviso', requireAdmin, async (req, res) => {
  const { recorrido_id, pasajero_id } = req.body;
  const estadoRec = await db.desmarcarAviso(recorrido_id, pasajero_id, req.empresa_id);
  if (estadoRec) io.to(`empresa:${estadoRec.recorrido.empresa_id}:r:${estadoRec.recorrido.codigo}`).emit('estado_recorrido', estadoRec);
  io.to(`empresa:${req.empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(req.empresa_id));
  res.json({ ok: true });
});

app.get('/api/admin/reportes', requireAdmin, async (req, res) => {
  res.json(await db.listarReportes());
});

app.post('/api/admin/reporte/generar', requireAdmin, async (req, res) => {
  const { fecha } = req.body;
  res.json(await db.guardarReporte(fecha || undefined));
});

// ─── Excel estilizado ────────────────────────────────────────────────────────

const ESTADO_LABEL = { completado: 'Completado', en_recorrido: 'En recorrido', no_asistio: 'No asistió', pendiente: 'Pendiente' };
const TIPO_LABEL   = { recogido: 'Recogido', no_estaba: 'No estaba', aviso: 'Avisó que no va', esperando: 'Esperando', pendiente: 'Pendiente' };

function fmtEspera(seg) {
  if (seg == null) return '-';
  const m = Math.floor(seg / 60), s = seg % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

const COLOR = {
  headerBg:    'FF1E293B',
  headerFont:  'FFFFFFFF',
  titleBg:     'FF1D4ED8',
  completado:  'FFD1FAE5',
  no_asistio:  'FFFEE2E2',
  en_recorrido:'FFFEF9C3',
  pendiente:   'FFF8FAFC',
  recogido:    'FFD1FAE5',
  no_estaba:   'FFFEE2E2',
  aviso:       'FFEDE9FE',
  esperando:   'FFFEF3C7',
  border:      'FFE2E8F0',
};

function excelBorder() {
  const s = { style: 'thin', color: { argb: COLOR.border } };
  return { top: s, bottom: s, left: s, right: s };
}

function styleHeader(row) {
  row.height = 28;
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.headerBg } };
    cell.font = { bold: true, color: { argb: COLOR.headerFont }, size: 11, name: 'Calibri' };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = excelBorder();
  });
}

function styleDataRow(row, bgColor) {
  row.height = 18;
  row.eachCell({ includeEmpty: true }, cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
    cell.border = excelBorder();
    cell.alignment = { vertical: 'middle' };
    if (typeof cell.value === 'number') cell.alignment.horizontal = 'right';
  });
}

async function construirExcel(titulo, filasResumen, filasDetalle, conFecha = false) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema de Recorridos';

  // ── Hoja Resumen ──────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 2 }] });

  const colsResumen = conFecha
    ? [{ header: 'Fecha', width: 13 }, { header: 'Recorrido', width: 28 }, { header: 'Placa', width: 11 }, { header: 'Estado', width: 16 }, { header: 'Hora inicio', width: 13 }, { header: 'Hora llegada', width: 14 }, { header: 'Total', width: 8 }, { header: 'Recogidos', width: 11 }, { header: 'No estaban', width: 12 }, { header: 'Avisaron', width: 11 }, { header: 'Observación', width: 40 }]
    : [{ header: 'Recorrido', width: 28 }, { header: 'Placa', width: 11 }, { header: 'Estado', width: 16 }, { header: 'Hora inicio', width: 13 }, { header: 'Hora llegada', width: 14 }, { header: 'Total', width: 8 }, { header: 'Recogidos', width: 11 }, { header: 'No estaban', width: 12 }, { header: 'Avisaron', width: 11 }, { header: 'Observación', width: 40 }];

  ws1.columns = colsResumen;

  // Título
  const numCols1 = colsResumen.length;
  ws1.spliceRows(1, 0, []);
  ws1.mergeCells(1, 1, 1, numCols1);
  const titleCell1 = ws1.getCell(1, 1);
  titleCell1.value = titulo;
  titleCell1.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.titleBg } };
  titleCell1.font  = { bold: true, size: 14, color: { argb: COLOR.headerFont }, name: 'Calibri' };
  titleCell1.alignment = { horizontal: 'center', vertical: 'middle' };
  ws1.getRow(1).height = 36;

  styleHeader(ws1.getRow(2));
  ws1.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: numCols1 } };

  filasResumen.forEach(r => {
    const values = conFecha
      ? [r.fecha, r.nombre, r.placa, ESTADO_LABEL[r.estado] || r.estado, r.hora_inicio || '-', r.hora_llegada || '-', r.total_pasajeros, r.recogidos, r.no_estaban, r.avisaron, r.observacion || '-']
      : [r.nombre, r.placa, ESTADO_LABEL[r.estado] || r.estado, r.hora_inicio || '-', r.hora_llegada || '-', r.total_pasajeros, r.recogidos, r.no_estaban, r.avisaron, r.observacion || '-'];
    const row = ws1.addRow(values);
    styleDataRow(row, COLOR[r.estado] || COLOR.pendiente);
  });

  // ── Hoja Detalle ──────────────────────────────────────────────
  const ws2 = wb.addWorksheet('Detalle pasajeros', { views: [{ state: 'frozen', ySplit: 2 }] });

  const colsDetalle = conFecha
    ? [{ header: 'Fecha', width: 13 }, { header: 'Recorrido', width: 28 }, { header: 'Placa', width: 11 }, { header: 'Pasajero', width: 28 }, { header: 'Estado', width: 18 }, { header: 'Hora recogida', width: 14 }, { header: 'Espera', width: 10 }, { header: 'Hora llegada oficina', width: 20 }]
    : [{ header: 'Recorrido', width: 28 }, { header: 'Placa', width: 11 }, { header: 'Pasajero', width: 28 }, { header: 'Estado', width: 18 }, { header: 'Hora recogida', width: 14 }, { header: 'Espera', width: 10 }, { header: 'Hora llegada oficina', width: 20 }];

  ws2.columns = colsDetalle;

  const numCols2 = colsDetalle.length;
  ws2.spliceRows(1, 0, []);
  ws2.mergeCells(1, 1, 1, numCols2);
  const titleCell2 = ws2.getCell(1, 1);
  titleCell2.value = titulo;
  titleCell2.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.titleBg } };
  titleCell2.font  = { bold: true, size: 14, color: { argb: COLOR.headerFont }, name: 'Calibri' };
  titleCell2.alignment = { horizontal: 'center', vertical: 'middle' };
  ws2.getRow(1).height = 36;

  styleHeader(ws2.getRow(2));
  ws2.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: numCols2 } };

  filasDetalle.forEach(d => {
    const values = conFecha
      ? [d.fecha, d.nombre, d.placa, d.pasajero, TIPO_LABEL[d.tipo] || d.tipo, d.hora || '-', fmtEspera(d.espera_seg), d.hora_llegada || '-']
      : [d.nombre, d.placa, d.pasajero, TIPO_LABEL[d.tipo] || d.tipo, d.hora || '-', fmtEspera(d.espera_seg), d.hora_llegada || '-'];
    const row = ws2.addRow(values);
    styleDataRow(row, COLOR[d.tipo] || COLOR.pendiente);
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

app.delete('/api/admin/reporte/:fecha', requireAdmin, async (req, res) => {
  await db.eliminarReporte(req.params.fecha);
  res.json({ ok: true });
});

app.get('/api/admin/reporte/rango/xlsx', requireAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta || desde > hasta)
    return res.status(400).json({ error: 'Fechas inválidas' });

  const filas = await db.generarReporteRango(desde, hasta);
  const filasDetalle = filas.flatMap(r =>
    r.detalle.map(p => ({ fecha: r.fecha, nombre: r.nombre, placa: r.placa, pasajero: p.nombre, tipo: p.tipo, hora: p.hora, espera_seg: p.espera_seg, hora_llegada: r.hora_llegada }))
  );

  const titulo = `Reporte de Recorridos — ${desde} al ${hasta}`;
  const buffer = await construirExcel(titulo, filas, filasDetalle, true);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="reporte-${desde}-al-${hasta}.xlsx"`);
  res.send(buffer);
});

app.get('/api/admin/reporte/:fecha/xlsx', requireAdmin, async (req, res) => {
  const reporte = await db.getReporte(req.params.fecha);
  if (!reporte) return res.status(404).json({ error: 'Reporte no encontrado' });

  const filasDetalle = reporte.recorridos.flatMap(r =>
    r.detalle.map(p => ({ nombre: r.nombre, placa: r.placa, pasajero: p.nombre, tipo: p.tipo, hora: p.hora, espera_seg: p.espera_seg, hora_llegada: r.hora_llegada }))
  );

  const titulo = `Reporte de Recorridos — ${reporte.fecha}   (generado: ${reporte.generado})`;
  const buffer = await construirExcel(titulo, reporte.recorridos, filasDetalle, false);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="reporte-${reporte.fecha}.xlsx"`);
  res.send(buffer);
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

const TIPOS_VALIDOS = new Set(['recogido', 'no_estaba', 'aviso']);

io.on('connection', (socket) => {
  socket.on('join_dashboard', async ({ empresa } = {}) => {
    const empresa_id = empresa
      ? await db.getEmpresaIdPorSlug(empresa)
      : await db.getEmpresaIdPorDefecto();
    if (!empresa_id) return;
    socket.join(`empresa:${empresa_id}:dashboard`);
    socket.emit('estado_completo', await db.getEstadoTodos(empresa_id));
  });

  socket.on('join_recorrido', async ({ codigo }) => {
    const empresa_id = await db.getEmpresaIdPorCodigo(codigo);
    if (!empresa_id) return;
    socket.join(`empresa:${empresa_id}:r:${codigo}`);
  });

  socket.on('iniciar_recorrido', async ({ codigo }) => {
    try {
      const estado = await db.iniciarRecorrido(codigo, hora());
      if (!estado) return;
      broadcastActualizacion(codigo, estado);
    } catch (err) {
      console.error('iniciar_recorrido:', err.message);
    }
  });

  socket.on('marcar_pasajero', async ({ sesion_id, pasajero_id, codigo, tipo }) => {
    if (!TIPOS_VALIDOS.has(tipo)) return;
    try {
      const estado = await db.marcarPasajero(sesion_id, pasajero_id, hora(), tipo);
      if (!estado) return;
      broadcastActualizacion(codigo, estado);
    } catch (err) {
      console.error('marcar_pasajero:', err.message);
    }
  });

  socket.on('iniciar_espera', async ({ sesion_id, pasajero_id, codigo }) => {
    try {
      const estado = await db.iniciarEspera(sesion_id, pasajero_id);
      if (!estado) return;
      broadcastActualizacion(codigo, estado);
    } catch (err) {
      console.error('iniciar_espera:', err.message);
    }
  });

  // El cliente avisa que su cuenta regresiva llegó a 0; el servidor valida
  // contra espera_inicio (no se puede expirar antes de tiempo)
  socket.on('expirar_espera', async () => {
    try {
      await expirarEsperasPendientes();
    } catch (err) {
      console.error('expirar_espera:', err.message);
    }
  });

  socket.on('llegar_oficina', async ({ sesion_id, codigo, observacion }) => {
    try {
      const horaLlegada = hora();
      const obs = (observacion || '').toString().trim().slice(0, 500) || null;
      const estado = await db.llegarOficina(sesion_id, horaLlegada, obs);
      if (!estado) return;
      broadcastActualizacion(codigo, estado);
      await db.guardarReporte();
      io.to(`empresa:${estado.recorrido.empresa_id}:dashboard`).emit('alerta_llegada', {
        recorrido: estado.recorrido.nombre,
        hora: horaLlegada,
        retirados: estado.retiros.filter(r => r.tipo === 'recogido').length,
        total: estado.pasajeros.length,
        observacion: obs,
      });
    } catch (err) {
      console.error('llegar_oficina:', err.message);
    }
  });

  socket.on('no_asistir', async ({ codigo }) => {
    try {
      const estado = await db.noAsistir(codigo);
      if (!estado) return;
      broadcastActualizacion(codigo, estado);
    } catch (err) {
      console.error('no_asistir:', err.message);
    }
  });
});

async function broadcastActualizacion(codigo, estadoRecorrido) {
  const empresa_id = estadoRecorrido.recorrido.empresa_id;
  io.to(`empresa:${empresa_id}:r:${codigo}`).emit('estado_recorrido', estadoRecorrido);
  io.to(`empresa:${empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(empresa_id));
}

// Esperas de más de 3 min → "no estaba". Corre cuando un cliente avisa que
// venció su cuenta regresiva y también cada 15s como respaldo (por si el
// chofer cerró la app o se quedó sin conexión).
async function expirarEsperasPendientes() {
  const codigos = await db.expirarEsperas(hora());
  if (!codigos.length) return;
  const empresasAfectadas = new Set();
  for (const codigo of codigos) {
    const estado = await db.getEstadoRecorrido(codigo);
    if (estado) {
      const empresa_id = estado.recorrido.empresa_id;
      empresasAfectadas.add(empresa_id);
      io.to(`empresa:${empresa_id}:r:${codigo}`).emit('estado_recorrido', estado);
    }
  }
  for (const empresa_id of empresasAfectadas) {
    io.to(`empresa:${empresa_id}:dashboard`).emit('estado_completo', await db.getEstadoTodos(empresa_id));
  }
}

function hora() {
  return new Date().toLocaleTimeString('es-PE', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZone: process.env.APP_TIMEZONE || 'America/Lima',
  });
}

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

db.initDB().then(async () => {
  await db.bootstrapUsuarioAdmin(ADMIN_USER, hashClave(ADMIN_PASS));

  setInterval(() => {
    expirarEsperasPendientes().catch(err => console.error('sweep esperas:', err.message));
  }, 15000);

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
    console.log(`\n  Gestión de choferes:`);
    console.log(`  http://${localIP}:${PORT}/gestion.html`);
    console.log('\n========================================\n');
  });
}).catch(err => {
  console.error('Error conectando a la base de datos:', err.message);
  process.exit(1);
});
