import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';

import type { DB } from './db/client.js';
import { ApibibleCache } from './lib/apibible-cache.js';
import { TAURI_ORIGINS, type AuthEnv, createAuth } from './lib/auth.js';
import { EngineStore } from './lib/engine.js';
import { type Dialect } from './lib/spelling.js';
import {
  type ObservabilityOptions,
  observabilityMiddleware,
  resolveObservabilityOptions,
} from './middleware/observability.js';
import {
  type AppVariables,
  getUser,
  requireAuth,
  sessionMiddleware,
} from './middleware/session.js';
import { accountRoutes } from './routes/account.js';
import { cardsRoutes } from './routes/cards.js';
import { materialsRoutes } from './routes/materials.js';
import { activityRoutes } from './routes/activity.js';
import { schedulesRoutes } from './routes/schedules.js';
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
  /** Override observability middleware defaults. Tests inject a low
   *  cap + captured log callback; production uses the env-var-driven
   *  shape from `src/index.ts`. */
  observability?: Partial<ObservabilityOptions>;
}

export function createApp(deps: AppDeps) {
  const auth = createAuth(deps.db, deps.authEnv);
  // EngineStore's idle reaper is intentionally NOT started here.
  // `createApp` constructs the wiring; lifecycle hooks (start the
  // reaper, listen on a port) live in the production entry point
  // (`src/index.ts`). Tests reach in via `createTestApp` and
  // construct their own short-lived processes, so they neither need
  // nor want a 60 s setInterval per `createApp` call.
  const engines = new EngineStore(deps.db, deps.now);
  const apibibleCache = deps.bibleApiKey
    ? new ApibibleCache(deps.db, deps.bibleApiKey, deps.now)
    : undefined;
  const app = new Hono<{ Variables: AppVariables }>();

  const observabilityOpts = resolveObservabilityOptions({
    now: deps.now,
    ...deps.observability,
  });
  const isProd = process.env.NODE_ENV === 'production';
  // Browser-sent Origin headers are scheme+host+port only. Strip any path
  // (e.g. `/vv` for subpath deployments) from the configured webOrigin so
  // the equality check works.
  const webOrigin = new URL(deps.authEnv.webOrigin).origin;
  // CORS runs OUTERMOST. Hono's cors() sets `Access-Control-Allow-Origin`
  // on `c.res.headers` in its before-phase, which sticks to the final
  // response regardless of which downstream middleware produces it —
  // including the 429 that observability returns directly when a bucket
  // is exhausted. Mounting observability outside cors leaves rate-limit
  // responses without CORS headers, which the browser surfaces as a
  // generic "NetworkError" instead of the real 429 + Retry-After.
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
        if (TAURI_ORIGINS.includes(origin as (typeof TAURI_ORIGINS)[number])) {
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
      // Expose 429-related + correlation headers so browser JS can
      // read them (defaults to a fixed safelist that omits these).
      exposeHeaders: ['Retry-After', 'X-Request-Id'],
    }),
  );
  // Observability + rate-limit middleware replaces Hono's default
  // logger(). See middleware/observability.ts.
  app.use('*', observabilityMiddleware(observabilityOpts));
  // Drops the bulk renders payload for `nkjv-cor` from ~5 MB to ~1 MB.
  app.use('*', compress());

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Session middleware runs on everything except Better Auth's own routes
  // (Better Auth does its own session handling internally) and /health
  // (no auth needed — skips a DB round-trip per healthcheck).
  const session = sessionMiddleware<{ Variables: AppVariables }>(auth);
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next();
    return session(c, next);
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
  app.route('/api/materials', schedulesRoutes({ db: deps.db, engines, now: deps.now }));
  app.route('/api/stats', statsRoutes({ db: deps.db, engines, now: deps.now }));
  app.route('/api/activity', activityRoutes({ db: deps.db, now: deps.now }));
  app.route('/api', accountRoutes({ db: deps.db, engines, now: deps.now }));

  return { app, engines };
}
