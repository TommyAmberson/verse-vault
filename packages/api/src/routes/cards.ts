import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import { graduatedVerses } from '../db/schema.js';
import { ApibibleCache, DEFAULT_NKJV_BIBLE_ID } from '../lib/apibible-cache.js';
import { EngineStore, NotEnrolledError, type TestStateEntry } from '../lib/engine.js';
import { bookCodeOf } from '../lib/book-codes.js';
import { type ComposedRender, composeRender } from '../lib/render.js';
import { type Grade, persistEngineState } from '../lib/review-log.js';
import { DEFAULT_DIALECT, type Dialect } from '../lib/spelling.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface CardsRoutesDeps {
  db: DB;
  engines: EngineStore;
  /** api.bible cache layer. Optional in test deps that don't exercise
   *  the GET /:cardId render endpoint; required for the live server. */
  apibibleCache?: ApibibleCache;
  /** Bible id to use when resolving canonical text. Defaults to NKJV
   *  (account-specific id; see DEFAULT_NKJV_BIBLE_ID). */
  bibleId?: string;
  /** Spelling dialect for the rendered verse HTML. Defaults to
   *  ``DEFAULT_DIALECT`` from ``../lib/spelling.ts`` (currently ``canadian``).
   *  Server-wide for now; per-user override comes later via a setting. */
  dialect?: Dialect;
  now?: () => number;
}

interface ReviewBody {
  materialId: string;
  cardId: number;
  grade: Grade;
}

interface TestUpdateWire {
  key: { kind: string; element: unknown };
  kind: 'Root' | 'Sub';
  before: TestStateInner;
  after: TestStateInner;
}

interface TestStateInner {
  stability: number;
  difficulty: number;
  last_seen_secs: number;
  last_base_secs: number;
  last_root_secs: number;
}

