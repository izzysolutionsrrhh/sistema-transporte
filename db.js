const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

const TZ = process.env.APP_TIMEZONE || 'America/Lima';

function fechaHoy() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

async function sesionHoy(recorrido_id) {
  const { rows } = await pool.query(
    'SELECT * FROM sesiones WHERE recorrido_id = $1 AND fecha = $2',
    [recorrido_id, fechaHoy()]
  );
  return rows[0] || null;
}

async function getOCrearSesion(recorrido_id) {
  const hoy = fechaHoy();
  await pool.query(
    `INSERT INTO sesiones (recorrido_id, fecha, estado)
     VALUES ($1, $2, 'pendiente')
     ON CONFLICT (recorrido_id, fecha) DO NOTHING`,
    [recorrido_id, hoy]
  );
  const { rows } = await pool.query(
    'SELECT * FROM sesiones WHERE recorrido_id = $1 AND fecha = $2',
    [recorrido_id, hoy]
  );
  return rows[0];
}

async function buildEstado(recorrido) {
  const { rows: pasajeros } = await pool.query(
    'SELECT * FROM pasajeros WHERE recorrido_id = $1 AND activo = TRUE ORDER BY orden',
    [recorrido.id]
  );
  const sesion = await sesionHoy(recorrido.id);
  let retiros = [];
  if (sesion) {
    const { rows } = await pool.query(
      `SELECT r.*, p.nombre AS pasajero_nombre
       FROM retiros r JOIN pasajeros p ON p.id = r.pasajero_id
       WHERE r.sesion_id = $1 ORDER BY r.hora NULLS LAST`,
      [sesion.id]
    );
    retiros = rows.map(r => ({ ...r, tipo: r.tipo || 'recogido' }));
  }
  return { recorrido, pasajeros, sesion: sesion || null, retiros };
}

