import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Better Auth tables — shape follows the Better Auth drizzle adapter's
// expected schema. We own them here (rather than letting @better-auth/cli
// generate a separate file) so Drizzle sees everything in one place for FK
// typing. Regenerate via `pnpm dlx @better-auth/cli generate` if the upstream
// shape changes.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // Better Auth looks up accounts by (provider_id, account_id) on every
  // OAuth callback to resolve an existing linked identity.
  (t) => ({
    providerIdx: index('idx_account_provider').on(t.providerId, t.accountId),
  }),
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  // Better Auth queries verification rows by identifier (email) during
  // email verification and password reset flows.
  (t) => ({
    identifierIdx: index('idx_verification_identifier').on(t.identifier),
  }),
);

// Which materials (e.g. a Bible book) a user has enrolled in.
export const userMaterials = sqliteTable(
  'user_materials',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    clubTier: integer('club_tier'), // 150 | 300 | null (full)
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.materialId] }) }),
);

// Per-year material picker toggles. One row per (user, material). Four
// "tier scope" columns plus two booleans plus the lesson batch size
// drive the engine's `MaterialConfig` at construction time:
//
// - active_scope: which tiers introduce new verses (and review them).
// - maintenance_scope: which tiers (additionally) review only.
// - club_card_scope: which tiers get the per-verse "Which club?" card.
// - chapter_list_scope: which tiers get the chapter-list card.
//
// Each scope is one of "off" | "up150" | "up300" | "all"
// (chapter_list_scope omits "all" — Full never emits a chapter-list).
//
// Per-tier effective status is derived: a tier covered by active_scope
// is Active; covered only by maintenance_scope is Maintenance; covered
// by neither is Paused.
export const userYearSettings = sqliteTable(
  'user_year_settings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    headings: integer('headings', { mode: 'boolean' }).notNull(),
    ftv: integer('ftv', { mode: 'boolean' }).notNull(),
    newScope: text('new_scope').notNull(),
    reviewScope: text('review_scope').notNull(),
    clubCardScope: text('club_card_scope').notNull(),
    chapterListScope: text('chapter_list_scope').notNull(),
    lessonBatchSize: integer('lesson_batch_size').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.materialId] }) }),
);

// The bundled MaterialData blob the engine builds from. Rebuilt when content
// changes; versioned so existing events can be replayed against a known
// snapshot.
export const graphSnapshots = sqliteTable(
  'graph_snapshots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    version: integer('version').notNull(),
    materialData: blob('material_data', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    userMaterialIdx: index('idx_graph_snapshots_user_material').on(t.userId, t.materialId),
    // Two concurrent EngineStore.load callers on a stale snapshot would
    // otherwise both insert version=N+1, leaving the desc-version pick
    // non-deterministic.
    versionUnique: uniqueIndex('uniq_graph_snapshots_user_material_version').on(
      t.userId,
      t.materialId,
      t.version,
    ),
  }),
);

// Append-only review log. Source of truth — test_states are derived by
// replaying these.
export const reviewEvents = sqliteTable(
  'review_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    snapshotVersion: integer('snapshot_version').notNull(),
    timestampSecs: integer('timestamp_secs').notNull(),
    cardId: integer('card_id').notNull(),
    grade: integer('grade').notNull(), // 1=Again, 2=Hard, 3=Good, 4=Easy
    // Client-supplied ID that makes uploads idempotent across retries. For
    // online reviews the server generates a UUID; for offline reviews the
    // client sends its own UUID.
    clientEventId: text('client_event_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    // Replay is always filtered by (user_id, material_id) and sorted by
    // timestamp, so keep timestamp as the trailing key.
    replayIdx: index('idx_review_events_user_material_time').on(
      t.userId,
      t.materialId,
      t.timestampSecs,
    ),
    // Dedup on re-upload: a client may retry the same batch; accept the
    // second POST without double-applying events.
    clientEventIdx: uniqueIndex('uniq_review_events_user_material_client_event').on(
      t.userId,
      t.materialId,
      t.clientEventId,
    ),
  }),
);

// Materialized per-test FSRS state (recomputable by replaying review_events).
// `element` is the serde-tagged JSON form of `core::ElementId`; opaque to
// the API — passed through verbatim from `WasmEngine.export_test_states()`.
export const testStates = sqliteTable(
  'test_states',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    testKind: text('test_kind').notNull(),
    element: text('element').notNull(),
    stability: real('stability').notNull(),
    difficulty: real('difficulty').notNull(),
    lastSeenSecs: integer('last_seen_secs').notNull(),
    lastBaseSecs: integer('last_base_secs').notNull(),
    lastRootSecs: integer('last_root_secs').notNull(),
    // Set by the engine when the card was last graded Again and the learner
    // hasn't passed it since; cleared on any non-Again grade. The session's
    // relearning lane re-surfaces these cards once their FSRS sub-day due
    // time has elapsed, bypassing the sibling cooldown.
    pendingRelearn: integer('pending_relearn').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.materialId, t.testKind, t.element] }),
  }),
);

// Per-user verse-graduation log. Drives the engine's `CardState::Active`
// flip after a user walks the memorize progression for a verse. Cards
// rebuilt from MaterialData start as `New`; on engine load we apply
// `graduate_verse(verseId)` for every row in this table.
export const graduatedVerses = sqliteTable(
  'graduated_verses',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    verseId: integer('verse_id').notNull(),
    graduatedAtSecs: integer('graduated_at_secs').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.materialId, t.verseId] }),
  }),
);

// Cached api.bible content. Per the API.Bible Acceptable Use clause
// (https://api.bible/terms-and-conditions#acceptable_use), cached entries
// must be refreshed within 30 days of fetch, may not be used to train
// AI/LLMs, may not be converted to derivative formats (e.g. text→audio),
// and may not be systematically extracted into separate databases.
// `ApibibleCache` enforces the TTL via TTL-on-read and prune-on-load; the
// other clauses are honoured at the routes layer (one-card-at-a-time on
// /api/cards/:id; opt-in bulk download via /api/materials/:id/renders gated
// on an explicit user toggle).
//
// `apibible_passages` holds chapter HTML (one row per (bibleId, "{USX}.{ch}")).
// `apibible_sections` holds the per-book section list as a JSON string (one
// row per (bibleId, USX bookCode)).
export const apibiblePassages = sqliteTable(
  'apibible_passages',
  {
    bibleId: text('bible_id').notNull(),
    passageId: text('passage_id').notNull(),
    contentHtml: text('content_html').notNull(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.bibleId, t.passageId] }),
    fetchedAtIdx: index('idx_apibible_passages_fetched_at').on(t.fetchedAt),
  }),
);

export const apibibleSections = sqliteTable(
  'apibible_sections',
  {
    bibleId: text('bible_id').notNull(),
    bookCode: text('book_code').notNull(),
    sectionsJson: text('sections_json').notNull(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.bibleId, t.bookCode] }),
    fetchedAtIdx: index('idx_apibible_sections_fetched_at').on(t.fetchedAt),
  }),
);
