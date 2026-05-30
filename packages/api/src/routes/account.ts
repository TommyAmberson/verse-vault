import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { DB } from '../db/client.js';
import { EngineStore } from '../lib/engine.js';
import type { AccountExport } from '../lib/export-format.js';
import { buildAccountExport } from '../lib/export.js';
import {
  ImportValidationError,
  applyAccountImport,
} from '../lib/import.js';
import { deleteAccountProgress } from '../lib/reset.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface AccountRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

/** Cap on POST /api/import payload size. 52k revlog rows from the
 *  test colpkg is ~10 MB of JSON; 50 MB leaves room for full deck
 *  coverage at ~5x headroom. Beyond that, the user should split the
 *  export anyway. */
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

export function accountRoutes(deps: AccountRoutesDeps) {
  const app = new Hono<{ Variables: SessionVariables }>();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  app.use('*', requireAuth());

  app.get('/export', async (c) => {
    const user = getUser(c);
    const payload = await buildAccountExport(deps.db, deps.engines, user.id, now());
    const dateStr = new Date(now() * 1000).toISOString().slice(0, 10);
    c.header('Content-Disposition', `attachment; filename="verse-vault-export-${dateStr}.json"`);
    return c.json(payload);
  });

  app.post(
    '/import',
    bodyLimit({
      maxSize: IMPORT_MAX_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    async (c) => {
      const user = getUser(c);
      let payload: AccountExport;
      try {
        payload = await c.req.json<AccountExport>();
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      try {
        const summary = await applyAccountImport(deps.db, deps.engines, user.id, payload, now());
        return c.json(summary);
      } catch (err) {
        if (err instanceof ImportValidationError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    },
  );

  app.delete('/account/progress', async (c) => {
    const user = getUser(c);
    const summary = await deleteAccountProgress(deps.db, deps.engines, user.id);
    return c.json(summary);
  });

  return app;
}
