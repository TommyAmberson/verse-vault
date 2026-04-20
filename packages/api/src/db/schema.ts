import { blob, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Better Auth inserts its own tables (user, session, account, verification)
// via its own migrations. Those are declared here for type-safety in queries
// but the authoritative schema definition lives in @better-auth/cli output.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ----- Verse-vault domain -----

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
export const graphSnapshots = sqliteTable('graph_snapshots', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  materialId: text('material_id').notNull(),
  version: integer('version').notNull(),
  graphData: blob('graph_data', { mode: 'buffer' }).notNull(),
  cardsData: blob('cards_data', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

// Append-only review log. Source of truth — edge/card states are derived.
export const reviewEvents = sqliteTable('review_events', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  materialId: text('material_id').notNull(),
  snapshotVersion: integer('snapshot_version').notNull(),
  timestampSecs: integer('timestamp_secs').notNull(),
  cardId: integer('card_id'), // null for transient (re-drill / progressive reveal)
  shown: blob('shown', { mode: 'buffer' }).notNull(),
  hidden: blob('hidden', { mode: 'buffer' }).notNull(),
  grades: blob('grades', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

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
