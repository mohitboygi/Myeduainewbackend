// Cloudflare Worker entry: runs the Express app (server.js) on Workers.
// MCQ routes (/api/mcq...) are answered first by worker-mcq-routes.js, everything else goes to Express.
import './bootstrap.js'; // must stay first: copies Worker variables into process.env
import { httpServerHandler } from 'cloudflare:node';
import server from './server.js';
import { handleMcq } from './worker-mcq-routes.js';

// Database tables are already created (run `node migrate.js` once from a computer if the database is new),
// so startup() is not called here.
server.app.listen(8080);

const expressHandler = httpServerHandler({ port: 8080 });

export default {
  async fetch(request, env, ctx) {
    const mcq = await handleMcq(request, env);
    if (mcq) return mcq;
    return expressHandler.fetch(request, env, ctx);
  },
};
