import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import { EngineStore, NotEnrolledError, type TestStateEntry } from '../lib/engine.js';
import { type Grade, persistEngineState } from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface CardsRoutesDeps {
  db: DB;
  engines: EngineStore;
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

export function cardsRoutes(deps: CardsRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/next', async (c) => {
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
    const cardId = loaded.engine.next_card(BigInt(now()));
    return c.json({ cardId: cardId ?? null });
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
    let renderJson: string;
    try {
      renderJson = loaded.engine.get_card_render(cardId);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
    // Already JSON; return verbatim. Hono.json restringifies, so use text.
    return c.body(renderJson, 200, { 'content-type': 'application/json' });
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

      // Filter export to just the touched (test_kind, element) pairs to avoid
      // upserting the entire test_states table per review.
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

      const nextCardId = loaded.engine.next_card(BigInt(nowSecs));
      return c.json({
        updates,
        nextCardId: nextCardId ?? null,
      });
    });
  });

  return app;
}
