// Shared Postgres connection config for the one-shot scripts in scripts/, so the
// same local instance server.js connects to only needs to be specified once.

const { Pool } = require('pg');

function getPool() {
    return new Pool({
        user: 'tooladmin',
        host: 'localhost',
        database: 'tooltracker',
        password: 'SuperSecretPassword123',
        port: 5432,
    });
}

module.exports = { getPool };
