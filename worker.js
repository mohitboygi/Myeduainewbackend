// Cloudflare Worker entry: runs the Express app (server.js) on Workers.
import './bootstrap.js'; // must stay first: copies Worker variables into process.env
import { httpServerHandler } from 'cloudflare:node';
import server from './server.js';

// Database tables are already created (run `node migrate.js` once from a computer if the database is new),
// so startup() is not called here.
server.app.listen(8080);

export default httpServerHandler({ port: 8080 });
