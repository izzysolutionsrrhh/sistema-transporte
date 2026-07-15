// Test de renderizado del dashboard: carga public/dashboard.html en jsdom
// con un socket.io simulado y verifica tarjetas, stats, log, toast y toggle.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { check, resumen } = require('./util');

const STUB = `<script>
function io() {
  const handlers = {};
  const s = { on: (ev, fn) => { handlers[ev] = fn; }, emit: () => {} };
  const pasajeros = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, nombre: 'Pasajero ' + (i + 1) }));
  const DATA1 = [
    { recorrido: { id: 1, nombre: 'Ruta Norte', codigo: 'ABC-123' }, pasajeros: pasajeros(6),
      sesion: { estado: 'en_recorrido', hora_inicio: '02:05' },
      retiros: [
        { pasajero_id: 1, tipo: 'recogido', hora: '02:15' },
        { pasajero_id: 2, tipo: 'recogido', hora: '02:22', espera_seg: 95 },
        { pasajero_id: 3, tipo: 'no_estaba', espera_seg: 180 },
        { pasajero_id: 4, tipo: 'aviso' },
        { pasajero_id: 5, tipo: 'esperando' },
      ] },
    { recorrido: { id: 2, nombre: 'Ruta Sur <b>xss</b>', codigo: 'XYZ-789' }, pasajeros: pasajeros(4),
      sesion: { estado: 'completado', hora_inicio: '01:50', hora_llegada: '03:10', observacion: 'Todo ok' },
      retiros: [
        { pasajero_id: 1, tipo: 'recogido', hora: '02:00' },
        { pasajero_id: 2, tipo: 'recogido', hora: '02:08' },
        { pasajero_id: 3, tipo: 'no_estaba' },
        { pasajero_id: 4, tipo: 'recogido', hora: '02:20' },
      ] },
    { recorrido: { id: 3, nombre: 'Ruta Este', codigo: 'DEF-456' }, pasajeros: pasajeros(5),
      sesion: null, retiros: [] },
    { recorrido: { id: 4, nombre: 'Ruta Oeste', codigo: 'GHI-321' }, pasajeros: pasajeros(3),
      sesion: { estado: 'no_asistio' }, retiros: [] },
  ];
  const DATA2 = JSON.parse(JSON.stringify(DATA1));
  DATA2[2].sesion = { estado: 'en_recorrido', hora_inicio: '02:40' };
  setTimeout(() => {
    handlers['connect'] && handlers['connect']();
    handlers['estado_completo'](DATA1);
    setTimeout(() => handlers['estado_completo'](DATA2), 300);
    setTimeout(() => handlers['alerta_llegada']({ recorrido: 'Ruta Norte', hora: '03:12', retirados: 5, total: 6, observacion: 'Tráfico en la av. principal' }), 600);
  }, 50);
  return s;
}
</scr` + `ipt>`;

const html = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8')
  .replace('<script src="/socket.io/socket.io.js"></script>', STUB);
if (!html.includes('function io()')) throw new Error('No se pudo inyectar el stub de socket.io');

const errores = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.addEventListener('error', e => errores.push(e.message));
  },
});
const doc = dom.window.document;

// El stub dispara DATA1 (50ms), DATA2 (350ms) y alerta_llegada (650ms)
setTimeout(() => {
  check('sin errores JS en la página', errores.length === 0);
  if (errores.length) console.log('     errores:', errores);

  const tarjetas = doc.querySelectorAll('.tarjeta');
  check('4 tarjetas renderizadas', tarjetas.length === 4);

  // Stats tras DATA2: 1 completado, 2 en camino, 0 pendientes, 1 ausente
  check('stat llegaron = 1', doc.getElementById('stat-llegaron').textContent === '1');
  check('stat en camino = 2', doc.getElementById('stat-en-camino').textContent === '2');
  check('stat pendientes = 0', doc.getElementById('stat-pendientes').textContent === '0');
  check('stat ausentes = 1', doc.getElementById('stat-ausentes').textContent === '1');

  // Barra segmentada (Ruta Norte: 2 recogidos, 1 no estaba, 1 aviso de 6)
  const segs = tarjetas[0].querySelectorAll('.barra-seg');
  check('barra con 3 segmentos', segs.length === 3);
  check('segmento recogidos ~33%', segs[0].style.width.startsWith('33.3'));
  check('segmento no-estaban ~16%', segs[1].style.width.startsWith('16.6'));

  // Nombres con HTML se muestran como texto (escapado)
  check('nombre con <b> escapado', !doc.querySelector('.tarjeta-nombre b'));

  // Log: inicio de Ruta Este + llegada de Ruta Norte, sin duplicados
  const logs = [...doc.querySelectorAll('.log-item')];
  check('log con 2 entradas (sin duplicados)', logs.length === 2);
  check('llegada aparece 1 sola vez', logs.filter(l => l.textContent.includes('llegó a la oficina')).length === 1);

  // Toast de llegada
  const toast = doc.getElementById('toast');
  check('toast visible con la llegada', toast.classList.contains('visible') && toast.textContent.includes('Ruta Norte'));

  // Toggle Ver/Ocultar personas
  const btn = tarjetas[0].querySelector('.toggle-pasajeros');
  check('botón inicial dice "Ver personas"', btn.textContent.includes('Ver personas'));
  btn.click();
  check('lista se abre al hacer clic', tarjetas[0].querySelector('.pasajeros-lista').classList.contains('abierta'));
  check('botón pasa a "Ocultar"', btn.textContent.includes('Ocultar'));

  // Estados de pasajeros
  const filas = [...tarjetas[0].querySelectorAll('.pasajero-row')];
  check('6 filas de pasajeros', filas.length === 6);
  check('recogido muestra espera', filas[1].textContent.includes('esperó 1m 35s'));
  check('no estaba muestra espera', filas[2].textContent.includes('esperó 3m 00s'));
  check('avisó se muestra', filas[3].textContent.includes('Avisó'));
  check('esperando se muestra', filas[4].textContent.includes('Esperando'));
  check('pendiente se muestra', filas[5].textContent.includes('Pendiente'));

  resumen('dashboard');
  process.exit(process.exitCode || 0);
}, 1200);
