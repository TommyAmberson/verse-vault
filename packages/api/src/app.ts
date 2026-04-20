import { Hono } from 'hono';
import { logger } from 'hono/logger';

export function createApp() {
  const app = new Hono();
  app.use('*', logger());
  app.get('/health', (c) => c.json({ status: 'ok' }));
  return app;
}
