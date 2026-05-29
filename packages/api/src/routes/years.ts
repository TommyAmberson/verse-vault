import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { EngineStore } from '../lib/engine.js';
import { AlreadyEnrolledError, enrollUser, isEnrolled } from '../lib/enrollment.js';
import { MATERIALS } from '../lib/materials.js';
import {
  CHAPTER_LIST_SCOPES,
  type ChapterListScope,
  DEFAULT_LESSON_BATCH_SIZE,
  ensureBatchSize,
  ensureBoolean,
  ensureEnum,
  ensureRetention,
  TIER_SCOPES,
  type TierScope,
  ValidationError,
  type YearSettings,
} from '../lib/year-settings.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface YearsRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

export type ClubStatus = 'active' | 'maintenance' | 'paused';
type ClubTier = '150' | '300' | 'full';

const CLUB_TIERS: readonly ClubTier[] = ['150', '300', 'full'];

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
  /** When true, the user has opted into the bulk-renders download for
   *  this year. Sourced from the `offline_mode` column on the
   *  `user_materials` row (false for unenrolled years). */
  offlineMode: boolean;
  settings: YearSettings;
  clubs: Record<ClubTier, ClubView>;
  /** Count of cards still in `CardState::New` — drives the
   *  "N to memorize" nudge in the web nav. */
  newCardCount: number;
}

interface SettingsBody {
  headingCard?: boolean;
  headingPassageCard?: boolean;
  ftv?: boolean;
  newScope?: string;
  reviewScope?: string;
  clubCardScope?: string;
  chapterListScope?: string;
  lessonBatchSize?: number;
  desiredRetention?: number;
}

interface ClubCounts {
  Club150?: number;
  Club300?: number;
  Full?: number;
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
// VerseInHeading defaults off; HeadingPassage defaults on. Mirrors
// `MaterialConfig::default()` after the heading config split (core
// 0.2.0): the passage-cued card is the primary heading test and the
// per-verse "which heading?" card is now opt-in.
const ENROLLED_DEFAULTS: YearSettings = {
  headingCard: false,
  headingPassageCard: true,
  ftv: true,
  newScope: 'all',
  reviewScope: 'all',
  clubCardScope: 'off',
  chapterListScope: 'up150',
  lessonBatchSize: DEFAULT_LESSON_BATCH_SIZE,
  desiredRetention: 0.9,
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
    headingCard: row.headingCard,
    headingPassageCard: row.headingPassageCard,
    ftv: row.ftv,
    newScope: row.newScope as TierScope,
    reviewScope: row.reviewScope as TierScope,
    clubCardScope: row.clubCardScope as TierScope,
    chapterListScope: row.chapterListScope as ChapterListScope,
    lessonBatchSize: row.lessonBatchSize,
    desiredRetention: row.desiredRetention,
  };
}

export function yearsRoutes(deps: YearsRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/', async (c) => {
    const user = getUser(c);
    const enrolledRows = deps.db
      .select()
      .from(schema.userMaterials)
      .where(eq(schema.userMaterials.userId, user.id))
      .all();
    const enrolledIds = new Set(enrolledRows.map((r) => r.materialId));
    const offlineModeByMaterial = new Map(enrolledRows.map((r) => [r.materialId, r.offlineMode]));

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
      let newCardCount = 0;
      if (enrolled) {
        try {
          using loaded = await deps.engines.load({ userId: user.id, materialId: material.id });
          counts = JSON.parse(loaded.engine.card_count_by_club()) as ClubCounts;
          newCardCount = loaded.engine.new_card_count();
        } catch (err) {
          // Don't fail the whole picker render if one year's engine can't
          // build — degrade that row to zero counts and log so it's
          // discoverable rather than silent.
          console.error(
            `years: failed to load engine for material=${material.id}:`,
            err,
          );
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
        offlineMode: offlineModeByMaterial.get(material.id) ?? false,
        settings,
        clubs,
        newCardCount,
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
      const pick = <K extends keyof YearSettings>(
        field: K,
        validate: (v: unknown) => YearSettings[K],
      ): YearSettings[K] =>
        body[field] === undefined ? existing[field] : validate(body[field]);

      next = {
        headingCard: pick('headingCard', (v) => ensureBoolean(v, 'headingCard')),
        headingPassageCard: pick('headingPassageCard', (v) =>
          ensureBoolean(v, 'headingPassageCard'),
        ),
        ftv: pick('ftv', (v) => ensureBoolean(v, 'ftv')),
        newScope: pick('newScope', (v) => ensureEnum(v, 'newScope', TIER_SCOPES)),
        reviewScope: pick('reviewScope', (v) => ensureEnum(v, 'reviewScope', TIER_SCOPES)),
        clubCardScope: pick('clubCardScope', (v) =>
          ensureEnum(v, 'clubCardScope', TIER_SCOPES),
        ),
        chapterListScope: pick('chapterListScope', (v) =>
          ensureEnum(v, 'chapterListScope', CHAPTER_LIST_SCOPES),
        ),
        lessonBatchSize: pick('lessonBatchSize', ensureBatchSize),
        desiredRetention: pick('desiredRetention', ensureRetention),
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
    const row = { ...next, updatedAt: ts };
    deps.db
      .insert(schema.userYearSettings)
      .values({ userId: user.id, materialId, ...row })
      .onConflictDoUpdate({
        target: [schema.userYearSettings.userId, schema.userYearSettings.materialId],
        set: row,
      })
      .run();

    deps.engines.invalidate({ userId: user.id, materialId });

    return c.json({ settings: next });
  });

  return app;
}
