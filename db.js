// One place that opens database connections.
// Node (Render, your own server): a normal connection pool.
// Cloudflare Workers: a connection cannot be shared between requests, so every query opens a short connection
// (cheap, because Cloudflare Hyperdrive keeps the real connections to Supabase warm).
const { Pool, Client } = require('pg');
const isWorker = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
module.exports = (url) => {
  if (!isWorker) return new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url || '') ? false : { rejectUnauthorized: false } });
  const open = async () => { const c = new Client({ connectionString: url }); await c.connect(); return c; };
  return {
    async query(text, params) { const c = await open(); try { return await c.query(text, params); } finally { c.end().catch(() => {}); } },
    async connect() { const c = await open(); const end = c.end.bind(c); c.release = () => { end().catch(() => {}); }; return c; },
    end() { return Promise.resolve(); },
  };
};
module.exports.isWorker = isWorker;
