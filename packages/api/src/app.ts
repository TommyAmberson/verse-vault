import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { DB } from './db/client.js';
import { ApibibleCache } from './lib/apibible-cache.js';
import { TAURI_ORIGINS, type AuthEnv, createAuth } from './lib/auth.js';
import { EngineStore } from './lib/engine.js';
import { type Dialect } from './lib/spelling.js';
import { type SessionVariables, getUser, requireAuth, sessionMiddleware } from './middleware/session.js';
import { cardsRoutes } from './routes/cards.js';
import { materialsRoutes } from './routes/materials.js';
import { statsRoutes } from './routes/stats.js';
import { syncRoutes } from './routes/sync.js';
import { yearsRoutes } from './routes/years.js';

export interface AppDeps {
  db: DB;
  authEnv: AuthEnv;
  /** api.bible API key. When unset, GET /api/cards/:id renders without
   *  the canonical-text composition (composed: null). The structural
   *  metadata is unchanged. */
  bibleApiKey?: string;
  /** NKJV bible id on the api.bible account. Defaults to the account's
   *  current NKJV when unset; override via env. */
  bibleId?: string;
  /** Spelling dialect for rendered verse HTML. Defaults to ``canadian``
   *  inside ``composeRender``; pass ``american`` to keep api.bible's
   *  original NKJV spelling untouched. Sourced from the ``RENDER_DIALECT``
   *  env var at boot; will move to a per-user setting later. */
  dialect?: Dialect;
  now?: () => number;
}

export function createApp(deps: AppDeps) {
  const auth = createAuth(deps.db, deps.authEnv);
  const engines = new EngineStore(deps.db, undefined, deps.now);
  const apibibleCache = deps.bibleApiKey
    ? new ApibibleCache(deps.db, deps.bibleApiKey, deps.now)
    : undefined;
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', logger());
  // Drops the bulk renders payload for `nkjv-cor` from ~5 MB to ~1 MB.
  app.use('*', compress());
  const isProd = process.env.NODE_ENV === 'production';
  // Browser-sent Origin headers are scheme+host+port only. Strip any path
  // (e.g. `/vv` for subpath deployments) from the configured webOrigin so
  // the equality check works.
  const webOrigin = new URL(deps.authEnv.webOrigin).origin;
  app.use(
    '*',
    cors({
      // Outside production, accept any http://localhost:PORT origin so the
      // thin client running on whatever port Vite picked can talk to the
      // API without a coordinated WEB_BASE_URL. In production only the
      // configured webOrigin + Tauri origins are allowed. See TAURI_ORIGINS
      // in auth.ts for the per-webview-family rationale.
      origin: (origin) => {
        if (origin === webOrigin) return origin;
        if (origin != null && TAURI_ORIGINS.includes(origin as (typeof TAURI_ORIGINS)[number])) {
          return origin;
        }
        if (
          !isProd &&
          origin &&
          /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
        ) {
          return origin;
        }
        return null;
      },
      credentials: true,
    }),
  );

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Session middleware runs on everything except Better Auth's own routes
  // (Better Auth does its own session handling internally) and /health
  // (no auth needed — skips a DB round-trip per healthcheck).
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next();
    return sessionMiddleware(auth)(c, next);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/api/me', requireAuth(), (c) => c.json({ user: getUser(c) }));

  app.route(
    '/api/cards',
    cardsRoutes({
      db: deps.db,
      engines,
      apibibleCache,
      bibleId: deps.bibleId,
      dialect: deps.dialect,
      now: deps.now,
    }),
  );
  app.route('/api/sync', syncRoutes({ db: deps.db, engines, now: deps.now }));
  app.route(
    '/api/materials',
    materialsRoutes({
      db: deps.db,
      engines,
      apibibleCache,
      bibleId: deps.bibleId,
      dialect: deps.dialect,
      now: deps.now,
    }),
  );
  app.route('/api/years', yearsRoutes({ db: deps.db, engines, now: deps.now }));
  app.route('/api/stats', statsRoutes({ db: deps.db }));

  return app;
}
