import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { getMaterial } from '../lib/materials.js';
import type { Grade } from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface StatsRoutesDeps {
  db: DB;
}

/** Stability buckets in days, tuned roughly to "how long until you'd forget it". */
const EDGE_BUCKETS = [
  { label: 'weak', max: 1 },
  { label: 'learning', max: 7 },
  { label: 'familiar', max: 30 },
  { label: 'strong', max: 90 },
  { label: 'mastered', max: Infinity },
] as const;

type BucketLabel = (typeof EDGE_BUCKETS)[number]['label'];

export function statsRoutes(deps: StatsRoutesDeps) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/:materialId', (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
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

    const versesLearnedRow = deps.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.cardStates)
      .where(
        and(
          eq(schema.cardStates.userId, user.id),
          eq(schema.cardStates.materialId, materialId),
          eq(schema.cardStates.state, 'review'),
        ),
      )
      .get();

    const events = deps.db
      .select({ grades: schema.reviewEvents.grades })
      .from(schema.reviewEvents)
      .where(
        and(
          eq(schema.reviewEvents.userId, user.id),
          eq(schema.reviewEvents.materialId, materialId),
        ),
      )
      .all();
    let gradeCount = 0;
    let passCount = 0;
    for (const row of events) {
      const grades = JSON.parse(row.grades.toString('utf8')) as Grade[];
      for (const g of grades) {
        gradeCount += 1;
        if (g.grade >= 3) passCount += 1;
      }
    }

    const edges = deps.db
      .select({ stability: schema.edgeStates.stability })
      .from(schema.edgeStates)
      .where(
        and(
          eq(schema.edgeStates.userId, user.id),
          eq(schema.edgeStates.materialId, materialId),
        ),
      )
      .all();
    const edgeDistribution: Record<BucketLabel, number> = {
      weak: 0,
      learning: 0,
      familiar: 0,
      strong: 0,
      mastered: 0,
    };
    for (const e of edges) {
      const bucket = EDGE_BUCKETS.find((b) => e.stability < b.max)!;
      edgeDistribution[bucket.label] += 1;
    }

    return c.json({
      materialId,
      versesLearned: versesLearnedRow?.count ?? 0,
      retentionRate: gradeCount > 0 ? passCount / gradeCount : null,
      totalGrades: gradeCount,
      edgeDistribution,
    });
  });

  return app;
}
