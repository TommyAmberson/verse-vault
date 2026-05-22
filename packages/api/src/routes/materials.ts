import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { ApibibleCache } from '../lib/apibible-cache.js';
import { bookCodeOf } from '../lib/book-codes.js';
import { EngineStore, NotEnrolledError } from '../lib/engine.js';
import {
  AlreadyEnrolledError,
  UnknownMaterialError,
  enrollUser,
  requireEnrollment,
} from '../lib/enrollment.js';
import { MATERIALS } from '../lib/materials.js';
import { type ComposedRender, composeRender } from '../lib/render.js';
import { DEFAULT_DIALECT, type Dialect } from '../lib/spelling.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface MaterialsRoutesDeps {
  db: DB;
  engines: EngineStore;
  /** api.bible cache layer. Optional in test deps that don't exercise
   *  the bulk renders endpoint; required for the live server. */
  apibibleCache?: ApibibleCache;
  bibleId?: string;
  dialect?: Dialect;
  now?: () => number;
}

/** Same id as cards.ts uses for the NKJV bible on api.bible. Duplicated
 *  here (rather than imported) to avoid pulling the cards module into
 *  the materials path; the value is environmental, not behavioural. */
const DEFAULT_NKJV_BIBLE_ID = '63097d2a0a2f7db3-01';

interface CardRenderWire {
  cardId: number;
  verseId: number;
  kind: string;
  verse: {
    book: string;
    chapter: number;
    verse: number;
    phraseWordCounts: number[];
    annotations: { wordIndex: number; kind: 'bold' | 'italic' | 'boldItalic' }[];
    ftvWordCount: number | null;
    headings: {
      headingIdx: number;
      startChapter: number;
      startVerse: number;
      endChapter: number;
      endVerse: number;
    }[];
    clubs: ('Club150' | 'Club300')[];
  };
}

interface EnrollBody {
  materialId: string;
  clubTier?: number | null;
}

export function materialsRoutes(deps: MaterialsRoutesDeps) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/', (c) => {
    return c.json({ materials: MATERIALS });
  });

  app.post('/enroll', async (c) => {
    const user = getUser(c);
    let body: EnrollBody;
    try {
      body = await c.req.json<EnrollBody>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.materialId !== 'string') {
      return c.json({ error: 'materialId required' }, 400);
    }
    if (body.clubTier != null && typeof body.clubTier !== 'number') {
      return c.json({ error: 'clubTier must be a number or null' }, 400);
    }

    try {
      const result = enrollUser({
        db: deps.db,
        userId: user.id,
        materialId: body.materialId,
        clubTier: body.clubTier ?? null,
        now: deps.now,
      });
      return c.json({ materialId: body.materialId, snapshotId: result.snapshotId, version: result.version });
    } catch (err) {
      if (err instanceof UnknownMaterialError) return c.json({ error: err.message }, 404);
      if (err instanceof AlreadyEnrolledError) return c.json({ error: 'Already enrolled' }, 409);
      throw err;
    }
  });

  app.get('/:id/status', (c) => {
    const user = getUser(c);
    const materialId = c.req.param('id');
    let enrolled;
    try {
      enrolled = requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

    const testCountRow = deps.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.testStates)
      .where(
        and(
          eq(schema.testStates.userId, user.id),
          eq(schema.testStates.materialId, materialId),
        ),
      )
      .get();

    return c.json({
      materialId,
      clubTier: enrolled.clubTier,
      offlineMode: enrolled.offlineMode,
      testCount: testCountRow?.count ?? 0,
    });
  });

  app.get('/:id/renders', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('id');
    let enrolled;
    try {
      enrolled = requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }
    if (!enrolled.offlineMode) {
      // Gate per the MAUA bulk-extraction clause: callers must
      // explicitly opt in via PATCH /offline-mode before the server
      // ships pre-composed text for the whole deck. The 403 is the
      // only place this clause has wire-format teeth — keep it.
      return c.json({ error: 'offlineMode not enabled for this material' }, 403);
    }

    let loaded;
    try {
      loaded = await deps.engines.load({ userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }
    const wires = JSON.parse(loaded.engine.all_card_renders()) as CardRenderWire[];

    // No cache → degrade to the bare wire entries so test deps that
    // skip apibible still get a working response. The live server
    // always has the cache.
    if (!deps.apibibleCache) {
      return c.json({ renders: wires.map((w) => ({ cardId: w.cardId, composed: null, fetchedAt: 0 })) });
    }

    const bibleId = deps.bibleId ?? DEFAULT_NKJV_BIBLE_ID;
    const dialect = deps.dialect ?? DEFAULT_DIALECT;
    const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();

    // Group cards by (book, chapter) so we hit the apibible cache once
    // per chapter instead of once per card. ApibibleCache memoises a
    // single get per process, so cards in the same chapter would
    // coalesce anyway, but the explicit grouping makes the cost model
    // obvious and lets us pull the per-book sections list once.
    const cardsByChapter = new Map<string, CardRenderWire[]>();
    for (const w of wires) {
      const key = `${w.verse.book}|${w.verse.chapter}`;
      const list = cardsByChapter.get(key) ?? [];
      list.push(w);
      cardsByChapter.set(key, list);
    }

    const renders: Array<{ cardId: number; composed: ComposedRender | null; fetchedAt: number }> = [];
    for (const [, cards] of cardsByChapter) {
      const first = cards[0]!;
      const bookCode = bookCodeOf(first.verse.book);
      const passageId = `${bookCode}.${first.verse.chapter}`;
      let chapterHtml: string;
      try {
        chapterHtml = await deps.apibibleCache.getPassageHtml(bibleId, passageId);
      } catch (err) {
        // One chapter failing isn't a fatal error for the bulk path —
        // skip its cards (the client will fall back to the single-card
        // path for any cardIds that come back missing) and keep going.
        console.warn(`apibible cache failure for ${passageId}: ${(err as Error).message}`);
        for (const card of cards) renders.push({ cardId: card.cardId, composed: null, fetchedAt: 0 });
        continue;
      }
      const needsSections = cards.some((c) => c.verse.headings.length > 0);
      const sections = needsSections
        ? await deps.apibibleCache.getSections(bibleId, bookCode).catch(() => [])
        : [];
      for (const card of cards) {
        const composed = composeRender(card.verse, chapterHtml, sections, dialect);
        renders.push({ cardId: card.cardId, composed, fetchedAt: now });
      }
    }
    renders.sort((a, b) => a.cardId - b.cardId);
    return c.json({ renders });
  });

  app.patch('/:id/offline-mode', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('id');
    try {
      requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

    let body: { offlineMode?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.offlineMode !== 'boolean') {
      return c.json({ error: 'offlineMode must be a boolean' }, 400);
    }

    deps.db
      .update(schema.userMaterials)
      .set({ offlineMode: body.offlineMode })
      .where(
        and(
          eq(schema.userMaterials.userId, user.id),
          eq(schema.userMaterials.materialId, materialId),
        ),
      )
      .run();

    return c.json({ materialId, offlineMode: body.offlineMode });
  });

  return app;
}
