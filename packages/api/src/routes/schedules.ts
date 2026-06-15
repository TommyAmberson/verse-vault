import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { EngineStore } from '../lib/engine.js';
import { MATERIALS } from '../lib/materials.js';
import {
  ScheduleValidationError,
  loadBundledSchedule,
  loadSchedule,
  validateSchedule,
} from '../lib/schedules.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface SchedulesRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

/**
 * `/api/materials/:materialId/schedule` — per-user customisable
 * memorize schedule overrides.
 *
 *   GET     → returns the user's customised schedule if present, else
 *             the bundled default. Returns `{ schedule: null }` when
 *             neither exists (the material ships without one — engine
 *             collapses to pure-Sequential).
 *   PUT     → validates the body's shape, upserts into
 *             material_schedules, invalidates the cached engine so the
 *             next request rebuilds against the new schedule.
 *   DELETE  → drops the user's override; bundled default reapplies.
 *             Same engine-cache invalidation as PUT.
 *
 * No auth → 401. Unknown materialId → 404. Invalid PUT body → 400.
 */
export function schedulesRoutes(deps: SchedulesRoutesDeps) {
  const app = new Hono<{ Variables: SessionVariables }>();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  app.use('*', requireAuth());

  app.get('/:materialId/schedule', (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    if (!MATERIALS.some((m) => m.id === materialId)) {
      return c.json({ error: `Unknown material: ${materialId}` }, 404);
    }
    const json = loadSchedule(deps.db, user.id, materialId);
    if (json === '') return c.json({ schedule: null });
    return c.body(json, 200, { 'Content-Type': 'application/json' });
  });

  app.put('/:materialId/schedule', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    if (!MATERIALS.some((m) => m.id === materialId)) {
      return c.json({ error: `Unknown material: ${materialId}` }, 404);
    }
    const text = await c.req.text();
    try {
      validateSchedule(text);
    } catch (err) {
      if (err instanceof ScheduleValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
    const updatedAt = now();
    deps.db
      .insert(schema.materialSchedules)
      .values({ userId: user.id, materialId, scheduleJson: text, updatedAt })
      .onConflictDoUpdate({
        target: [schema.materialSchedules.userId, schema.materialSchedules.materialId],
        set: { scheduleJson: text, updatedAt },
      })
      .run();
    deps.engines.invalidate({ userId: user.id, materialId });
    return c.json({ ok: true });
  });

  app.delete('/:materialId/schedule', (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    if (!MATERIALS.some((m) => m.id === materialId)) {
      return c.json({ error: `Unknown material: ${materialId}` }, 404);
    }
    deps.db
      .delete(schema.materialSchedules)
      .where(
        and(
          eq(schema.materialSchedules.userId, user.id),
          eq(schema.materialSchedules.materialId, materialId),
        ),
      )
      .run();
    deps.engines.invalidate({ userId: user.id, materialId });
    // Surface what the GET path would now return so the client can
    // re-render without a follow-up round-trip.
    const fallback = loadBundledSchedule(materialId);
    return c.json({ ok: true, fallbackToBundled: fallback !== '' });
  });

  return app;
}
