const ExcelJS = require('exceljs');

// Parser del formato plantillarecorridos: grupos de columnas por sector.
// Cada grupo empieza donde aparece "N°" → [N° | nombre recorrido | placa],
// y debajo cada fila [número | nombre pasajero] agrega un pasajero.
// Devuelve { recorridos } o { error } con mensaje para el usuario.
async function parsearRecorridosExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { error: 'El archivo está vacío' };

  // Leer todas las filas como arrays (0-indexed)
  const filas = [];
  ws.eachRow(row => filas.push(row.values.slice(1)));

  // Detectar columnas de inicio de recorrido: donde aparece "N°"
  const gruposSet = new Set();
  filas.forEach(r => {
    r.forEach((cell, idx) => {
      if (String(cell ?? '').trim() === 'N°') gruposSet.add(idx);
    });
  });
  const grupos = [...gruposSet].sort((a, b) => a - b);
  if (!grupos.length) return { error: 'Formato no reconocido: no se encontraron recorridos' };

  // Parsear cada grupo de columnas: [N°/num, nombre, placa/barrio]
  const recorridos = [];
  for (const col of grupos) {
    let nombre = null, placa = null, pasajeros = [];
    for (const fila of filas) {
      const c0 = fila[col];
      const c1 = String(fila[col + 1] ?? '').trim();
      const c2 = String(fila[col + 2] ?? '').trim();
      if (String(c0 ?? '').trim() === 'N°') {
        if (nombre) recorridos.push({ nombre, placa, pasajeros });
        nombre = c1; placa = c2; pasajeros = [];
      } else if (typeof c0 === 'number' && c1) {
        pasajeros.push(c1);
      }
    }
    if (nombre) recorridos.push({ nombre, placa, pasajeros });
  }

  if (!recorridos.length) return { error: 'No se encontraron recorridos en el archivo' };
  return { recorridos };
}

module.exports = { parsearRecorridosExcel };