interface CardRenderWire {
  cardId: number;
  verseId: number;
  kind: string;
  position?: number;
  headingIdx?: number;
  withCitation?: boolean;
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

export function cardsRoutes(deps: CardsRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/review/next', async (c) => {
    const materialId = c.req.query('materialId');
    if (!materialId) return c.json({ error: 'materialId required' }, 400);
    const user = getUser(c);
    let loaded;
    try {
      loaded = await deps.engines.load({ userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }
    const cardId = loaded.engine.next_review_card(BigInt(now()));
    return c.json({ cardId: cardId ?? null });
  });

  app.get('/memorize/session', async (c) => {
    const materialId = c.req.query('materialId');
    if (!materialId) return c.json({ error: 'materialId required' }, 400);
    const maxRaw = Number(c.req.query('max') ?? '1');
    const max = Number.isFinite(maxRaw) ? Math.max(1, Math.min(50, Math.floor(maxRaw))) : 1;
    const user = getUser(c);
    let loaded;
    try {
      loaded = await deps.engines.load({ userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }
    const verses = JSON.parse(loaded.engine.memorize_session(max)) as {
      verseId: number;
      cardIds: number[];
    }[];
    return c.json({ verses });
  });

  app.get('/:cardId{[0-9]+}', async (c) => {
    const materialId = c.req.query('materialId');
    if (!materialId) return c.json({ error: 'materialId required' }, 400);
    const cardId = Number(c.req.param('cardId'));
    const user = getUser(c);
    let loaded;
    try {
      loaded = await deps.engines.load({ userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }
    let renderWire: CardRenderWire;
    try {
      renderWire = JSON.parse(loaded.engine.get_card_render(cardId)) as CardRenderWire;
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }

    // Cache may be omitted in tests; degrade to the bare wire so the
    // client can still render the prompt/grade UI.
    let composed: ComposedRender | null = null;
    if (deps.apibibleCache) {
      const bibleId = deps.bibleId ?? DEFAULT_NKJV_BIBLE_ID;
      try {
        const verse = renderWire.verse;
        const bookCode = bookCodeOf(verse.book);
        const passageId = `${bookCode}.${verse.chapter}`;
        const [chapterHtml, sections] = await Promise.all([
          deps.apibibleCache.getPassageHtml(bibleId, passageId),
          verse.headings.length > 0
            ? deps.apibibleCache.getSections(bibleId, bookCode)
            : Promise.resolve([]),
        ]);
        composed = composeRender(verse, chapterHtml, sections, deps.dialect ?? DEFAULT_DIALECT);
      } catch (err) {
        console.warn(`apibible cache failure for card ${cardId}: ${(err as Error).message}`);
      }
    }

    return c.json({ ...renderWire, composed });
  });

  app.post('/review', async (c) => {
    let body: ReviewBody;
    try {
      body = await c.req.json<ReviewBody>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.materialId !== 'string') {
      return c.json({ error: 'materialId required' }, 400);
    }
    if (typeof body.cardId !== 'number' || !Number.isInteger(body.cardId)) {
      return c.json({ error: 'cardId required (integer)' }, 400);
    }
    if (![1, 2, 3, 4].includes(body.grade)) {
      return c.json({ error: 'grade must be 1..=4' }, 400);
    }
    const user = getUser(c);
    const key = { userId: user.id, materialId: body.materialId };
    let loaded;
    try {
      loaded = await deps.engines.load(key);
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

    const nowSecs = now();
    return deps.engines.withLock(key, async () => {
      let updates: TestUpdateWire[];
      try {
        updates = JSON.parse(
          loaded.engine.replay_event(body.cardId, body.grade, BigInt(nowSecs)),
        ) as TestUpdateWire[];
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      const touchedKeys = new Set(
        updates.map((u) => `${u.key.kind}|${JSON.stringify(u.key.element)}`),
      );
      const allStates = JSON.parse(loaded.engine.export_test_states()) as TestStateEntry[];
      const changed = allStates.filter((s) =>
        touchedKeys.has(`${s.test_kind}|${JSON.stringify(s.element)}`),
      );

      const eventId = randomUUID();
      deps.db.transaction((tx) => {
        persistEngineState(tx, {
          userId: user.id,
          materialId: body.materialId,
          events: [
            {
              userId: user.id,
              materialId: body.materialId,
              snapshotVersion: loaded.snapshotVersion,
              timestampSecs: nowSecs,
              cardId: body.cardId,
              grade: body.grade,
              clientEventId: eventId,
            },
          ],
          testStateUpdates: changed,
        });
      });

      const nextCardId = loaded.engine.next_review_card(BigInt(nowSecs));
      return c.json({
        updates,
        nextCardId: nextCardId ?? null,
      });
    });
  });

  app.post('/memorize/graduate', async (c) => {
    let body: { materialId?: string; verseId?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.materialId !== 'string') {
      return c.json({ error: 'materialId required' }, 400);
    }
    if (typeof body.verseId !== 'number' || !Number.isInteger(body.verseId)) {
      return c.json({ error: 'verseId required (integer)' }, 400);
    }
    const user = getUser(c);
    const materialId = body.materialId;
    const verseId = body.verseId;
    const key = { userId: user.id, materialId };
    let loaded;
    try {
      loaded = await deps.engines.load(key);
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

    const nowSecs = now();
    return deps.engines.withLock(key, async () => {
      const count = loaded.engine.graduate_verse(verseId);
      if (count === 0) {
        // Two cases collapse to a zero count: (a) already-graduated
        // verses replayed by engine load — idempotent, row exists; and
        // (b) verseId doesn't belong to this material's deck at all.
        // The graduated_verses table is the source of truth that
        // distinguishes them.
        const existing = deps.db
          .select({ verseId: graduatedVerses.verseId })
          .from(graduatedVerses)
          .where(
            and(
              eq(graduatedVerses.userId, user.id),
              eq(graduatedVerses.materialId, materialId),
              eq(graduatedVerses.verseId, verseId),
            ),
          )
          .get();
        if (!existing) return c.json({ error: 'Unknown verse' }, 404);
        return c.json({ graduated: 0 });
      }
      deps.db
        .insert(graduatedVerses)
        .values({ userId: user.id, materialId, verseId, graduatedAtSecs: nowSecs })
        .onConflictDoNothing()
        .run();
      return c.json({ graduated: count });
    });
  });

  return app;
}
