// Run once from your own computer (and again after every update that changes the database):  node migrate.js
// Creates / updates the tables, loads the MCQ bank, turns on row security, checks Turso. The Worker never does this itself.
require('dotenv').config();
const { startup } = require('./server');
const turso = require('./lib/turso');
startup().then(() => { console.log('Database ready. Turso:', JSON.stringify({ ...turso.getStatus(), mapping: undefined })); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
