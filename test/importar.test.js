// Tests del parser de importación de Excel (formato plantillarecorridos)
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { parsearRecorridosExcel } = require('../importar');
const { check, resumen } = require('./util');

async function bufferDe(armar) {
  const wb = new ExcelJS.Workbook();
  armar(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

(async () => {
  // ── Caso normal: dos recorridos en grupos de columnas distintos ──
  const buf1 = await bufferDe(wb => {
    const ws = wb.addWorksheet('Hoja1');
    // Grupo 1 en columnas A-C, grupo 2 en columnas E-G
    ws.addRow(['N°', 'Ruta Norte', 'ABC-123', null, 'N°', 'Ruta Sur', 'XYZ-789']);
    ws.addRow([1, 'Juan Pérez', null, null, 1, 'María López', null]);
    ws.addRow([2, 'Ana Torres', null, null, 2, 'Luis Díaz', null]);
    ws.addRow([3, 'Pedro Ruiz', null, null, null, null, null]);
  });
  const r1 = await parsearRecorridosExcel(buf1);
  check('caso normal: sin error', !r1.error);
  check('caso normal: 2 recorridos', r1.recorridos?.length === 2);
  check('caso normal: nombre y placa correctos', r1.recorridos?.[0].nombre === 'Ruta Norte' && r1.recorridos?.[0].placa === 'ABC-123');
  check('caso normal: 3 pasajeros en Ruta Norte', r1.recorridos?.[0].pasajeros.length === 3);
  check('caso normal: 2 pasajeros en Ruta Sur', r1.recorridos?.[1].pasajeros.length === 2);
  check('caso normal: pasajero con nombre exacto', r1.recorridos?.[0].pasajeros[0] === 'Juan Pérez');

  // ── Dos sectores apilados en el mismo grupo de columnas ──
  const buf2 = await bufferDe(wb => {
    const ws = wb.addWorksheet('Hoja1');
    ws.addRow(['N°', 'Sector 1', 'AAA-111']);
    ws.addRow([1, 'Pasajero Uno']);
    ws.addRow(['N°', 'Sector 2', 'BBB-222']);
    ws.addRow([1, 'Pasajero Dos']);
    ws.addRow([2, 'Pasajero Tres']);
  });
  const r2 = await parsearRecorridosExcel(buf2);
  check('sectores apilados: 2 recorridos', r2.recorridos?.length === 2);
  check('sectores apilados: pasajeros bien repartidos', r2.recorridos?.[0].pasajeros.length === 1 && r2.recorridos?.[1].pasajeros.length === 2);

  // ── Filas sin número no agregan pasajeros ──
  const buf3 = await bufferDe(wb => {
    const ws = wb.addWorksheet('Hoja1');
    ws.addRow(['N°', 'Ruta X', 'CCC-333']);
    ws.addRow(['texto', 'No debería entrar']);
    ws.addRow([1, 'Sí entra']);
    ws.addRow([2, '']); // número sin nombre: tampoco entra
  });
  const r3 = await parsearRecorridosExcel(buf3);
  check('filas inválidas ignoradas: 1 solo pasajero', r3.recorridos?.[0].pasajeros.length === 1);

  // ── Errores de formato ──
  const bufVacio = await bufferDe(() => {}); // workbook sin hojas
  const rVacio = await parsearRecorridosExcel(bufVacio).catch(e => ({ error: e.message }));
  check('workbook sin hojas: devuelve error', !!rVacio.error);

  const bufSinFormato = await bufferDe(wb => {
    const ws = wb.addWorksheet('Hoja1');
    ws.addRow(['cualquier', 'cosa']);
  });
  const rSinFormato = await parsearRecorridosExcel(bufSinFormato);
  check('sin encabezado N°: error de formato', rSinFormato.error === 'Formato no reconocido: no se encontraron recorridos');

  const noEsExcel = await parsearRecorridosExcel(Buffer.from('esto no es un excel')).catch(e => ({ error: e.message }));
  check('archivo corrupto: lanza error controlable', !!noEsExcel.error);

  // ── Smoke test con la plantilla real, si está en la carpeta ──
  const plantilla = path.join(__dirname, '..', 'plantillarecorridos.xlsx');
  if (fs.existsSync(plantilla)) {
    const rReal = await parsearRecorridosExcel(fs.readFileSync(plantilla));
    check('plantilla real: parsea sin error', !rReal.error);
    check('plantilla real: al menos 1 recorrido con pasajeros', rReal.recorridos?.length >= 1 && rReal.recorridos.every(r => r.nombre));
    if (rReal.recorridos) {
      console.log(`     (plantilla real: ${rReal.recorridos.length} recorridos, ${rReal.recorridos.reduce((s, r) => s + r.pasajeros.length, 0)} pasajeros)`);
    }
  } else {
    console.log('     (plantillarecorridos.xlsx no está en la carpeta — smoke test omitido)');
  }

  resumen('importar');
})();
