import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { DB } from './db/client.js';
import { type AuthEnv, createAuth } from './lib/auth.js';
import { type SessionVariables, getUser, requireAuth, sessionMiddleware } from './middleware/session.js';

export interface AppDeps {
  db: DB;
  auth: AuthEnv;
}

export function createApp(deps: AppDeps) {
  const auth = createAuth(deps.db, deps.auth);
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', logger());
  app.use(
    '*',
    cors({
      origin: [deps.auth.webOrigin],
      credentials: true,
    }),
  );
  app.use('*', sessionMiddleware(auth));

  // Better Auth handles /api/auth/* — sign-up, sign-in, OAuth, session, etc.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/api/me', requireAuth(), (c) => c.json({ user: getUser(c) }));

  return app;
}
