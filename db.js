const fs = require('fs');
const path = require('path');

const DB_PATH      = path.join(__dirname, 'data.json');
const REPORTES_DIR = path.join(__dirname, 'reportes');

function ensureReportesDir() {
  if (!fs.existsSync(REPORTES_DIR)) fs.mkdirSync(REPORTES_DIR);
}

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
        .map(r => ({ ...r, tipo: r.tipo || 'recogido', pasajero_nombre: q1('pasajeros', p => p.id === r.pasajero_id)?.nombre || '' }))
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

  marcarAviso(recorrido_id, pasajero_id, hora) {
    recorrido_id = parseInt(recorrido_id);
    pasajero_id  = parseInt(pasajero_id);
    const sesion = getOCrearSesion(recorrido_id);
    const ya = q1('retiros', r => r.sesion_id === sesion.id && r.pasajero_id === pasajero_id);
    if (!ya) insert('retiros', { sesion_id: sesion.id, pasajero_id, hora, tipo: 'aviso' });
    const recorrido = q1('recorridos', r => r.id === recorrido_id);
    return buildEstado(recorrido);
  },

  desmarcarAviso(recorrido_id, pasajero_id) {
    recorrido_id = parseInt(recorrido_id);
    pasajero_id  = parseInt(pasajero_id);
    const sesion = sesionHoy(recorrido_id);
    if (!sesion) return null;
    removeWhere('retiros', r => r.sesion_id === sesion.id && r.pasajero_id === pasajero_id && r.tipo === 'aviso');
    const recorrido = q1('recorridos', r => r.id === recorrido_id);
    return buildEstado(recorrido);
  },

  marcarPasajero(sesion_id, pasajero_id, hora, tipo) {
    sesion_id   = parseInt(sesion_id);
    pasajero_id = parseInt(pasajero_id);
    const ya = q1('retiros', r => r.sesion_id === sesion_id && r.pasajero_id === pasajero_id);
    if (!ya) insert('retiros', { sesion_id, pasajero_id, hora, tipo });
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

  generarReporte(fecha) {
    fecha = fecha || fechaHoy();
    const recorridos = q('recorridos', r => r.activo).sort((a, b) => a.nombre.localeCompare(b.nombre));
    return {
      fecha,
      generado: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      recorridos: recorridos.map(rec => {
        const pasajeros = q('pasajeros', p => p.recorrido_id === rec.id && p.activo);
        const sesion    = q1('sesiones', s => s.recorrido_id === rec.id && s.fecha === fecha);
        const retiros   = sesion
          ? q('retiros', r => r.sesion_id === sesion.id)
              .map(r => ({ ...r, tipo: r.tipo || 'recogido' }))
          : [];
        const recogidos  = retiros.filter(r => r.tipo === 'recogido').length;
        const noEstaban  = retiros.filter(r => r.tipo === 'no_estaba').length;
        return {
          nombre:          rec.nombre,
          placa:           rec.codigo,
          estado:          sesion?.estado || 'pendiente',
          hora_inicio:     sesion?.hora_inicio  || null,
          hora_llegada:    sesion?.hora_llegada || null,
          total_pasajeros: pasajeros.length,
          recogidos,
          no_estaban:      noEstaban,
          detalle: pasajeros.map(p => {
            const r = retiros.find(x => x.pasajero_id === p.id);
            return { nombre: p.nombre, tipo: r?.tipo || 'pendiente', hora: r?.hora || null };
          }),
        };
      }),
    };
  },

  guardarReporte(fecha) {
    ensureReportesDir();
    const reporte = this.generarReporte(fecha);
    fs.writeFileSync(path.join(REPORTES_DIR, `${reporte.fecha}.json`), JSON.stringify(reporte, null, 2));
    return reporte;
  },

  listarReportes() {
    ensureReportesDir();
    return fs.readdirSync(REPORTES_DIR)
      .filter(f => f.endsWith('.json'))
      .sort().reverse()
      .map(f => f.replace('.json', ''));
  },

  getHistorialChofer(codigo) {
    const recorrido = q1('recorridos', r => r.codigo === codigo && r.activo);
    if (!recorrido) return null;
    const pasajeros = q('pasajeros', p => p.recorrido_id === recorrido.id && p.activo);
    const sesiones  = q('sesiones',  s => s.recorrido_id === recorrido.id)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    return {
      recorrido,
      sesiones: sesiones.map(sesion => {
        const retiros = q('retiros', r => r.sesion_id === sesion.id)
          .map(r => ({ ...r, tipo: r.tipo || 'recogido' }));
        return {
          ...sesion,
          total:      pasajeros.length,
          recogidos:  retiros.filter(r => r.tipo === 'recogido').length,
          no_estaban: retiros.filter(r => r.tipo === 'no_estaba').length,
          detalle: pasajeros.map(p => {
            const r = retiros.find(x => x.pasajero_id === p.id);
            return { nombre: p.nombre, tipo: r?.tipo || 'pendiente', hora: r?.hora || null };
          }),
        };
      }),
    };
  },

  getReporte(fecha) {
    const fp = path.join(REPORTES_DIR, `${fecha}.json`);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  },
};
