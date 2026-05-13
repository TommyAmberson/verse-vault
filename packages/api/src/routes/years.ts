import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { EngineStore } from '../lib/engine.js';
import { AlreadyEnrolledError, enrollUser, isEnrolled } from '../lib/enrollment.js';
import { MATERIALS } from '../lib/materials.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface YearsRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

export type ClubStatus = 'active' | 'maintenance' | 'paused';
export type TierScope = 'off' | 'up150' | 'up300' | 'all';
export type ChapterListScope = 'off' | 'up150' | 'up300';
type ClubTier = '150' | '300' | 'full';

const TIER_SCOPES: readonly TierScope[] = ['off', 'up150', 'up300', 'all'];
const CHAPTER_LIST_SCOPES: readonly ChapterListScope[] = ['off', 'up150', 'up300'];
const CLUB_TIERS: readonly ClubTier[] = ['150', '300', 'full'];

const DEFAULT_LESSON_BATCH_SIZE = 3;
const MIN_LESSON_BATCH_SIZE = 1;
const MAX_LESSON_BATCH_SIZE = 10;

interface YearSettings {
  headings: boolean;
  ftv: boolean;
  newScope: TierScope;
  reviewScope: TierScope;
  clubCardScope: TierScope;
  chapterListScope: ChapterListScope;
  lessonBatchSize: number;
}

interface ClubView {
  /** Effective per-tier status derived from active_scope and
   *  maintenance_scope. Read-only on the API; clients set the two
   *  scopes via the year-settings endpoint. */
  status: ClubStatus;
  cardCount: number;
}

interface YearView {
  materialId: string;
  title: string;
  description: string;
  /** True when the user has at least the graph_snapshot + user_materials
   *  row provisioned (i.e. has previously bumped a scope above Off, or
   *  enrolled via the legacy /api/materials/enroll path). The picker
   *  can show un-provisioned years too — bumping a scope above Off
   *  auto-provisions on save. */
  enrolled: boolean;
  settings: YearSettings;
  clubs: Record<ClubTier, ClubView>;
}

interface SettingsBody {
  headings?: boolean;
  ftv?: boolean;
  newScope?: string;
  reviewScope?: string;
  clubCardScope?: string;
  chapterListScope?: string;
  lessonBatchSize?: number;
}

