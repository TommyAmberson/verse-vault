import { type Context, Hono } from 'hono';

import type { DB } from '../db/client.js';
import { EngineStore } from '../lib/engine.js';
import { type Grade, type ReviewOutcome, recordReview } from '../lib/review-log.js';
import { SessionStore, type SessionCard, type SessionEntry } from '../lib/sessions.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface SessionRoutesDeps {
  db: DB;
  engines: EngineStore;
  sessions: SessionStore;
  now?: () => number;
}

interface NewVerseInfo {
  verse_ref: number;
  verse_phrases: number[];
}

interface StartBody {
  materialId: string;
  newVerses?: NewVerseInfo[];
}

interface ReviewBody {
  grades: Grade[];
}

export function sessionRoutes(deps: SessionRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.post('/start', async (c) => {
    let body: StartBody;
    try {
      body = await c.req.json<StartBody>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.materialId !== 'string') {
      return c.json({ error: 'materialId required' }, 400);
    }
    const user = getUser(c);
    const loaded = await deps.engines.load({ userId: user.id, materialId: body.materialId });
    const nowSecs = now();
    try {
      loaded.engine.start_session(
        BigInt(nowSecs),
        JSON.stringify(body.newVerses ?? []),
        '',
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const entry = deps.sessions.create({
      userId: user.id,
      materialId: body.materialId,
      snapshotVersion: loaded.snapshotVersion,
      engine: loaded.engine,
      nowSecs,
    });
    return c.json(advance(entry));
  });

  app.get('/:id/next', (c) => {
    const entry = authorizedSession(c, deps.sessions);
    if (!entry) return c.json({ error: 'Session not found' }, 404);
    return c.json(advance(entry));
  });

  app.post('/:id/review', async (c) => {
    const entry = authorizedSession(c, deps.sessions);
    if (!entry) return c.json({ error: 'Session not found' }, 404);
    const card = entry.currentCard;
    if (!card) return c.json({ error: 'No card awaiting review' }, 409);
    let body: ReviewBody;
    try {
      body = await c.req.json<ReviewBody>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!Array.isArray(body.grades)) {
      return c.json({ error: 'grades required' }, 400);
    }
    const nowSecs = now();
    let outcome: ReviewOutcome;
    try {
      outcome = JSON.parse(
        entry.engine.session_review(JSON.stringify(body.grades), BigInt(nowSecs)),
      ) as ReviewOutcome;
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    // Progressive-reveal "reading" cards don't run credit assignment inside
    // the session, so they leave the engine unchanged. Skipping the event
    // log here keeps the online path and the sync replay path symmetric —
    // replaying these would wrongly trigger the exposure fallback.
    if (!card.is_reading) {
      recordReview({ db: deps.db, entry, timestampSecs: nowSecs, card, grades: body.grades, outcome });
    }
    entry.currentCard = null;
    const next = advance(entry);
    if (next.done) deps.sessions.end(entry.id);
    return c.json({ outcome, ...next });
  });

  app.post('/:id/abort', (c) => {
    const entry = authorizedSession(c, deps.sessions);
    if (!entry) return c.json({ error: 'Session not found' }, 404);
    entry.engine.session_abort();
    deps.sessions.end(entry.id);
    return c.json({ ok: true });
  });

  return app;
}

function advance(entry: SessionEntry): { sessionId: string; card: SessionCard | null; done: boolean } {
  const raw = entry.engine.session_next();
  if (raw === undefined) {
    entry.currentCard = null;
    return { sessionId: entry.id, card: null, done: true };
  }
  const card = JSON.parse(raw) as SessionCard;
  entry.currentCard = card;
  return { sessionId: entry.id, card, done: false };
}

function authorizedSession(
  c: Context<{ Variables: SessionVariables }>,
  sessions: SessionStore,
): SessionEntry | null {
  const entry = sessions.get(c.req.param('id')!);
  if (!entry) return null;
  const user = getUser(c);
  if (entry.userId !== user.id) return null;
  return entry;
}

