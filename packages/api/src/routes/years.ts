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
  legacyToNew,
  looksLikePerClub,
  type PerClubYearSettings,
  perClubToLegacy,
  TIER_SCOPES,
  type TierScope,
  ValidationError,
  validatePerClubYearSettings,
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
  /** Effective per-tier status derived from the per-club `enabled`
   *  booleans in `MaterialConfig`. Read-only on the API; clients set
   *  enable flags via `POST /api/years/:id/settings`. */
  status: ClubStatus;
  cardCount: number;
  // TODO(phase-3): expose per-club `graduated` count here. The web
  // client's Memorize-tab badge in apps/web/src/lib/badges.ts is
  // approximating `max(0, cumulative_through_current_week - memorized)`
  // by `min(newCardCount, cumulative)` because there's no per-club
  // graduated count on this response. The engine already knows the
  // value via `WasmEngine.card_count_by_club()` plus a graduated-set
  // filter; surfacing it lets the badge match the spec formula
  // exactly. Spec: docs/superpowers/specs/2026-06-14-schedules-and-settings-design.md
  // §"Memorize tab badge".
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
  /** Legacy flat settings — kept on the response for clients that
   *  haven't migrated to `perClub`. The engine reads `perClub`. */
  settings: YearSettings;
  /** Phase 1+ per-club configuration. Mirrors what's stored in
   *  `user_year_settings.config_json` (synthesised via `legacyToNew`
   *  when the column hasn't been populated yet). Lossless: includes
   *  `catchUp` and `moveToNext` choices that the legacy `settings`
   *  field can't represent, so the chain UI in /settings/materials can
   *  round-trip them without dropping the user's selections. */
  perClub: PerClubYearSettings;
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

const TIER_TO_CLUB_KEY: Record<ClubTier, 'club150' | 'club300' | 'full'> = {
  '150': 'club150',
  '300': 'club300',
  full: 'full',
};

/** Effective per-tier status derived from the per-club booleans —
 *  memorize-on (with or without review) → active, review-only →
 *  maintenance, neither → paused. Matches the chip semantics shown in
 *  /settings/materials' per-club cards. Reading per-club instead of the
 *  legacy `newScope`/`reviewScope` ladders avoids the lossy collapse
 *  for non-monotonic configs (e.g. only Club 300 enabled). */
function effectiveStatus(perClub: PerClubYearSettings, tier: ClubTier): ClubStatus {
  const club = TIER_TO_CLUB_KEY[tier];
  if (perClub.memorize[club].enabled) return 'active';
  if (perClub.review[club].enabled) return 'maintenance';
  return 'paused';
}

// Two fallbacks when the user has no user_year_settings row. Enrolled
// users default to "study everything" — every tier covered by both
// scopes (wider than the post-Phase-1 `MaterialConfig::default()`,
// which is Club-150-only, but matches the *legacy* shape this route
// still surfaces alongside the per-club `configJson`). Unenrolled
// users default to paused so the per-tier chip doesn't lie ("Active"
// on a year the user hasn't touched would be misleading). Either way,
// the user can opt in or out from the picker.
// VerseInHeading defaults off; HeadingPassage defaults on. Matches the
// core defaults after the heading config split (core 0.2.0): the
// passage-cued card is the primary heading test and the per-verse
// "which heading?" card is now opt-in.
// `desiredRetention: 0.8` matches the post-Phase-1 spec — `legacyToNew`
// uses this value verbatim when synthesising `config_json`, so the
// engine's per-club retention agrees with the spec for users who post
// partial legacy bodies. Pre-Phase-1 clients reading the /api/years
// response receive 0.8 instead of the old 0.9 default; both values are
// inside the legacy `ensureRetention` range so no client breaks.
const ENROLLED_DEFAULTS: YearSettings = {
  headingCard: false,
  headingPassageCard: true,
  ftv: true,
  newScope: 'all',
  reviewScope: 'all',
  clubCardScope: 'off',
  chapterListScope: 'up150',
  lessonBatchSize: DEFAULT_LESSON_BATCH_SIZE,
  desiredRetention: 0.8,
};

const UNENROLLED_DEFAULTS: YearSettings = {
  ...ENROLLED_DEFAULTS,
  newScope: 'off',
  reviewScope: 'off',
};

