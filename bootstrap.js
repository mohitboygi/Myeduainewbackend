// Runs first on Cloudflare: copies the settings into process.env and points the database at Hyperdrive.
import { env } from 'cloudflare:workers';
for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
if (env.HYPERDRIVE) process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
