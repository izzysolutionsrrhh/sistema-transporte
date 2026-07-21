const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

const TZ = process.env.APP_TIMEZONE || 'America/Lima';

// Tiempo máximo de espera por pasajero (segundos)
const ESPERA_SEG = parseInt(process.env.ESPERA_SEG || '180', 10);

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

// Normaliza un retiro: tipo por defecto, espera_inicio numérico y segundos
// restantes de espera (calculados con el reloj del servidor para evitar
// desfasajes con el reloj del celular del chofer)
function mapRetiro(r) {
  const espera_inicio = r.espera_inicio != null ? Number(r.espera_inicio) : null;
  const out = { ...r, tipo: r.tipo || 'recogido', espera_inicio };
  if (out.tipo === 'esperando' && espera_inicio) {
    out.espera_restante = Math.max(0, Math.round((espera_inicio + ESPERA_SEG * 1000 - Date.now()) / 1000));
  }
  return out;
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
    retiros = rows.map(mapRetiro);
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

    -- Espera de 3 min por pasajero (epoch ms de inicio + segundos esperados)
    ALTER TABLE retiros ADD COLUMN IF NOT EXISTS espera_inicio BIGINT;
    ALTER TABLE retiros ADD COLUMN IF NOT EXISTS espera_seg    INTEGER;

    -- Observación del chofer al llegar a la oficina
    ALTER TABLE sesiones ADD COLUMN IF NOT EXISTS observacion TEXT;

    -- Usuarios del panel de gestión (alta de choferes y pasajeros)
    CREATE TABLE IF NOT EXISTS usuarios_gestion (
      id         SERIAL PRIMARY KEY,
      usuario    TEXT NOT NULL,
      clave_hash TEXT NOT NULL,
      activo     BOOLEAN DEFAULT TRUE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_gestion_usuario
      ON usuarios_gestion(usuario) WHERE activo = TRUE;

    -- Multi-tenancy (SaaS): empresas dueñas de cada recorrido. Paso puramente
    -- aditivo — todavía no lo usa ninguna ruta ni query existente.
    CREATE TABLE IF NOT EXISTS empresas (
      id        SERIAL PRIMARY KEY,
      nombre    TEXT NOT NULL,
      slug      TEXT NOT NULL,
      activo    BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE recorridos ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
  `);
  console.log('  Base de datos inicializada correctamente');
}

// ─── API pública ──────────────────────────────────────────────────────────────

module.exports = {
  initDB,

  // ─── Usuarios de gestión ──────────────────────────────────────────────────

  async crearUsuarioGestion(usuario, clave_hash) {
    try {
      const { rows } = await pool.query(
        'INSERT INTO usuarios_gestion (usuario, clave_hash) VALUES ($1, $2) RETURNING id',
        [usuario, clave_hash]
      );
      return rows[0].id;
    } catch (err) {
      if (err.code === '23505') throw new Error('Usuario duplicado');
      throw err;
    }
  },

  async listarUsuariosGestion() {
    const { rows } = await pool.query(
      'SELECT id, usuario FROM usuarios_gestion WHERE activo = TRUE ORDER BY usuario'
    );
    return rows;
  },

  async eliminarUsuarioGestion(id) {
    await pool.query('UPDATE usuarios_gestion SET activo = FALSE WHERE id = $1', [parseInt(id)]);
  },

  async getUsuarioGestion(usuario) {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios_gestion WHERE usuario = $1 AND activo = TRUE', [usuario]
    );
    return rows[0] || null;
  },

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

  async editarRecorrido(id, nombre) {
    await pool.query('UPDATE recorridos SET nombre = $1 WHERE id = $2', [nombre, parseInt(id)]);
  },

  async editarPasajero(id, nombre) {
    await pool.query('UPDATE pasajeros SET nombre = $1 WHERE id = $2', [nombre, parseInt(id)]);
  },

  async getAllRecorridosConPasajeros() {
    const { rows: recorridos } = await pool.query(
      'SELECT * FROM recorridos WHERE activo = TRUE ORDER BY nombre'
    );
    if (!recorridos.length) return [];
    const { rows: pasajeros } = await pool.query(
      'SELECT * FROM pasajeros WHERE recorrido_id = ANY($1) AND activo = TRUE ORDER BY orden',
      [recorridos.map(r => r.id)]
    );
    return recorridos.map(r => ({
      ...r,
      pasajeros: pasajeros.filter(p => p.recorrido_id === r.id),
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
    // Si estaba en espera, registrar cuánto tiempo se esperó
    const { rows: prev } = await pool.query(
      'SELECT tipo, espera_inicio, espera_seg FROM retiros WHERE sesion_id = $1 AND pasajero_id = $2',
      [sesion_id, pasajero_id]
    );
    let espera_seg = prev[0]?.espera_seg ?? null;
    if (prev[0]?.tipo === 'esperando' && prev[0].espera_inicio != null) {
      espera_seg = Math.min(ESPERA_SEG, Math.round((Date.now() - Number(prev[0].espera_inicio)) / 1000));
    }
    await pool.query(
      `INSERT INTO retiros (sesion_id, pasajero_id, hora, tipo, espera_seg)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sesion_id, pasajero_id)
       DO UPDATE SET tipo = EXCLUDED.tipo, hora = EXCLUDED.hora,
                     espera_seg = EXCLUDED.espera_seg, espera_inicio = NULL`,
      [sesion_id, pasajero_id, hora, tipo, espera_seg]
    );
    const { rows: s } = await pool.query('SELECT * FROM sesiones WHERE id = $1', [sesion_id]);
    const { rows: r } = await pool.query('SELECT * FROM recorridos WHERE id = $1', [s[0].recorrido_id]);
    return buildEstado(r[0]);
  },

  // Inicia la espera de 3 min de un pasajero (solo si aún no fue marcado
  // y la sesión sigue en recorrido)
  async iniciarEspera(sesion_id, pasajero_id) {
    sesion_id   = parseInt(sesion_id);
    pasajero_id = parseInt(pasajero_id);
    const { rows: s } = await pool.query('SELECT * FROM sesiones WHERE id = $1', [sesion_id]);
    if (!s[0]) return null;
    if (s[0].estado === 'en_recorrido') {
      await pool.query(
        `INSERT INTO retiros (sesion_id, pasajero_id, tipo, espera_inicio)
         VALUES ($1, $2, 'esperando', $3)
         ON CONFLICT (sesion_id, pasajero_id) DO NOTHING`,
        [sesion_id, pasajero_id, Date.now()]
      );
    }
    const { rows: r } = await pool.query('SELECT * FROM recorridos WHERE id = $1', [s[0].recorrido_id]);
    return buildEstado(r[0]);
  },

  // Esperas vencidas (>3 min) → marcar "no estaba". Devuelve los códigos
  // de los recorridos afectados para notificarlos por socket.
  async expirarEsperas(hora) {
    const cutoff = Date.now() - ESPERA_SEG * 1000;
    const { rows } = await pool.query(
      `UPDATE retiros
       SET tipo = 'no_estaba', hora = $1, espera_seg = $2, espera_inicio = NULL
       WHERE tipo = 'esperando' AND espera_inicio <= $3
       RETURNING sesion_id`,
      [hora, ESPERA_SEG, cutoff]
    );
    if (!rows.length) return [];
    const { rows: recs } = await pool.query(
      `SELECT DISTINCT r.codigo
       FROM sesiones s JOIN recorridos r ON r.id = s.recorrido_id
       WHERE s.id = ANY($1)`,
      [[...new Set(rows.map(x => x.sesion_id))]]
    );
    return recs.map(x => x.codigo);
  },

  async llegarOficina(sesion_id, hora, observacion = null) {
    sesion_id = parseInt(sesion_id);
    // Si quedó alguna espera activa, cerrarla como "no estaba"
    await pool.query(
      `UPDATE retiros
       SET tipo = 'no_estaba', hora = $1,
           espera_seg = LEAST($2, (($3::bigint - espera_inicio) / 1000)::int),
           espera_inicio = NULL
       WHERE sesion_id = $4 AND tipo = 'esperando'`,
      [hora, ESPERA_SEG, Date.now(), sesion_id]
    );
    await pool.query(
      "UPDATE sesiones SET estado = 'completado', hora_llegada = $1, observacion = $2 WHERE id = $3",
      [hora, observacion, sesion_id]
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

  // Optimizado: 4 queries fijas en vez de 3 por recorrido
  async getEstadoTodos() {
    const hoy = fechaHoy();
    const { rows: recorridos } = await pool.query(
      'SELECT * FROM recorridos WHERE activo = TRUE ORDER BY nombre'
    );
    if (!recorridos.length) return [];

    const ids = recorridos.map(r => r.id);

    const [{ rows: pasajeros }, { rows: sesiones }] = await Promise.all([
      pool.query('SELECT * FROM pasajeros WHERE recorrido_id = ANY($1) AND activo = TRUE ORDER BY orden', [ids]),
      pool.query('SELECT * FROM sesiones WHERE recorrido_id = ANY($1) AND fecha = $2', [ids, hoy]),
    ]);

    let retiros = [];
    const sesionIds = sesiones.map(s => s.id);
    if (sesionIds.length) {
      const { rows } = await pool.query(
        `SELECT r.*, p.nombre AS pasajero_nombre
         FROM retiros r JOIN pasajeros p ON p.id = r.pasajero_id
         WHERE r.sesion_id = ANY($1) ORDER BY r.hora NULLS LAST`,
        [sesionIds]
      );
      retiros = rows.map(mapRetiro);
    }

    return recorridos.map(rec => {
      const pasx   = pasajeros.filter(p => p.recorrido_id === rec.id);
      const sesion = sesiones.find(s => s.recorrido_id === rec.id) || null;
      const ret    = sesion ? retiros.filter(r => r.sesion_id === sesion.id) : [];
      return { recorrido: rec, pasajeros: pasx, sesion, retiros: ret };
    });
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

  // Optimizado: 1 query para todos los retiros en vez de 1 por sesión
  async getHistorialChofer(codigo) {
    const { rows: rec } = await pool.query(
      'SELECT * FROM recorridos WHERE codigo = $1 AND activo = TRUE', [codigo]
    );
    if (!rec[0]) return null;
    const recorrido = rec[0];

    const [{ rows: pasajeros }, { rows: sesiones }] = await Promise.all([
      pool.query('SELECT * FROM pasajeros WHERE recorrido_id = $1 AND activo = TRUE ORDER BY orden', [recorrido.id]),
      pool.query('SELECT * FROM sesiones WHERE recorrido_id = $1 ORDER BY fecha DESC', [recorrido.id]),
    ]);

    if (!sesiones.length) return { recorrido, sesiones: [] };

    const { rows: todosRetiros } = await pool.query(
      'SELECT * FROM retiros WHERE sesion_id = ANY($1)',
      [sesiones.map(s => s.id)]
    );

    const sesionesDetalle = sesiones.map(sesion => {
      const ret = todosRetiros
        .filter(r => r.sesion_id === sesion.id)
        .map(mapRetiro);
      return {
        ...sesion,
        total:      pasajeros.length,
        recogidos:  ret.filter(r => r.tipo === 'recogido').length,
        no_estaban: ret.filter(r => r.tipo === 'no_estaba').length,
        detalle: pasajeros.map(p => {
          const r = ret.find(x => x.pasajero_id === p.id);
          return { nombre: p.nombre, tipo: r?.tipo || 'pendiente', hora: r?.hora || null, espera_seg: r?.espera_seg ?? null };
        }),
      };
    });
    return { recorrido, sesiones: sesionesDetalle };
  },

  // Optimizado: 4 queries fijas en vez de 4 por recorrido
  async generarReporte(fecha) {
    fecha = fecha || fechaHoy();
    const { rows: recorridos } = await pool.query(
      'SELECT * FROM recorridos WHERE activo = TRUE ORDER BY nombre'
    );

    const generado = new Date().toLocaleTimeString('es-PE', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ,
    });

    if (!recorridos.length) return { fecha, generado, recorridos: [] };

    const ids = recorridos.map(r => r.id);

    const [{ rows: pasajeros }, { rows: sesiones }] = await Promise.all([
      pool.query('SELECT * FROM pasajeros WHERE recorrido_id = ANY($1) AND activo = TRUE ORDER BY orden', [ids]),
      pool.query('SELECT * FROM sesiones WHERE recorrido_id = ANY($1) AND fecha = $2', [ids, fecha]),
    ]);

    let retiros = [];
    const sesionIds = sesiones.map(s => s.id);
    if (sesionIds.length) {
      const { rows } = await pool.query(
        'SELECT * FROM retiros WHERE sesion_id = ANY($1)',
        [sesionIds]
      );
      retiros = rows.map(mapRetiro);
    }

    const recorridosData = recorridos.map(rec => {
      const pasx   = pasajeros.filter(p => p.recorrido_id === rec.id);
      const sesion = sesiones.find(s => s.recorrido_id === rec.id) || null;
      const ret    = sesion ? retiros.filter(r => r.sesion_id === sesion.id) : [];
      return {
        nombre:          rec.nombre,
        placa:           rec.codigo,
        estado:          sesion?.estado || 'pendiente',
        hora_inicio:     sesion?.hora_inicio  || null,
        hora_llegada:    sesion?.hora_llegada || null,
        observacion:     sesion?.observacion  || null,
        total_pasajeros: pasx.length,
        recogidos:       ret.filter(r => r.tipo === 'recogido').length,
        no_estaban:      ret.filter(r => r.tipo === 'no_estaba').length,
        avisaron:        ret.filter(r => r.tipo === 'aviso').length,
        detalle: pasx.map(p => {
          const r = ret.find(x => x.pasajero_id === p.id);
          return { nombre: p.nombre, tipo: r?.tipo || 'pendiente', hora: r?.hora || null, espera_seg: r?.espera_seg ?? null };
        }),
      };
    });

    return { fecha, generado, recorridos: recorridosData };
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

  async eliminarReporte(fecha) {
    await pool.query('DELETE FROM reportes WHERE fecha = $1', [fecha]);
  },

  async generarReporteRango(fechaInicio, fechaFin) {
    const { rows: recorridos } = await pool.query(
      'SELECT * FROM recorridos WHERE activo = TRUE ORDER BY nombre'
    );
    if (!recorridos.length) return [];

    const ids = recorridos.map(r => r.id);

    const [{ rows: pasajeros }, { rows: sesiones }] = await Promise.all([
      pool.query('SELECT * FROM pasajeros WHERE recorrido_id = ANY($1) AND activo = TRUE ORDER BY orden', [ids]),
      pool.query('SELECT * FROM sesiones WHERE recorrido_id = ANY($1) AND fecha >= $2 AND fecha <= $3 ORDER BY fecha', [ids, fechaInicio, fechaFin]),
    ]);

    let retiros = [];
    if (sesiones.length) {
      const { rows } = await pool.query(
        'SELECT * FROM retiros WHERE sesion_id = ANY($1)',
        [sesiones.map(s => s.id)]
      );
      retiros = rows.map(mapRetiro);
    }

    // Generar todas las fechas del rango
    const fechas = [];
    const [y1, m1, d1] = fechaInicio.split('-').map(Number);
    const [y2, m2, d2] = fechaFin.split('-').map(Number);
    const cur = new Date(Date.UTC(y1, m1 - 1, d1));
    const end = new Date(Date.UTC(y2, m2 - 1, d2));
    while (cur <= end) {
      fechas.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    return recorridos.flatMap(rec =>
      fechas.map(fecha => {
        const pasx   = pasajeros.filter(p => p.recorrido_id === rec.id);
        const sesion = sesiones.find(s => s.recorrido_id === rec.id && s.fecha === fecha) || null;
        const ret    = sesion ? retiros.filter(r => r.sesion_id === sesion.id) : [];
        return {
          fecha,
          nombre:          rec.nombre,
          placa:           rec.codigo,
          estado:          sesion?.estado || 'pendiente',
          hora_inicio:     sesion?.hora_inicio  || null,
          hora_llegada:    sesion?.hora_llegada || null,
          total_pasajeros: pasx.length,
          recogidos:       ret.filter(r => r.tipo === 'recogido').length,
          no_estaban:      ret.filter(r => r.tipo === 'no_estaba').length,
          avisaron:        ret.filter(r => r.tipo === 'aviso').length,
          detalle: pasx.map(p => {
            const r = ret.find(x => x.pasajero_id === p.id);
            return { nombre: p.nombre, tipo: r?.tipo || 'pendiente', hora: r?.hora || null, espera_seg: r?.espera_seg ?? null };
          }),
        };
      })
    );
  },

  async importarRecorridos(recorridos) {
    let recorridosCreados = 0, pasajerosCreados = 0;
    const errores = [];

    for (const { nombre, placa, pasajeros } of recorridos) {
      const codigo = placa?.toString().trim().toUpperCase();
      if (!nombre?.trim() || !codigo) continue;

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
