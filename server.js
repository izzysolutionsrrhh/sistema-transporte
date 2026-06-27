const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
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

  // Driver picks up a passenger
  socket.on('retirar_pasajero', ({ sesion_id, pasajero_id, codigo }) => {
    const estado = db.retirarPasajero(sesion_id, pasajero_id, hora());
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
  });

  // Driver arrives at the office
  socket.on('llegar_oficina', ({ sesion_id, codigo }) => {
    const horaLlegada = hora();
    const estado = db.llegarOficina(sesion_id, horaLlegada);
    if (!estado) return;
    broadcastActualizacion(codigo, estado);
    io.to('dashboard').emit('alerta_llegada', {
      recorrido: estado.recorrido.nombre,
      hora: horaLlegada,
      retirados: estado.retiros.length,
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
