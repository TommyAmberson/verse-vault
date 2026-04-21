import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { NotEnrolledError } from '../lib/engine.js';
import { requireEnrollment } from '../lib/enrollment.js';
import { type Grade, isPass } from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface StatsRoutesDeps {
  db: DB;
}

/** Stability buckets in days, tuned roughly to "how long until you'd forget it". */
type BucketLabel = 'weak' | 'learning' | 'familiar' | 'strong' | 'mastered';

export function statsRoutes(deps: StatsRoutesDeps) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/:materialId', (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    try {
      requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

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
        if (isPass(g)) passCount += 1;
      }
    }

    const stability = schema.edgeStates.stability;
    const histogram = deps.db
      .select({
        weak: sql<number>`coalesce(sum(case when ${stability} < 1 then 1 else 0 end), 0)`,
        learning: sql<number>`coalesce(sum(case when ${stability} >= 1 and ${stability} < 7 then 1 else 0 end), 0)`,
        familiar: sql<number>`coalesce(sum(case when ${stability} >= 7 and ${stability} < 30 then 1 else 0 end), 0)`,
        strong: sql<number>`coalesce(sum(case when ${stability} >= 30 and ${stability} < 90 then 1 else 0 end), 0)`,
        mastered: sql<number>`coalesce(sum(case when ${stability} >= 90 then 1 else 0 end), 0)`,
      })
      .from(schema.edgeStates)
      .where(
        and(
          eq(schema.edgeStates.userId, user.id),
          eq(schema.edgeStates.materialId, materialId),
        ),
      )
      .get();
    const edgeDistribution: Record<BucketLabel, number> = histogram ?? {
      weak: 0,
      learning: 0,
      familiar: 0,
      strong: 0,
      mastered: 0,
    };

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
