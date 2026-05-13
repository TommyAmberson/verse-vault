import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { EngineStore } from '../lib/engine.js';
import { NotEnrolledError } from '../lib/engine.js';
import { requireEnrollment } from '../lib/enrollment.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface YearsRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

export type ClubStatus = 'active' | 'maintenance' | 'paused';
type ClubTier = '150' | '300' | 'full';

const CLUB_STATUSES: readonly ClubStatus[] = ['active', 'maintenance', 'paused'];
const CLUB_TIERS: readonly ClubTier[] = ['150', '300', 'full'];

const DEFAULT_LESSON_BATCH_SIZE = 3;
const MIN_LESSON_BATCH_SIZE = 1;
const MAX_LESSON_BATCH_SIZE = 10;

interface YearSettings {
  headings: boolean;
  ftv: boolean;
  clubCards: boolean;
  lessonBatchSize: number;
}

interface YearView {
  materialId: string;
  settings: YearSettings;
  clubs: Record<ClubTier, { status: ClubStatus; cardCount: number }>;
}

interface SettingsBody {
  headings?: boolean;
  ftv?: boolean;
  clubCards?: boolean;
  lessonBatchSize?: number;
}

interface StatusBody {
  status?: string;
}

interface ClubCounts {
  Club150?: number;
  Club300?: number;
  Full?: number;
}

function ensureBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`);
  }
  return value;
}

function ensureBatchSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError('lessonBatchSize must be an integer');
  }
  if (value < MIN_LESSON_BATCH_SIZE || value > MAX_LESSON_BATCH_SIZE) {
    throw new ValidationError(
      `lessonBatchSize must be between ${MIN_LESSON_BATCH_SIZE} and ${MAX_LESSON_BATCH_SIZE}`,
    );
  }
  return value;
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function readYearSettings(db: DB, userId: string, materialId: string): YearSettings {
  const row = db
    .select()
    .from(schema.userYearSettings)
    .where(
      and(
        eq(schema.userYearSettings.userId, userId),
        eq(schema.userYearSettings.materialId, materialId),
      ),
    )
    .get();
  if (!row) {
    return {
      headings: true,
      ftv: true,
      clubCards: true,
      lessonBatchSize: DEFAULT_LESSON_BATCH_SIZE,
    };
  }
  return {
    headings: row.headings,
    ftv: row.ftv,
    clubCards: row.clubCards,
    lessonBatchSize: row.lessonBatchSize,
  };
}

function readClubStatuses(
  db: DB,
  userId: string,
  materialId: string,
): Map<ClubTier, ClubStatus> {
  const rows = db
    .select()
    .from(schema.userClubStatus)
    .where(
      and(
        eq(schema.userClubStatus.userId, userId),
        eq(schema.userClubStatus.materialId, materialId),
      ),
    )
    .all();
  const out = new Map<ClubTier, ClubStatus>();
  for (const r of rows) {
    if (!CLUB_TIERS.includes(r.clubTier as ClubTier)) continue;
    if (!CLUB_STATUSES.includes(r.status as ClubStatus)) continue;
    out.set(r.clubTier as ClubTier, r.status as ClubStatus);
  }
  return out;
}

export function yearsRoutes(deps: YearsRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/', async (c) => {
    const user = getUser(c);
    const enrolled = deps.db
      .select()
      .from(schema.userMaterials)
      .where(eq(schema.userMaterials.userId, user.id))
      .all();

    const out: YearView[] = [];
    for (const enrollment of enrolled) {
      const { materialId } = enrollment;
      const settings = readYearSettings(deps.db, user.id, materialId);
      const statuses = readClubStatuses(deps.db, user.id, materialId);

      // Engine load gives us per-club card totals. A failure here surfaces
      // as a 500 — every enrolled row should have a graph_snapshot.
      const loaded = await deps.engines.load({ userId: user.id, materialId });
      let counts: ClubCounts = {};
      try {
        counts = JSON.parse(loaded.engine.card_count_by_club()) as ClubCounts;
      } catch {
        counts = {};
      }

      // First visit: auto-create an `active` row for each tier we see in
      // the material. Existing users keep reviewing without an explicit
      // opt-in step, and the picker reflects the live state. Tiers with
      // no cards (e.g. Club300 in a Club150-only material) are skipped.
      const clubs: YearView['clubs'] = {
        '150': { status: 'paused', cardCount: counts.Club150 ?? 0 },
        '300': { status: 'paused', cardCount: counts.Club300 ?? 0 },
        full: { status: 'paused', cardCount: counts.Full ?? 0 },
      };
      for (const tier of CLUB_TIERS) {
        const card_count = clubs[tier].cardCount;
        if (card_count === 0) {
          // No cards in this tier — leave as paused, don't auto-create row.
          continue;
        }
        const existing = statuses.get(tier);
        if (existing) {
          clubs[tier].status = existing;
        } else {
          // Migrate-in-place: persist the auto-active row so subsequent
          // GETs match what's actually in the DB.
          deps.db
            .insert(schema.userClubStatus)
            .values({
              userId: user.id,
              materialId,
              clubTier: tier,
              status: 'active',
              updatedAt: now(),
            })
            .run();
          clubs[tier].status = 'active';
        }
      }

      out.push({
        materialId,
        settings,
        clubs,
      });
    }

    return c.json({ years: out });
  });

  app.post('/:materialId/settings', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    try {
      requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

    let body: SettingsBody;
    try {
      body = (await c.req.json()) as SettingsBody;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const existing = readYearSettings(deps.db, user.id, materialId);
    let next: YearSettings;
    try {
      next = {
        headings:
          body.headings === undefined ? existing.headings : ensureBoolean(body.headings, 'headings'),
        ftv: body.ftv === undefined ? existing.ftv : ensureBoolean(body.ftv, 'ftv'),
        clubCards:
          body.clubCards === undefined
            ? existing.clubCards
            : ensureBoolean(body.clubCards, 'clubCards'),
        lessonBatchSize:
          body.lessonBatchSize === undefined
            ? existing.lessonBatchSize
            : ensureBatchSize(body.lessonBatchSize),
      };
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }

    const ts = now();
    deps.db
      .insert(schema.userYearSettings)
      .values({
        userId: user.id,
        materialId,
        headings: next.headings,
        ftv: next.ftv,
        clubCards: next.clubCards,
        lessonBatchSize: next.lessonBatchSize,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [schema.userYearSettings.userId, schema.userYearSettings.materialId],
        set: {
          headings: next.headings,
          ftv: next.ftv,
          clubCards: next.clubCards,
          lessonBatchSize: next.lessonBatchSize,
          updatedAt: ts,
        },
      })
      .run();

    // Settings changes alter which CardKinds the builder emits; the cached
    // engine reflects the old config until we drop it.
    deps.engines.invalidate({ userId: user.id, materialId });

    return c.json({ settings: next });
  });

  app.post('/:materialId/clubs/:tier/status', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    const tier = c.req.param('tier');
    try {
      requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }
    if (!CLUB_TIERS.includes(tier as ClubTier)) {
      return c.json({ error: `tier must be one of: ${CLUB_TIERS.join(', ')}` }, 400);
    }

    let body: StatusBody;
    try {
      body = (await c.req.json()) as StatusBody;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.status !== 'string' || !CLUB_STATUSES.includes(body.status as ClubStatus)) {
      return c.json(
        { error: `status must be one of: ${CLUB_STATUSES.join(', ')}` },
        400,
      );
    }

    const ts = now();
    deps.db
      .insert(schema.userClubStatus)
      .values({
        userId: user.id,
        materialId,
        clubTier: tier,
        status: body.status,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [
          schema.userClubStatus.userId,
          schema.userClubStatus.materialId,
          schema.userClubStatus.clubTier,
        ],
        set: { status: body.status, updatedAt: ts },
      })
      .run();

    // Pausing/un-pausing changes which verses the builder includes; drop
    // the cached engine so the next /api/cards/next sees the new shape.
    deps.engines.invalidate({ userId: user.id, materialId });

    return c.json({ tier, status: body.status });
  });

  return app;
}
