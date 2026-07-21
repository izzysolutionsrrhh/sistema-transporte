// Tests del hasheo de contraseñas (usuarios_admin y usuarios_gestion)
const { hashClave, verificarClave } = require('../auth');
const { check, resumen } = require('./util');

const hash1 = hashClave('mi-clave-123');
check('hashClave: devuelve formato salt:hash', /^[0-9a-f]+:[0-9a-f]+$/.test(hash1));

const hash2 = hashClave('mi-clave-123');
check('hashClave: la misma clave da hashes distintos (salt aleatorio)', hash1 !== hash2);

check('verificarClave: clave correcta contra su propio hash', verificarClave('mi-clave-123', hash1));
check('verificarClave: clave correcta contra el otro hash de la misma clave', verificarClave('mi-clave-123', hash2));
check('verificarClave: clave incorrecta rechazada', !verificarClave('otra-clave', hash1));
check('verificarClave: clave vacía rechazada', !verificarClave('', hash1));

const hashAdmin = hashClave('admin_staging_pass');
const hashGestion = hashClave('gestion_pass');
check('verificarClave: no cruza hashes de distintos usuarios', !verificarClave('admin_staging_pass', hashGestion));

resumen('auth');
