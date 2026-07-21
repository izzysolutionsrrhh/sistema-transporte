// Hasheo de contraseñas (scrypt + salt) para usuarios_admin y usuarios_gestion.
// Extraído de server.js para poder testearlo sin levantar el servidor.
const crypto = require('crypto');

function hashClave(clave) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(clave, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificarClave(clave, guardado) {
  const [salt, hash] = guardado.split(':');
  const calc = crypto.scryptSync(clave, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), calc);
}

module.exports = { hashClave, verificarClave };
