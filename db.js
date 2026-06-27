const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const EMPTY = {
  recorridos: [], pasajeros: [], sesiones: [], retiros: [],
  _seq: { recorridos: 0, pasajeros: 0, sesiones: 0, retiros: 0 }
};

function read() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return JSON.parse(JSON.stringify(EMPTY)); }
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data));
}

function insert(table, fields) {
  const db = read();
  db._seq[table] = (db._seq[table] || 0) + 1;
  const record = { id: db._seq[table], ...fields };
  db[table].push(record);
  write(db);
  return record;
}

function updateWhere(table, predFn, changes) {
  const db = read();
  db[table].forEach(r => { if (predFn(r)) Object.assign(r, changes); });
  write(db);
}

function removeWhere(table, predFn) {
  const db = read();
  db[table] = db[table].filter(r => !predFn(r));
  write(db);
}

function q(table, predFn) { return read()[table].filter(predFn); }
function q1(table, predFn) { return read()[table].find(predFn) || null; }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fechaHoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function sesionHoy(recorrido_id) {
  return q1('sesiones', s => s.recorrido_id === recorrido_id && s.fecha === fechaHoy());
}

function getOCrearSesion(recorrido_id) {
  let sesion = sesionHoy(recorrido_id);
  if (!sesion) sesion = insert('sesiones', { recorrido_id, fecha: fechaHoy(), estado: 'pendiente', hora_inicio: null, hora_llegada: null });
  return sesion;
}

function buildEstado(recorrido) {
  const pasajeros = q('pasajeros', p => p.recorrido_id === recorrido.id && p.activo);
  const sesion    = sesionHoy(recorrido.id);
  const retiros   = sesion
    ? q('retiros', r => r.sesion_id === sesion.id)
        .map(r => ({ ...r, pasajero_nombre: q1('pasajeros', p => p.id === r.pasajero_id)?.nombre || '' }))
        .sort((a, b) => a.hora.localeCompare(b.hora))
    : [];
  return { recorrido, pasajeros, sesion: sesion || null, retiros };
}

// ─── API pública ──────────────────────────────────────────────────────────────

module.exports = {

  crearRecorrido(nombre, codigo) {
    if (q1('recorridos', r => r.codigo === codigo && r.activo)) throw new Error('Código duplicado');
    return insert('recorridos', { nombre, codigo, activo: true }).id;
  },

  eliminarRecorrido(id) {
    id = parseInt(id);
    updateWhere('recorridos', r => r.id === id, { activo: false });
  },

  getAllRecorridosConPasajeros() {
    return q('recorridos', r => r.activo)
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map(r => ({ ...r, pasajeros: q('pasajeros', p => p.recorrido_id === r.id && p.activo) }));
  },

  crearPasajero(nombre, recorrido_id) {
    recorrido_id = parseInt(recorrido_id);
    const maxOrden = q('pasajeros', p => p.recorrido_id === recorrido_id)
      .reduce((m, p) => Math.max(m, p.orden || 0), 0);
    return insert('pasajeros', { nombre, recorrido_id, orden: maxOrden + 1, activo: true }).id;
  },

  eliminarPasajero(id) {
    id = parseInt(id);
    updateWhere('pasajeros', p => p.id === id, { activo: false });
  },

  iniciarRecorrido(codigo, hora) {
    const recorrido = q1('recorridos', r => r.codigo === codigo && r.activo);
    if (!recorrido) return null;
    const sesion = getOCrearSesion(recorrido.id);
    if (sesion.estado === 'pendiente') {
      updateWhere('sesiones', s => s.id === sesion.id, { estado: 'en_recorrido', hora_inicio: hora });
    }
    return buildEstado(recorrido);
  },

  retirarPasajero(sesion_id, pasajero_id, hora) {
    sesion_id   = parseInt(sesion_id);
    pasajero_id = parseInt(pasajero_id);
    const ya = q1('retiros', r => r.sesion_id === sesion_id && r.pasajero_id === pasajero_id);
    if (!ya) insert('retiros', { sesion_id, pasajero_id, hora });
    const sesion = q1('sesiones', s => s.id === sesion_id);
    const recorrido = q1('recorridos', r => r.id === sesion.recorrido_id);
    return buildEstado(recorrido);
  },

  llegarOficina(sesion_id, hora) {
    sesion_id = parseInt(sesion_id);
    updateWhere('sesiones', s => s.id === sesion_id, { estado: 'completado', hora_llegada: hora });
    const sesion = q1('sesiones', s => s.id === sesion_id);
    const recorrido = q1('recorridos', r => r.id === sesion.recorrido_id);
    return buildEstado(recorrido);
  },

  noAsistir(codigo) {
    const recorrido = q1('recorridos', r => r.codigo === codigo && r.activo);
    if (!recorrido) return null;
    const sesion = getOCrearSesion(recorrido.id);
    updateWhere('sesiones', s => s.id === sesion.id, { estado: 'no_asistio' });
    return buildEstado(recorrido);
  },

  resetSesionHoy(recorrido_id) {
    recorrido_id = parseInt(recorrido_id);
    const sesion = sesionHoy(recorrido_id);
    if (!sesion) return;
    removeWhere('retiros', r => r.sesion_id === sesion.id);
    removeWhere('sesiones', s => s.id === sesion.id);
  },

  getEstadoRecorrido(codigo) {
    const recorrido = q1('recorridos', r => r.codigo === codigo && r.activo);
    if (!recorrido) return null;
    return buildEstado(recorrido);
  },

  getEstadoTodos() {
    return q('recorridos', r => r.activo)
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map(buildEstado);
  },
};
