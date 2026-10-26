import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { DB } from '../db/client.js';
import { type Auth, PENDING_GOOGLE_PREFIX, type PendingGoogle } from '../lib/auth.js';
import { EngineStore } from '../lib/engine.js';
import type { AccountExport } from '../lib/export-format.js';
import { buildAccountExport } from '../lib/export.js';
import {
  ImportValidationError,
  applyAccountImport,
} from '../lib/import.js';
import { deleteAccountProgress } from '../lib/reset.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface AccountRoutesDeps {
  db: DB;
  auth: Auth;
  engines: EngineStore;
  now?: () => number;
}

/** Cap on POST /api/import payload size. 52k revlog rows from the
 *  test colpkg is ~10 MB of JSON; 50 MB leaves room for full deck
 *  coverage at ~5x headroom. Beyond that, the user should split the
 *  export anyway. */
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

export function accountRoutes(deps: AccountRoutesDeps) {
  const app = new Hono<{ Variables: SessionVariables }>();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  // Every bad token gets the same answer, so it reveals nothing about the
  // account it might have named (FR-021).
  const invalidToken = (c: Context) => c.json({ error: 'invalid or expired token' }, 400);

  const adapter = async () => (await deps.auth.$context).internalAdapter;

  // Consumes a pending Google row once, as the choice screen's proof that a
  // Google sign-in for that address just completed.
  async function consumePending(c: Context): Promise<PendingGoogle | null> {
    const body = await c.req.json<{ token?: unknown }>().catch(() => null);
    if (typeof body?.token !== 'string') return null;
    const row = await (await adapter()).consumeVerificationValue(
      `${PENDING_GOOGLE_PREFIX}${body.token}`,
    );
    return row ? (JSON.parse(row.value) as PendingGoogle) : null;
  }

  // Links the pending Google identity and verifies the address. Null,
  // changing nothing, when that Google account already belongs to someone
  // else; otherwise a function that does the linking, so the takeover can
  // check before it removes anything.
  async function googleLinker(pending: PendingGoogle) {
    const internal = await adapter();
    const existing = await internal.findAccountByProviderId(pending.sub, 'google');
    if (existing && existing.userId !== pending.userId) return null;
    return async () => {
      if (!existing) {
        await internal.linkAccount({
          providerId: 'google',
          accountId: pending.sub,
          userId: pending.userId,
        });
      }
      await internal.updateUser(pending.userId, { emailVerified: true });
    };
  }

  // "That's not me" is how a signed-out learner gets in, so it sits ahead of
  // the session check below.
  app.post('/account/google/takeover', async (c) => {
    const pending = await consumePending(c);
    if (!pending) return invalidToken(c);
    const internal = await adapter();
    const target = await internal.findUserById(pending.userId);
    if (!target || target.emailVerified) return invalidToken(c);
    const link = await googleLinker(pending);
    if (!link) return invalidToken(c);
    // Whoever set the password loses it and every session, as Better Auth's
    // `revokeUnprovenAccountAccess` does for an unverified account.
    for (const account of await internal.findAccounts(pending.userId)) {
      if (account.providerId === 'credential') await internal.deleteAccount(account.id);
    }
    await internal.deleteUserSessions(pending.userId);
    await link();
    return c.json({ ok: true });
  });

  app.use('*', requireAuth());

  // "That's me": the learner has just signed in with the account's password.
  app.post('/account/google/claim', async (c) => {
    const pending = await consumePending(c);
    if (!pending) return invalidToken(c);
    if (pending.userId !== getUser(c).id) {
      return c.json({ error: 'signed in to a different account' }, 403);
    }
    const link = await googleLinker(pending);
    if (!link) return invalidToken(c);
    await link();
    return c.json({ ok: true });
  });

  app.get('/export', async (c) => {
    const user = getUser(c);
    const payload = await buildAccountExport(deps.db, deps.engines, user.id, now());
    const dateStr = new Date(now() * 1000).toISOString().slice(0, 10);
    c.header('Content-Disposition', `attachment; filename="verse-vault-export-${dateStr}.json"`);
    return c.json(payload);
  });

  app.post(
    '/import',
    bodyLimit({
      maxSize: IMPORT_MAX_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    async (c) => {
      const user = getUser(c);
      let payload: AccountExport;
      try {
        payload = await c.req.json<AccountExport>();
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      try {
        const summary = await applyAccountImport(deps.db, deps.engines, user.id, payload, now());
        return c.json(summary);
      } catch (err) {
        if (err instanceof ImportValidationError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    },
  );

  app.delete('/account/progress', async (c) => {
    const user = getUser(c);
    const summary = await deleteAccountProgress(deps.db, deps.engines, user.id);
    return c.json(summary);
  });

  return app;
}
