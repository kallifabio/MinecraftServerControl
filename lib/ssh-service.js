// Verdrahtet die reine SSH-Logik (ssh-service-factory.js) mit dem echten
// ssh2-Modul.

const { Client } = require('ssh2');
const { createSshService } = require('./ssh-service-factory');

module.exports = createSshService({ Client });
