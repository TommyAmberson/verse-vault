import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  AlreadyEnrolledError,
  UnknownMaterialError,
  enrollUser,
} from '../lib/enrollment.js';
import { MATERIALS, getMaterial } from '../lib/materials.js';
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
    const material = getMaterial(materialId);
    if (!material) return c.json({ error: 'Unknown material' }, 404);

    const enrolled = deps.db
      .select()
      .from(schema.userMaterials)
      .where(
        and(
          eq(schema.userMaterials.userId, user.id),
          eq(schema.userMaterials.materialId, materialId),
        ),
      )
      .get();
    if (!enrolled) return c.json({ error: 'Not enrolled' }, 404);

    const counts = deps.db
      .select({
        state: schema.cardStates.state,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.cardStates)
      .where(
        and(
          eq(schema.cardStates.userId, user.id),
          eq(schema.cardStates.materialId, materialId),
        ),
      )
      .groupBy(schema.cardStates.state)
      .all();

    const byState = { new: 0, learning: 0, review: 0, relearning: 0 };
    for (const row of counts) byState[row.state] = row.count;

    const nextDue = deps.db
      .select({ dueDateSecs: schema.cardStates.dueDateSecs })
      .from(schema.cardStates)
      .where(
        and(
          eq(schema.cardStates.userId, user.id),
          eq(schema.cardStates.materialId, materialId),
          sql`${schema.cardStates.dueDateSecs} IS NOT NULL`,
        ),
      )
      .orderBy(schema.cardStates.dueDateSecs)
      .limit(1)
      .get();

    return c.json({
      materialId,
      clubTier: enrolled.clubTier,
      cardCounts: byState,
      nextDueSecs: nextDue?.dueDateSecs ?? null,
    });
  });

  return app;
}
