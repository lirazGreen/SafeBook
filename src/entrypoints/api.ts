import { env } from '../config/env.ts';
import { createApp } from '../api/server.ts';
import { assertDatabaseConfigured, pool } from '../db/pool.ts';

// Explicit, and before the listener binds: an api that answers while it cannot
// reach Postgres is not serving.
assertDatabaseConfigured();

const server = createApp().listen(env.PORT, () => {
  console.log(JSON.stringify({
    at: new Date().toISOString(), stage: 'boot', service: 'api', port: env.PORT,
    docs: `http://localhost:${env.PORT}/docs`,
  }));
});

// Graceful shutdown: finish in-flight requests, then drain the pool. Without
// this, `docker compose down` drops connections mid-query.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ at: new Date().toISOString(), stage: 'shutdown', signal }));
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
