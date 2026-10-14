import { env } from '../config/env.ts';
import { createApp } from '../api/server.ts';
import { pool } from '../db/pool.ts';

const server = createApp().listen(env.PORT, () => {
  console.log(`api listening on :${env.PORT}`);
});

// Graceful shutdown: finish in-flight requests, then drain the pool. Without
// this, `docker compose down` drops connections mid-query.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, draining`);
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
