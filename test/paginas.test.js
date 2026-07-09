// Verifica que los <script> inline de las 3 páginas tengan sintaxis válida
const fs = require('fs');
const path = require('path');
const { check, resumen } = require('./util');

const paginas = ['chofer.html', 'dashboard.html', 'admin.html'];

for (const pagina of paginas) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', pagina), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  check(`${pagina}: tiene al menos 1 script inline`, scripts.length >= 1);
  for (let i = 0; i < scripts.length; i++) {
    let ok = true, msg = '';
    try { new Function(scripts[i][1]); } catch (e) { ok = false; msg = ' → ' + e.message; }
    check(`${pagina}: script #${i + 1} con sintaxis válida${msg}`, ok);
  }
}

resumen('paginas');
