import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { NotEnrolledError } from '../lib/engine.js';
import { requireEnrollment } from '../lib/enrollment.js';
import { isPass } from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface StatsRoutesDeps {
  db: DB;
}

/** Stability buckets in days, tuned roughly to "how long until you'd forget it". */
type BucketLabel = 'weak' | 'learning' | 'familiar' | 'strong' | 'mastered';

const STABILITY_FAMILIAR_DAYS = 7;

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

    const events = deps.db
      .select({ grade: schema.reviewEvents.grade })
      .from(schema.reviewEvents)
      .where(
        and(
          eq(schema.reviewEvents.userId, user.id),
          eq(schema.reviewEvents.materialId, materialId),
        ),
      )
      .all();
    const gradeCount = events.length;
    const passCount = events.reduce((acc, e) => acc + (isPass(e.grade) ? 1 : 0), 0);

    const stability = schema.testStates.stability;
    const histogram = deps.db
      .select({
        weak: sql<number>`coalesce(sum(case when ${stability} < 1 then 1 else 0 end), 0)`,
        learning: sql<number>`coalesce(sum(case when ${stability} >= 1 and ${stability} < 7 then 1 else 0 end), 0)`,
        familiar: sql<number>`coalesce(sum(case when ${stability} >= 7 and ${stability} < 30 then 1 else 0 end), 0)`,
        strong: sql<number>`coalesce(sum(case when ${stability} >= 30 and ${stability} < 90 then 1 else 0 end), 0)`,
        mastered: sql<number>`coalesce(sum(case when ${stability} >= 90 then 1 else 0 end), 0)`,
      })
      .from(schema.testStates)
      .where(
        and(
          eq(schema.testStates.userId, user.id),
          eq(schema.testStates.materialId, materialId),
        ),
      )
      .get();
    const testDistribution: Record<BucketLabel, number> = histogram ?? {
      weak: 0,
      learning: 0,
      familiar: 0,
      strong: 0,
      mastered: 0,
    };

    // versesLearned: distinct verse_ids with at least one familiar+ test.
    // The element column is a serde-tagged JSON object — every variant
    // includes verse_id, so extracting via SQLite's json_extract works
    // uniformly.
    const versesLearnedRows = deps.db
      .select({
        verseId: sql<number>`json_extract(${schema.testStates.element}, '$.verse_id')`,
      })
      .from(schema.testStates)
      .where(
        and(
          eq(schema.testStates.userId, user.id),
          eq(schema.testStates.materialId, materialId),
          sql`${schema.testStates.stability} >= ${STABILITY_FAMILIAR_DAYS}`,
        ),
      )
      .groupBy(sql`json_extract(${schema.testStates.element}, '$.verse_id')`)
      .all();

    return c.json({
      materialId,
      versesLearned: versesLearnedRows.length,
      retentionRate: gradeCount > 0 ? passCount / gradeCount : null,
      totalGrades: gradeCount,
      testDistribution,
    });
  });

  return app;
}
