import { APIError } from 'better-auth/api';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { DB } from '../db/client.js';
import {
  type Auth,
  PENDING_GOOGLE_COOKIE,
  PENDING_GOOGLE_PREFIX,
  PENDING_GOOGLE_TTL_MS,
  type PendingGoogle,
  verificationCodeIdentifier,
} from '../lib/auth.js';
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

  // The pending row's token travels in a cookie set when Google sign-in
  // came back, never in a page address, so only that browser can act on it.
  async function pendingCookie() {
    const cookie = (await deps.auth.$context).createAuthCookie(PENDING_GOOGLE_COOKIE, {
      maxAge: PENDING_GOOGLE_TTL_MS / 1000,
      path: deps.auth.pendingCookiePath,
    });
    return { name: cookie.name, options: cookie.attributes as Parameters<typeof setCookie>[3] };
  }

  // The pending Google row this browser's cookie names, if it is still live.
  // The browser holds one such cookie, but each tab remembers its own step,
  // so a request naming the address its tab is on must match the row: a
  // Google sign-in in another tab can't re-point this one.
  async function readPending(c: Context) {
    const token = getCookie(c, (await pendingCookie()).name);
    if (!token) return null;
    const identifier = `${PENDING_GOOGLE_PREFIX}${token}`;
    const row = await (await adapter()).findVerificationValue(identifier);
    if (!row || row.expiresAt < new Date()) return null;
    const pending = JSON.parse(row.value) as PendingGoogle;
    const body = await c.req.json<{ email?: unknown }>().catch(() => null);
    const expected = typeof body?.email === 'string' ? body.email.toLowerCase() : null;
    if (expected && expected !== pending.email.toLowerCase()) return null;
    return { token, identifier, pending };
  }

  // A proven pending Google row, the choice screen's proof that a Google
  // sign-in for that address just completed and the inbox is the learner's.
  // An unproven row is for the code step. Nothing marks a row unproven again.
  async function readProven(c: Context) {
    const found = await readPending(c);
    return found?.pending.proven ? found : null;
  }

  // Uses a row up, once every check has passed, so a refusal leaves it for a
  // retry, and drops the cookie. False when another request used it first.
  async function consume(c: Context, identifier: string): Promise<boolean> {
    const used = (await (await adapter()).consumeVerificationValue(identifier)) !== null;
    if (used) {
      const { name, options } = await pendingCookie();
      deleteCookie(c, name, options);
    }
    return used;
  }

  // The confirm route checks one code at a time per address, so each guess
  // sees the attempt count the one before it wrote: the plugin's check
  // reads, compares, and writes the count as separate steps (research
  // D16). A lock in this process suffices, as the API runs as one process.
  const codeLocks = new Map<string, Promise<unknown>>();
  async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (codeLocks.get(key) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => {});
    codeLocks.set(key, settled);
    try {
      return await run;
    } finally {
      if (codeLocks.get(key) === settled) codeLocks.delete(key);
    }
  }

  // Links the pending Google identity and verifies the address. Null,
  // changing nothing, when that Google account already belongs to someone
  // else; otherwise a function that does the linking, so a route can check
  // before it uses anything up. The linking resolves false when a link for
  // the same Google account won a race in between: the unique index on
  // account refuses the second.
  async function googleLinker(pending: PendingGoogle) {
    const internal = await adapter();
    const existing = await internal.findAccountByProviderId(pending.sub, 'google');
    if (existing && existing.userId !== pending.userId) return null;
    return async (): Promise<boolean> => {
      if (!existing) {
        const linked = await internal
          .linkAccount({ providerId: 'google', accountId: pending.sub, userId: pending.userId })
          .then(() => true, () => false);
        if (!linked) return false;
      }
      await internal.updateUser(pending.userId, { emailVerified: true });
      return true;
    };
  }

  // The Google code step: the emailed code proves the inbox for a pending
  // row Google couldn't prove. Signed out, like takeover, so it sits ahead
  // of the session check below.
  app.post('/account/google/confirm', async (c) => {
    const body = await c.req.json<{ code?: unknown }>().catch(() => null);
    const found = await readPending(c);
    const code = body?.code;
    if (!found || found.pending.proven || typeof code !== 'string') return invalidToken(c);
    const { identifier, pending } = found;
    const internal = await adapter();
    const user = await internal.findUserById(pending.userId);
    if (!user) return invalidToken(c);
    // Checked before the code is used, so a Google account that belongs to
    // someone else leaves the code and the row as they were.
    const link = await googleLinker(pending);
    if (!link) return invalidToken(c);

    const refused = await oneAtATime(pending.email.toLowerCase(), async () => {
      try {
        // A server call: the HTTP route is refused (research D15).
        await deps.auth.api.checkVerificationOTP({
          body: { email: pending.email, type: 'email-verification', otp: code },
        });
      } catch (err) {
        if (err instanceof APIError) return err;
        throw err;
      }
      // The check doesn't use the code up; delete it so it works once.
      await internal.deleteVerificationByIdentifier(verificationCodeIdentifier(pending.email));
      return null;
    });
    if (refused) {
      return c.json(
        { error: refused.body?.message ?? 'invalid code', code: refused.body?.code },
        refused.statusCode === 403 ? 403 : 400,
      );
    }

    if (!user.emailVerified) {
      // The choice gets its own 10 minutes, whatever the code step took.
      await internal.updateVerificationByIdentifier(identifier, {
        value: JSON.stringify({ ...pending, proven: true } satisfies PendingGoogle),
        expiresAt: new Date(Date.now() + PENDING_GOOGLE_TTL_MS),
      });
      const { name, options } = await pendingCookie();
      setCookie(c, name, found.token, options);
      return c.json({ choice: true });
    }
    // A verified account: link, then use the row up, so a link that loses a
    // race leaves the row for another try. The client signs in with Google
    // again.
    if (!(await link())) return invalidToken(c);
    await consume(c, identifier);
    return c.json({ signIn: true });
  });

  // "Send a new code" on the Google code step: the code-step email again,
  // which says what the code is for, under the same limits.
  app.post('/account/google/resend', async (c) => {
    const found = await readPending(c);
    if (!found || found.pending.proven) return invalidToken(c);
    const sent = await deps.auth.sendGoogleCode(found.pending.email, c.req.raw, {
      keepLive: false,
    });
    if (sent === 'limited') {
      return c.json({ error: 'Too many requests for this address. Try again later.' }, 429);
    }
    return c.json({ sent: true });
  });

  // "That's not me" is how a signed-out learner gets in, so it sits ahead of
  // the session check below.
  app.post('/account/google/takeover', async (c) => {
    const found = await readProven(c);
    if (!found) return invalidToken(c);
    const { pending } = found;
    const internal = await adapter();
    const target = await internal.findUserById(pending.userId);
    if (!target || target.emailVerified) return invalidToken(c);
    const link = await googleLinker(pending);
    if (!link || !(await consume(c, found.identifier))) return invalidToken(c);
    // Linked first, so a link refused because another request took the
    // same Google account in between leaves the password and sessions.
    if (!(await link())) return invalidToken(c);
    // Whoever set the password loses it and every session, as Better Auth's
    // `revokeUnprovenAccountAccess` does for an unverified account.
    for (const account of await internal.findAccounts(pending.userId)) {
      if (account.providerId === 'credential') await internal.deleteAccount(account.id);
    }
    await internal.deleteUserSessions(pending.userId);
    return c.json({ ok: true });
  });

  app.use('*', requireAuth());

  // "That's me": the learner has just signed in with the account's password.
  app.post('/account/google/claim', async (c) => {
    const found = await readProven(c);
    if (!found) return invalidToken(c);
    if (found.pending.userId !== getUser(c).id) {
      return c.json({ error: 'signed in to a different account' }, 403);
    }
    const link = await googleLinker(found.pending);
    if (!link || !(await consume(c, found.identifier))) return invalidToken(c);
    if (!(await link())) return invalidToken(c);
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
