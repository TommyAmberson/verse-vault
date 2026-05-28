import { and, eq, gte, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface ActivityRoutesDeps {
  db: DB;
  now?: () => number;
}

const DEFAULT_DAYS = 365;
const MAX_DAYS = 1825; // ~5 academic years — enough for the year picker
const SECONDS_PER_DAY = 86_400;

interface DayCount {
  /** ISO `YYYY-MM-DD` in UTC. SQLite's `date(epoch, 'unixepoch')` is
   *  the canonical UTC-day grouping; the dashboard heatmap renders in
   *  user-local time but the per-day buckets are UTC so the response
   *  is timezone-invariant across devices syncing the same account. */
  date: string;
  count: number;
}

export function activityRoutes(deps: ActivityRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/', (c) => {
    const user = getUser(c);
    const daysRaw = Number(c.req.query('days') ?? DEFAULT_DAYS);
    const days = Number.isFinite(daysRaw)
      ? Math.max(1, Math.min(MAX_DAYS, Math.floor(daysRaw)))
      : DEFAULT_DAYS;

    const cutoffSecs = now() - days * SECONDS_PER_DAY;

    const reviews: DayCount[] = deps.db
      .select({
        date: sql<string>`date(${schema.reviewEvents.timestampSecs}, 'unixepoch')`,
        count: sql<number>`count(*)`,
      })
      .from(schema.reviewEvents)
      .where(
        and(
          eq(schema.reviewEvents.userId, user.id),
          gte(schema.reviewEvents.timestampSecs, cutoffSecs),
        ),
      )
      .groupBy(sql`date(${schema.reviewEvents.timestampSecs}, 'unixepoch')`)
      .all();

    // Memorize series = verse graduations; one row per verse, aggregated
    // by day to mirror the reviews series shape.
    const memorize: DayCount[] = deps.db
      .select({
        date: sql<string>`date(${schema.graduatedVerses.graduatedAtSecs}, 'unixepoch')`,
        count: sql<number>`count(*)`,
      })
      .from(schema.graduatedVerses)
      .where(
        and(
          eq(schema.graduatedVerses.userId, user.id),
          gte(schema.graduatedVerses.graduatedAtSecs, cutoffSecs),
        ),
      )
      .groupBy(sql`date(${schema.graduatedVerses.graduatedAtSecs}, 'unixepoch')`)
      .all();

    return c.json({ reviews, memorize, requestedDays: days });
  });

  return app;
}
