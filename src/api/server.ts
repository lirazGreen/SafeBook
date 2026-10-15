import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import swaggerUi from 'swagger-ui-express';
import { parse as parseYaml } from 'yaml';
import { env } from '../config/env.ts';
import { mountRoutes } from './routes.ts';

/**
 * Resolved from THIS MODULE, not from the working directory.
 *
 * A bare 'openapi.yaml' worked under `npm run api` and from the test runner
 * (both start at the repo root) and failed in the container, where the api
 * crashed on boot with ENOENT. Anything the process must read at startup should
 * not depend on who launched it.
 */
export const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'openapi.yaml');

/**
 * `openapi.yaml` is the CONTRACT, not documentation written afterwards.
 *
 *  - served at `/docs` (Swagger UI) and `/openapi.json` (raw)
 *  - ENFORCED at runtime by express-openapi-validator, in BOTH directions
 *  - linted in CI by spectral, and exercised by tests/integration/contract.test.ts
 *
 * Response validation is the part that earns its keep: a handler returning an
 * undeclared field, or a date in the wrong format, fails the contract test
 * rather than shipping. Every response schema is `additionalProperties: false`,
 * which is why src/api/present.ts exists — raw rows could not satisfy it, and
 * were leaking `raw_text`, `file_sha256` and BIGINT-as-string anyway.
 */
export function loadSpec(): Record<string, unknown> {
  return parseYaml(readFileSync(SPEC_PATH, 'utf8')) as Record<string, unknown>;
}

export function createApp() {
  const app = express();
  const spec = loadSpec();

  app.use(express.json({ limit: '1mb' }));

  app.get('/openapi.json', (_req, res) => void res.json(spec));
  // Useful side effect: Swagger UI renders a real file picker for the multipart
  // upload, so the four sample PDFs can be submitted from a browser and the
  // results browsed interactively. That covers much of what the deferred UI
  // would have provided, for no extra code.
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec as never));

  app.use(
    OpenApiValidator.middleware({
      apiSpec: SPEC_PATH,
      validateRequests: { allowUnknownQueryParameters: false },
      // Response validation is ON. It is what makes the spec a contract — and it
      // is the reason the shapes are built by present.ts rather than passed
      // through from the driver.
      validateResponses: { removeAdditional: false },
      // Parse multipart into memory: MAX_UPLOAD_BYTES is tens of megabytes, and
      // the bytes are hashed and archived immediately rather than held.
      fileUploader: { storage: undefined, limits: { fileSize: env.MAX_UPLOAD_BYTES } },
      // The docs routes are served above and are deliberately not in the spec.
      ignorePaths: /^\/(docs|openapi\.json)/,
    }),
  );

  mountRoutes(app);

  // Errors from the validator arrive with `status` and `errors`; everything else
  // is ours. Both render as `{ error, code }` so an HTTP failure and a job
  // failure speak ONE vocabulary.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; message?: string; errors?: { path?: string; message?: string }[] };
    const status = typeof e.status === 'number' ? e.status : 500;
    const detail = (e.errors ?? [])
      .map((x) => `${x.path ?? ''} ${x.message ?? ''}`.trim())
      .filter((x) => x.length > 0)
      .join('; ');
    res.status(status).json({
      error: detail.length > 0 ? `${e.message ?? 'invalid request'}: ${detail}` : e.message ?? 'internal error',
      // A 500 from response validation means the HANDLER drifted from the spec.
      // Named distinctly so it cannot be mistaken for a client error.
      code: status === 500 ? 'INTERNAL' : status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST',
    });
  });

  return app;
}
