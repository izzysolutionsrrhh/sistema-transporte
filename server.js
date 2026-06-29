const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const XLSX = require('xlsx');
const db = require('./db');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── REST API ────────────────────────────────────────────────────────────────

app.get('/api/recorrido/:codigo', (req, res) => {
  const data = db.getEstadoRecorrido(req.params.codigo.toUpperCase());
  if (!data) return res.status(404).json({ error: 'Código de recorrido no encontrado' });
  res.json(data);
});

app.get('/api/dashboard', (req, res) => {
  res.json(db.getEstadoTodos());
});

app.get('/api/chofer/:codigo/historial', (req, res) => {
  const data = db.getHistorialChofer(req.params.codigo.toUpperCase());
  if (!data) return res.status(404).json({ error: 'Recorrido no encontrado' });
  res.json(data);
});

app.get('/api/admin/recorridos', (req, res) => {
  res.json(db.getAllRecorridosConPasajeros());
});

app.post('/api/admin/recorrido', (req, res) => {
  const { nombre, codigo } = req.body;
  if (!nombre?.trim() || !codigo?.trim())
    return res.status(400).json({ error: 'Nombre y código son requeridos' });
  try {
    const id = db.crearRecorrido(nombre.trim(), codigo.trim().toUpperCase());
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'Ese código ya está en uso' });
  }
});

app.delete('/api/admin/recorrido/:id', (req, res) => {
  db.eliminarRecorrido(req.params.id);
  io.emit('estado_completo', db.getEstadoTodos());
  res.json({ ok: true });
});

app.post('/api/admin/pasajero', (req, res) => {
  const { nombre, recorrido_id } = req.body;
  if (!nombre?.trim() || !recorrido_id)
    return res.status(400).json({ error: 'Nombre y recorrido son requeridos' });
  const id = db.crearPasajero(nombre.trim(), recorrido_id);
  res.json({ id });
});

app.delete('/api/admin/pasajero/:id', (req, res) => {
  db.eliminarPasajero(req.params.id);
  io.emit('estado_completo', db.getEstadoTodos());
  res.json({ ok: true });
});

app.post('/api/admin/reset', (req, res) => {
  const { recorrido_id } = req.body;
  db.resetSesionHoy(recorrido_id);
  io.emit('estado_completo', db.getEstadoTodos());
  res.json({ ok: true });
});

app.post('/api/admin/aviso', (req, res) => {
  const { recorrido_id, pasajero_id } = req.body;
  if (!recorrido_id || !pasajero_id) return res.status(400).json({ error: 'Faltan datos' });
  db.marcarAviso(recorrido_id, pasajero_id, hora());
  io.emit('estado_completo', db.getEstadoTodos());
  res.json({ ok: true });
});

app.delete('/api/admin/aviso', (req, res) => {
  const { recorrido_id, pasajero_id } = req.body;
  db.desmarcarAviso(recorrido_id, pasajero_id);
  io.emit('estado_completo', db.getEstadoTodos());
  res.json({ ok: true });
});

app.get('/api/admin/reportes', (req, res) => {
  res.json(db.listarReportes());
});

app.post('/api/admin/reporte/generar', (req, res) => {
  const { fecha } = req.body;
  res.json(db.guardarReporte(fecha || undefined));
});

app.get('/api/admin/reporte/:fecha/xlsx', (req, res) => {
  const reporte = db.getReporte(req.params.fecha);
  if (!reporte) return res.status(404).json({ error: 'Reporte no encontrado' });

  const estadoLabel = { completado: 'Completado', en_recorrido: 'En recorrido', no_asistio: 'No asistió', pendiente: 'Pendiente' };
  const tipoLabel   = { recogido: 'Recogido', no_estaba: 'No estaba', pendiente: 'Pendiente' };

  // Hoja 1: Resumen por recorrido
  const wsResumen = XLSX.utils.aoa_to_sheet([
    [`Reporte de Recorridos — ${reporte.fecha}   (generado: ${reporte.generado})`],
    [],
    ['Recorrido', 'Placa', 'Estado', 'Hora inicio', 'Hora llegada', 'Total pasajeros', 'Recogidos', 'No estaban'],
    ...reporte.recorridos.map(r => [
      r.nombre, r.placa, estadoLabel[r.estado] || r.estado,
      r.hora_inicio || '-', r.hora_llegada || '-',
      r.total_pasajeros, r.recogidos, r.no_estaban,
    ]),
  ]);
  wsResumen['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 15 }, { wch: 13 },
    { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 },
  ];
  wsResumen['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];

  // Hoja 2: Detalle por pasajero
  const wsDetalle = XLSX.utils.aoa_to_sheet([
    ['Recorrido', 'Placa', 'Pasajero', 'Estado', 'Hora'],
    ...reporte.recorridos.flatMap(r =>
      r.detalle.map(p => [
        r.nombre, r.placa, p.nombre,
        tipoLabel[p.tipo] || p.tipo, p.hora || '-',
      ])
    ),
  ]);
  wsDetalle['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 28 }, { wch: 12 }, { wch: 10 },
  ];

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
  // Dashboard: join room and receive full state
  socket.on('join_dashboard', () => {
    socket.join('dashboard');
    socket.emit('estado_completo', db.getEstadoTodos());
  });

  // Driver: join their route room
  socket.on('join_recorrido', ({ codigo }) => {
    socket.join(`r:${codigo}`);
  });

  // Driver starts route
  socket.on('iniciar_recorrido', ({ codigo }) => {
    const estado = db.iniciarRecorrido(codigo, hora());
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
  });

  // Driver marks a passenger as picked up or not home
  socket.on('marcar_pasajero', ({ sesion_id, pasajero_id, codigo, tipo }) => {
    const estado = db.marcarPasajero(sesion_id, pasajero_id, hora(), tipo);
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
  });

  // Driver arrives at the office
  socket.on('llegar_oficina', ({ sesion_id, codigo }) => {
    const horaLlegada = hora();
    const estado = db.llegarOficina(sesion_id, horaLlegada);
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
    db.guardarReporte();
    io.to('dashboard').emit('alerta_llegada', {
      recorrido: estado.recorrido.nombre,
      hora: horaLlegada,
      retirados: estado.retiros.filter(r => r.tipo === 'recogido').length,
      total: estado.pasajeros.length,
    });
  });

  // Driver marks as absent
  socket.on('no_asistir', ({ codigo }) => {
    const estado = db.noAsistir(codigo);
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
  });
});

function broadcastActualizacion(codigo, estadoRecorrido) {
  io.to(`r:${codigo}`).emit('estado_recorrido', estadoRecorrido);
  io.to('dashboard').emit('estado_completo', db.getEstadoTodos());
}

function hora() {
  return new Date().toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
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