interface ClubCounts {
  Club150?: number;
  Club300?: number;
  Full?: number;
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
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

function ensureTierScope(value: unknown, field: string): TierScope {
  if (typeof value !== 'string' || !TIER_SCOPES.includes(value as TierScope)) {
    throw new ValidationError(`${field} must be one of: ${TIER_SCOPES.join(', ')}`);
  }
  return value as TierScope;
}

function ensureChapterListScope(value: unknown, field: string): ChapterListScope {
  if (
    typeof value !== 'string' ||
    !CHAPTER_LIST_SCOPES.includes(value as ChapterListScope)
  ) {
    throw new ValidationError(`${field} must be one of: ${CHAPTER_LIST_SCOPES.join(', ')}`);
  }
  return value as ChapterListScope;
}

function tierScopeIncludes(scope: TierScope, tier: ClubTier): boolean {
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  if (scope === 'up150') return tier === '150';
  return tier === '150' || tier === '300';
}

function effectiveStatus(settings: YearSettings, tier: ClubTier): ClubStatus {
  if (tierScopeIncludes(settings.newScope, tier)) return 'active';
  if (tierScopeIncludes(settings.reviewScope, tier)) return 'maintenance';
  return 'paused';
}

// Two fallbacks when the user has no user_year_settings row. Enrolled
// users default to "study everything" (mirrors the engine's
// MaterialConfig::default); unenrolled users default to paused so the
// per-tier chip doesn't lie ("Active" on a year the user hasn't
// touched would be misleading). Either way, the user can opt in or
// out from the picker.
const ENROLLED_DEFAULTS: YearSettings = {
  headings: true,
  ftv: true,
  newScope: 'all',
  reviewScope: 'all',
  clubCardScope: 'all',
  chapterListScope: 'up300',
  lessonBatchSize: DEFAULT_LESSON_BATCH_SIZE,
};

const UNENROLLED_DEFAULTS: YearSettings = {
  ...ENROLLED_DEFAULTS,
  newScope: 'off',
  reviewScope: 'off',
};

function readYearSettings(
  db: DB,
  userId: string,
  materialId: string,
  fallback: YearSettings,
): YearSettings {
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
  if (!row) return fallback;
  return {
    headings: row.headings,
    ftv: row.ftv,
    newScope: row.newScope as TierScope,
    reviewScope: row.reviewScope as TierScope,
    clubCardScope: row.clubCardScope as TierScope,
    chapterListScope: row.chapterListScope as ChapterListScope,
    lessonBatchSize: row.lessonBatchSize,
  };
}

export function yearsRoutes(deps: YearsRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/', async (c) => {
    const user = getUser(c);
    const enrolledIds = new Set(
      deps.db
        .select()
        .from(schema.userMaterials)
        .where(eq(schema.userMaterials.userId, user.id))
        .all()
        .map((r) => r.materialId),
    );

    const out: YearView[] = [];
    for (const material of MATERIALS) {
      const enrolled = enrolledIds.has(material.id);
      const settings = readYearSettings(
        deps.db,
        user.id,
        material.id,
        enrolled ? ENROLLED_DEFAULTS : UNENROLLED_DEFAULTS,
      );

      // Only load the engine for enrolled years — unenrolled ones have
      // no graph_snapshot yet. Card counts stay at zero until the user
      // enables a scope (which auto-enrolls on save).
      let counts: ClubCounts = {};
      if (enrolled) {
        try {
          const loaded = await deps.engines.load({ userId: user.id, materialId: material.id });
          counts = JSON.parse(loaded.engine.card_count_by_club()) as ClubCounts;
        } catch {
          counts = {};
        }
      }

      const clubs: YearView['clubs'] = {
        '150': {
          status: effectiveStatus(settings, '150'),
          cardCount: counts.Club150 ?? 0,
        },
        '300': {
          status: effectiveStatus(settings, '300'),
          cardCount: counts.Club300 ?? 0,
        },
        full: {
          status: effectiveStatus(settings, 'full'),
          cardCount: counts.Full ?? 0,
        },
      };

      out.push({
        materialId: material.id,
        title: material.title,
        description: material.description,
        enrolled,
        settings,
        clubs,
      });
    }

    return c.json({ years: out });
  });

  app.post('/:materialId/settings', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    if (!MATERIALS.some((m) => m.id === materialId)) {
      return c.json({ error: `Unknown material: ${materialId}` }, 404);
    }

    let body: SettingsBody;
    try {
      body = (await c.req.json()) as SettingsBody;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    // For partial-body merging, pick defaults based on whether the
    // user is already enrolled. Enrolled-without-row falls back to
    // "study everything" (matching the engine's default behaviour);
    // unenrolled-without-row falls back to off/off so a partial save
    // doesn't accidentally activate scopes the user didn't touch.
    const alreadyEnrolled = isEnrolled(deps.db, { userId: user.id, materialId });
    const existing = readYearSettings(
      deps.db,
      user.id,
      materialId,
      alreadyEnrolled ? ENROLLED_DEFAULTS : UNENROLLED_DEFAULTS,
    );
    let next: YearSettings;
    try {
      next = {
        headings:
          body.headings === undefined ? existing.headings : ensureBoolean(body.headings, 'headings'),
        ftv: body.ftv === undefined ? existing.ftv : ensureBoolean(body.ftv, 'ftv'),
        newScope:
          body.newScope === undefined
            ? existing.newScope
            : ensureTierScope(body.newScope, 'newScope'),
        reviewScope:
          body.reviewScope === undefined
            ? existing.reviewScope
            : ensureTierScope(body.reviewScope, 'reviewScope'),
        clubCardScope:
          body.clubCardScope === undefined
            ? existing.clubCardScope
            : ensureTierScope(body.clubCardScope, 'clubCardScope'),
        chapterListScope:
          body.chapterListScope === undefined
            ? existing.chapterListScope
            : ensureChapterListScope(body.chapterListScope, 'chapterListScope'),
        lessonBatchSize:
          body.lessonBatchSize === undefined
            ? existing.lessonBatchSize
            : ensureBatchSize(body.lessonBatchSize),
      };
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }

    // Auto-enroll: the moment a user bumps a scope above Off they're
    // committing to study this year. enrollUser is idempotent against
    // a concurrent double-call via AlreadyEnrolledError.
    const wantsActivity = next.newScope !== 'off' || next.reviewScope !== 'off';
    if (wantsActivity && !alreadyEnrolled) {
      try {
        enrollUser({ db: deps.db, userId: user.id, materialId, now: deps.now });
      } catch (err) {
        if (!(err instanceof AlreadyEnrolledError)) throw err;
      }
    }

    const ts = now();
    deps.db
      .insert(schema.userYearSettings)
      .values({
        userId: user.id,
        materialId,
        headings: next.headings,
        ftv: next.ftv,
        newScope: next.newScope,
        reviewScope: next.reviewScope,
        clubCardScope: next.clubCardScope,
        chapterListScope: next.chapterListScope,
        lessonBatchSize: next.lessonBatchSize,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [schema.userYearSettings.userId, schema.userYearSettings.materialId],
        set: {
          headings: next.headings,
          ftv: next.ftv,
          newScope: next.newScope,
          reviewScope: next.reviewScope,
          clubCardScope: next.clubCardScope,
          chapterListScope: next.chapterListScope,
          lessonBatchSize: next.lessonBatchSize,
          updatedAt: ts,
        },
      })
      .run();

    deps.engines.invalidate({ userId: user.id, materialId });

    return c.json({ settings: next });
  });

  return app;
}