// ─── Inicialización de tablas ─────────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recorridos (
      id     SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      codigo TEXT NOT NULL,
      activo BOOLEAN DEFAULT TRUE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recorridos_codigo
      ON recorridos(codigo) WHERE activo = TRUE;

    CREATE TABLE IF NOT EXISTS pasajeros (
      id           SERIAL PRIMARY KEY,
      nombre       TEXT NOT NULL,
      recorrido_id INTEGER REFERENCES recorridos(id),
      orden        INTEGER DEFAULT 0,
      activo       BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS sesiones (
      id           SERIAL PRIMARY KEY,
      recorrido_id INTEGER REFERENCES recorridos(id),
      fecha        TEXT NOT NULL,
      estado       TEXT DEFAULT 'pendiente',
      hora_inicio  TEXT,
      hora_llegada TEXT,
      UNIQUE(recorrido_id, fecha)
    );

    CREATE TABLE IF NOT EXISTS retiros (
      id          SERIAL PRIMARY KEY,
      sesion_id   INTEGER REFERENCES sesiones(id),
      pasajero_id INTEGER REFERENCES pasajeros(id),
      hora        TEXT,
      tipo        TEXT DEFAULT 'recogido',
      UNIQUE(sesion_id, pasajero_id)
    );

    CREATE TABLE IF NOT EXISTS reportes (
      fecha    TEXT PRIMARY KEY,
      generado TEXT NOT NULL,
      datos    JSONB NOT NULL
    );
  `);
  console.log('  Base de datos inicializada correctamente');
}

// ─── API pública ──────────────────────────────────────────────────────────────

module.exports = {
  initDB,

  async crearRecorrido(nombre, codigo) {
    try {
      const { rows } = await pool.query(
        'INSERT INTO recorridos (nombre, codigo) VALUES ($1, $2) RETURNING id',
        [nombre, codigo]
      );
      return rows[0].id;
    } catch (err) {
      if (err.code === '23505') throw new Error('Código duplicado');
      throw err;
    }
  },

  async eliminarRecorrido(id) {
    await pool.query('UPDATE recorridos SET activo = FALSE WHERE id = $1', [parseInt(id)]);
  },

  async getAllRecorridosConPasajeros() {
    const { rows: recorridos } = await pool.query(
      'SELECT * FROM recorridos WHERE activo = TRUE ORDER BY nombre'
    );
    return Promise.all(recorridos.map(async r => {
      const { rows: pasajeros } = await pool.query(
        'SELECT * FROM pasajeros WHERE recorrido_id = $1 AND activo = TRUE ORDER BY orden',
        [r.id]
      );
      return { ...r, pasajeros };
    }));
  },

  async crearPasajero(nombre, recorrido_id) {
    recorrido_id = parseInt(recorrido_id);
    const { rows } = await pool.query(
      'SELECT COALESCE(MAX(orden), 0) + 1 AS sig FROM pasajeros WHERE recorrido_id = $1',
      [recorrido_id]
    );
    const { rows: ins } = await pool.query(
      'INSERT INTO pasajeros (nombre, recorrido_id, orden) VALUES ($1, $2, $3) RETURNING id',
      [nombre, recorrido_id, rows[0].sig]
    );
    return ins[0].id;
  },

  async eliminarPasajero(id) {
    await pool.query('UPDATE pasajeros SET activo = FALSE WHERE id = $1', [parseInt(id)]);
  },

  async iniciarRecorrido(codigo, hora) {
    const { rows } = await pool.query(
      'SELECT * FROM recorridos WHERE codigo = $1 AND activo = TRUE', [codigo]
    );
    const recorrido = rows[0];
    if (!recorrido) return null;
    const sesion = await getOCrearSesion(recorrido.id);
    if (sesion.estado === 'pendiente') {
      await pool.query(
        "UPDATE sesiones SET estado = 'en_recorrido', hora_inicio = $1 WHERE id = $2",
        [hora, sesion.id]
      );
    }
    return buildEstado(recorrido);
  },

  async marcarPasajero(sesion_id, pasajero_id, hora, tipo) {
    sesion_id   = parseInt(sesion_id);
    pasajero_id = parseInt(pasajero_id);
    await pool.query(
      `INSERT INTO retiros (sesion_id, pasajero_id, hora, tipo)
       VALUES ($1, $2, $3, $4) ON CONFLICT (sesion_id, pasajero_id) DO NOTHING`,
      [sesion_id, pasajero_id, hora, tipo]
    );
    const { rows: s } = await pool.query('SELECT * FROM sesiones WHERE id = $1', [sesion_id]);
    const { rows: r } = await pool.query('SELECT * FROM recorridos WHERE id = $1', [s[0].recorrido_id]);
    return buildEstado(r[0]);
  },

  async llegarOficina(sesion_id, hora) {
    sesion_id = parseInt(sesion_id);
    await pool.query(
      "UPDATE sesiones SET estado = 'completado', hora_llegada = $1 WHERE id = $2",
      [hora, sesion_id]
    );
    const { rows: s } = await pool.query('SELECT * FROM sesiones WHERE id = $1', [sesion_id]);
    const { rows: r } = await pool.query('SELECT * FROM recorridos WHERE id = $1', [s[0].recorrido_id]);
    return buildEstado(r[0]);
  },

  async noAsistir(codigo) {
    const { rows } = await pool.query(
      'SELECT * FROM recorridos WHERE codigo = $1 AND activo = TRUE', [codigo]
    );
    const recorrido = rows[0];
    if (!recorrido) return null;
    const sesion = await getOCrearSesion(recorrido.id);
    await pool.query("UPDATE sesiones SET estado = 'no_asistio' WHERE id = $1", [sesion.id]);
    return buildEstado(recorrido);
  },

  async resetSesionHoy(recorrido_id) {
    recorrido_id = parseInt(recorrido_id);
    const sesion = await sesionHoy(recorrido_id);
    if (!sesion) return;
    await pool.query('DELETE FROM retiros  WHERE sesion_id = $1', [sesion.id]);
    await pool.query('DELETE FROM sesiones WHERE id = $1',        [sesion.id]);
  },

  async getEstadoRecorrido(codigo) {
    const { rows } = await pool.query(
      'SELECT * FROM recorridos WHERE codigo = $1 AND activo = TRUE', [codigo]
    );
    if (!rows[0]) return null;
    return buildEstado(rows[0]);
  },

  async getEstadoTodos() {
    const { rows } = await pool.query(
      'SELECT * FROM recorridos WHERE activo = TRUE ORDER BY nombre'
    );
    return Promise.all(rows.map(buildEstado));
  },

  async marcarAviso(recorrido_id, pasajero_id, hora) {
    recorrido_id = parseInt(recorrido_id);
    pasajero_id  = parseInt(pasajero_id);
    const sesion = await getOCrearSesion(recorrido_id);
    await pool.query(
      `INSERT INTO retiros (sesion_id, pasajero_id, hora, tipo)
       VALUES ($1, $2, $3, 'aviso') ON CONFLICT (sesion_id, pasajero_id) DO NOTHING`,
      [sesion.id, pasajero_id, hora]
    );
    const { rows } = await pool.query('SELECT * FROM recorridos WHERE id = $1', [recorrido_id]);
    return buildEstado(rows[0]);
  },

  async desmarcarAviso(recorrido_id, pasajero_id) {
    recorrido_id = parseInt(recorrido_id);
    pasajero_id  = parseInt(pasajero_id);
    const sesion = await sesionHoy(recorrido_id);
    if (!sesion) return null;
    await pool.query(
      "DELETE FROM retiros WHERE sesion_id = $1 AND pasajero_id = $2 AND tipo = 'aviso'",
      [sesion.id, pasajero_id]
    );
    const { rows } = await pool.query('SELECT * FROM recorridos WHERE id = $1', [recorrido_id]);
    return buildEstado(rows[0]);
  },

  async getHistorialChofer(codigo) {
    const { rows: rec } = await pool.query(
      'SELECT * FROM recorridos WHERE codigo = $1 AND activo = TRUE', [codigo]
    );
    if (!rec[0]) return null;
    const recorrido = rec[0];
    const { rows: pasajeros } = await pool.query(
      'SELECT * FROM pasajeros WHERE recorrido_id = $1 AND activo = TRUE ORDER BY orden',
      [recorrido.id]
    );
    const { rows: sesiones } = await pool.query(
      'SELECT * FROM sesiones WHERE recorrido_id = $1 ORDER BY fecha DESC',
      [recorrido.id]
    );
    const sesionesDetalle = await Promise.all(sesiones.map(async sesion => {
      const { rows: retiros } = await pool.query(
        'SELECT * FROM retiros WHERE sesion_id = $1', [sesion.id]
      );
      const ret = retiros.map(r => ({ ...r, tipo: r.tipo || 'recogido' }));
      return {
        ...sesion,
        total:      pasajeros.length,
        recogidos:  ret.filter(r => r.tipo === 'recogido').length,
        no_estaban: ret.filter(r => r.tipo === 'no_estaba').length,
        detalle: pasajeros.map(p => {
          const r = ret.find(x => x.pasajero_id === p.id);
          return { nombre: p.nombre, tipo: r?.tipo || 'pendiente', hora: r?.hora || null };
        }),
      };
    }));
    return { recorrido, sesiones: sesionesDetalle };
  },

  async generarReporte(fecha) {
    fecha = fecha || fechaHoy();
    const { rows: recorridos } = await pool.query(
      'SELECT * FROM recorridos WHERE activo = TRUE ORDER BY nombre'
    );
    const recorridosData = await Promise.all(recorridos.map(async rec => {
      const { rows: pasajeros } = await pool.query(
        'SELECT * FROM pasajeros WHERE recorrido_id = $1 AND activo = TRUE ORDER BY orden',
        [rec.id]
      );
      const { rows: ses } = await pool.query(
        'SELECT * FROM sesiones WHERE recorrido_id = $1 AND fecha = $2', [rec.id, fecha]
      );
      const sesion = ses[0] || null;
      let retiros = [];
      if (sesion) {
        const { rows } = await pool.query('SELECT * FROM retiros WHERE sesion_id = $1', [sesion.id]);
        retiros = rows.map(r => ({ ...r, tipo: r.tipo || 'recogido' }));
      }
      return {
        nombre:          rec.nombre,
        placa:           rec.codigo,
        estado:          sesion?.estado || 'pendiente',
        hora_inicio:     sesion?.hora_inicio  || null,
        hora_llegada:    sesion?.hora_llegada || null,
        total_pasajeros: pasajeros.length,
        recogidos:       retiros.filter(r => r.tipo === 'recogido').length,
        no_estaban:      retiros.filter(r => r.tipo === 'no_estaba').length,
        avisaron:        retiros.filter(r => r.tipo === 'aviso').length,
        detalle: pasajeros.map(p => {
          const r = retiros.find(x => x.pasajero_id === p.id);
          return { nombre: p.nombre, tipo: r?.tipo || 'pendiente', hora: r?.hora || null };
        }),
      };
    }));
    return {
      fecha,
      generado: new Date().toLocaleTimeString('es-PE', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ,
      }),
      recorridos: recorridosData,
    };
  },

  async guardarReporte(fecha) {
    const reporte = await this.generarReporte(fecha);
    await pool.query(
      `INSERT INTO reportes (fecha, generado, datos) VALUES ($1, $2, $3)
       ON CONFLICT (fecha) DO UPDATE SET generado = EXCLUDED.generado, datos = EXCLUDED.datos`,
      [reporte.fecha, reporte.generado, JSON.stringify(reporte)]
    );
    return reporte;
  },

  async listarReportes() {
    const { rows } = await pool.query('SELECT fecha FROM reportes ORDER BY fecha DESC');
    return rows.map(r => r.fecha);
  },

  async getReporte(fecha) {
    const { rows } = await pool.query('SELECT datos FROM reportes WHERE fecha = $1', [fecha]);
    return rows[0]?.datos || null;
  },

  async importarRecorridos(filas) {
    let recorridosCreados = 0, pasajerosCreados = 0;
    const errores = [];

    for (const fila of filas) {
      const nombre = fila['recorrido']?.toString().trim();
      const codigo = fila['placa']?.toString().trim().toUpperCase();
      if (!nombre || !codigo) continue;

      const pasajeros = Object.entries(fila)
        .filter(([k, v]) => /^pasajero\d+$/i.test(k) && v?.toString().trim())
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([, v]) => v.toString().trim())
        .filter(Boolean);

      let recorrido_id;
      try {
        const { rows } = await pool.query(
          `INSERT INTO recorridos (nombre, codigo) VALUES ($1, $2)
           ON CONFLICT (codigo) WHERE activo = TRUE DO NOTHING
           RETURNING id`,
          [nombre, codigo]
        );
        if (rows[0]) {
          recorrido_id = rows[0].id;
          recorridosCreados++;
        } else {
          const { rows: ex } = await pool.query(
            'SELECT id FROM recorridos WHERE codigo = $1 AND activo = TRUE', [codigo]
          );
          recorrido_id = ex[0]?.id;
          if (recorrido_id) errores.push(`Placa ${codigo} ya existía — pasajeros agregados igual`);
        }
      } catch (err) {
        errores.push(`Placa ${codigo}: ${err.message}`);
        continue;
      }

      if (!recorrido_id) continue;

      for (const nombrePax of pasajeros) {
        const { rows } = await pool.query(
          'SELECT COALESCE(MAX(orden), 0) + 1 AS sig FROM pasajeros WHERE recorrido_id = $1',
          [recorrido_id]
        );
        await pool.query(
          'INSERT INTO pasajeros (nombre, recorrido_id, orden) VALUES ($1, $2, $3)',
          [nombrePax, recorrido_id, rows[0].sig]
        );
        pasajerosCreados++;
      }
    }

    return { recorridosCreados, pasajerosCreados, errores };
  },
};