type SettingsRow = typeof schema.userYearSettings.$inferSelect;

/** Narrow a raw Drizzle row to the legacy `YearSettings` shape. The DB
 *  schema declares scope/chapterListScope as plain `text` (not the
 *  string-literal unions), so the cast is the boundary where we trust
 *  the writer to have validated. */
function rowToYearSettings(row: SettingsRow): YearSettings {
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

function fetchSettingsRow(
  db: DB,
  userId: string,
  materialId: string,
): SettingsRow | undefined {
  return db
    .select()
    .from(schema.userYearSettings)
    .where(
      and(
        eq(schema.userYearSettings.userId, userId),
        eq(schema.userYearSettings.materialId, materialId),
      ),
    )
    .get();
}

function readYearSettings(
  db: DB,
  userId: string,
  materialId: string,
  fallback: YearSettings,
): YearSettings {
  const row = fetchSettingsRow(db, userId, materialId);
  return row ? rowToYearSettings(row) : fallback;
}

/** Build both the legacy `YearSettings` and the per-club shape from a
 *  single DB read. The GET `/api/years` loop calls this once per
 *  enrolled material — splitting the query into two helpers (the
 *  pre-cleanup shape) doubled the SQLite queries on this endpoint,
 *  which is hit on every navigation.
 *
 *  Per-club derivation mirrors `readMaterialConfigJson` in lib/engine.ts:
 *  prefer the stored `config_json` blob, fall back to synthesising via
 *  `legacyToNew(legacySettings)` when the column hasn't been populated
 *  yet. The legacy path runs through `rowToYearSettings` so the scope
 *  fields are narrowed to their enums before `legacyToNew` reads them. */
function readSettingsBundle(
  db: DB,
  userId: string,
  materialId: string,
  fallback: YearSettings,
): { legacy: YearSettings; perClub: PerClubYearSettings } {
  const row = fetchSettingsRow(db, userId, materialId);
  const legacy = row ? rowToYearSettings(row) : fallback;
  const perClub =
    row?.configJson != null && row.configJson !== ''
      ? (JSON.parse(row.configJson) as PerClubYearSettings)
      : legacyToNew(legacy);
  return { legacy, perClub };
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
      const fallback = enrolled ? ENROLLED_DEFAULTS : UNENROLLED_DEFAULTS;
      const { legacy: settings, perClub } = readSettingsBundle(
        deps.db,
        user.id,
        material.id,
        fallback,
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
          status: effectiveStatus(perClub, '150'),
          cardCount: counts.Club150 ?? 0,
        },
        '300': {
          status: effectiveStatus(perClub, '300'),
          cardCount: counts.Club300 ?? 0,
        },
        full: {
          status: effectiveStatus(perClub, 'full'),
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
        perClub,
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

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof rawBody !== 'object' || rawBody === null) {
      return c.json({ error: 'body must be an object' }, 400);
    }
    const bodyObj = rawBody as Record<string, unknown>;

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
    let configJson: string;
    try {
      if (looksLikePerClub(bodyObj)) {
        // New per-club shape: validate (every field required — no
        // partial merge for the per-club path), then derive the legacy
        // YearSettings via perClubToLegacy. The legacy columns get the
        // lossy collapse; the configJson stores the verbatim per-club
        // shape that the engine reads on load (commit 8).
        const perClub = validatePerClubYearSettings({
          headingCard: bodyObj.headingCard,
          headingPassageCard: bodyObj.headingPassageCard,
          ftv: bodyObj.ftv,
          clubCardScope: bodyObj.clubCardScope,
          chapterListScope: bodyObj.chapterListScope,
          memorize: bodyObj.memorize,
          review: bodyObj.review,
          moveToNext: bodyObj.moveToNext,
          lessonBatchSize: bodyObj.lessonBatchSize,
        });
        next = perClubToLegacy(perClub);
        configJson = JSON.stringify(perClub);
      } else {
        // Legacy flat shape: existing partial-merge path. Derive the
        // per-club shape via legacyToNew so configJson stays in sync.
        const body = bodyObj as SettingsBody;
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
        configJson = JSON.stringify(legacyToNew(next));
      }
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
    const row = { ...next, configJson, updatedAt: ts };
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
