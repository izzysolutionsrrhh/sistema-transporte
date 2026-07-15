// Mini helper de asserts compartido por los tests (sin framework)
let pasados = 0, fallados = 0;

function check(nombre, cond) {
  if (cond) { pasados++; console.log('  OK   ' + nombre); }
  else { fallados++; process.exitCode = 1; console.log('  FAIL ' + nombre); }
}

function resumen(suite) {
  console.log(`  → ${suite}: ${pasados} OK, ${fallados} FAIL`);
}

module.exports = { check, resumen };
