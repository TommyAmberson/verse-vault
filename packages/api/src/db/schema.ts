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

// The graph + card catalog built from content. Rebuilt when content changes;
// versioned so existing events can be replayed against a known snapshot.
export const graphSnapshots = sqliteTable(
  'graph_snapshots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    version: integer('version').notNull(),
    graphData: blob('graph_data', { mode: 'buffer' }).notNull(),
    cardsData: blob('cards_data', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    userMaterialIdx: index('idx_graph_snapshots_user_material').on(t.userId, t.materialId),
  }),
);

// Append-only review log. Source of truth — edge/card states are derived.
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
    cardId: integer('card_id'), // null for transient (re-drill / progressive reveal)
    // Client-supplied ID that makes uploads idempotent across retries. For
    // online reviews the server generates a UUID; for offline reviews the
    // client sends its own UUID.
    clientEventId: text('client_event_id').notNull(),
    shown: blob('shown', { mode: 'buffer' }).notNull(),
    hidden: blob('hidden', { mode: 'buffer' }).notNull(),
    grades: blob('grades', { mode: 'buffer' }).notNull(),
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

// Materialized edge state (recomputable by replaying review_events).
export const edgeStates = sqliteTable(
  'edge_states',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    edgeId: integer('edge_id').notNull(),
    stability: real('stability').notNull(),
    difficulty: real('difficulty').notNull(),
    lastReviewSecs: integer('last_review_secs').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.materialId, t.edgeId] }) }),
);

// Materialized card state + schedule (recomputable).
export const cardStates = sqliteTable(
  'card_states',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    materialId: text('material_id').notNull(),
    cardId: integer('card_id').notNull(),
    state: text('state', { enum: ['new', 'learning', 'review', 'relearning'] }).notNull(),
    dueR: real('due_r'),
    dueDateSecs: integer('due_date_secs'),
    priority: real('priority'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.materialId, t.cardId] }) }),
);
