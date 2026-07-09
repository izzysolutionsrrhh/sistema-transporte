// Corre todos los *.test.js de esta carpeta, cada uno en su propio proceso
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const tests = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let fallo = false;

for (const t of tests) {
  console.log(`\n■ ${t}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) fallo = true;
}

console.log(fallo ? '\n✗ Hay tests fallando' : '\n✓ Todos los tests pasan');
process.exit(fallo ? 1 : 0);
