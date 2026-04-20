import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { DB } from './db/client.js';
import { type AuthEnv, createAuth } from './lib/auth.js';
import { type SessionVariables, getUser, requireAuth, sessionMiddleware } from './middleware/session.js';

export interface AppDeps {
  db: DB;
  authEnv: AuthEnv;
}

export function createApp(deps: AppDeps) {
  const auth = createAuth(deps.db, deps.authEnv);
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', logger());
  app.use(
    '*',
    cors({
      origin: [deps.authEnv.webOrigin],
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

  return app;
}
