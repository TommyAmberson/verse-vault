import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { NotEnrolledError } from '../lib/engine.js';
import {
  AlreadyEnrolledError,
  UnknownMaterialError,
  enrollUser,
  requireEnrollment,
} from '../lib/enrollment.js';
import { MATERIALS } from '../lib/materials.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface MaterialsRoutesDeps {
  db: DB;
  now?: () => number;
}

interface EnrollBody {
  materialId: string;
  clubTier?: number | null;
}

export function materialsRoutes(deps: MaterialsRoutesDeps) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/', (c) => {
    return c.json({ materials: MATERIALS });
  });

  app.post('/enroll', async (c) => {
    const user = getUser(c);
    let body: EnrollBody;
    try {
      body = await c.req.json<EnrollBody>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.materialId !== 'string') {
      return c.json({ error: 'materialId required' }, 400);
    }
    if (body.clubTier != null && typeof body.clubTier !== 'number') {
      return c.json({ error: 'clubTier must be a number or null' }, 400);
    }

    try {
      const result = enrollUser({
        db: deps.db,
        userId: user.id,
        materialId: body.materialId,
        clubTier: body.clubTier ?? null,
        now: deps.now,
      });
      return c.json({ materialId: body.materialId, snapshotId: result.snapshotId, version: result.version });
    } catch (err) {
      if (err instanceof UnknownMaterialError) return c.json({ error: err.message }, 404);
      if (err instanceof AlreadyEnrolledError) return c.json({ error: 'Already enrolled' }, 409);
      throw err;
    }
  });

  app.get('/:id/status', (c) => {
    const user = getUser(c);
    const materialId = c.req.param('id');
    let enrolled;
    try {
      enrolled = requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

    const testCountRow = deps.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.testStates)
      .where(
        and(
          eq(schema.testStates.userId, user.id),
          eq(schema.testStates.materialId, materialId),
        ),
      )
      .get();

    return c.json({
      materialId,
      clubTier: enrolled.clubTier,
      offlineMode: enrolled.offlineMode,
      testCount: testCountRow?.count ?? 0,
    });
  });

  app.patch('/:id/offline-mode', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('id');
    try {
      requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

    let body: { offlineMode?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.offlineMode !== 'boolean') {
      return c.json({ error: 'offlineMode must be a boolean' }, 400);
    }

    deps.db
      .update(schema.userMaterials)
      .set({ offlineMode: body.offlineMode })
      .where(
        and(
          eq(schema.userMaterials.userId, user.id),
          eq(schema.userMaterials.materialId, materialId),
        ),
      )
      .run();

    return c.json({ materialId, offlineMode: body.offlineMode });
  });

  return app;
}
