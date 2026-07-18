// Shared Postgres connection config for the one-shot scripts in scripts/, so the
// same local instance server.js connects to only needs to be specified once.
// Reads from the same .env file (and the same DB_* variables) as server.js's own Pool
// config, rather than keeping a second hardcoded copy of the credentials in source control.

require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

function getPool() {
    if (!process.env.DB_PASSWORD) {
        console.error('FATAL: DB_PASSWORD is not set. Copy .env.example to .env and set it to match docker-compose.yml.');
        process.exit(1);
    }
    return new Pool({
        user: process.env.DB_USER || 'tooladmin',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'tooltracker',
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT || 5432,
    });
}

module.exports = { getPool };
