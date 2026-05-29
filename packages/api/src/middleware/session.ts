import type { Context, MiddlewareHandler } from 'hono';

import type { Auth } from '../lib/auth.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface SessionVariables {
  user: SessionUser | null;
}

/** Superset of `SessionVariables` used by `app.ts` itself — the
 *  observability middleware adds `requestId` for cross-handler
 *  correlation. Route files keep using `SessionVariables` so the
 *  observability addition stays a non-breaking type change. */
export interface AppVariables extends SessionVariables {
  requestId: string;
}

/** Generic over any Variables shape that contains `user`. Lets `app.ts`
 *  use the wider `AppVariables` (adds `requestId`) without losing
 *  assignability when passing the Context through. */
export function sessionMiddleware<
  E extends { Variables: SessionVariables },
>(auth: Auth): MiddlewareHandler<E> {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) {
      c.set('user', {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
      });
    } else {
      c.set('user', null);
    }
    await next();
  };
}

export function requireAuth<
  E extends { Variables: SessionVariables },
>(): MiddlewareHandler<E> {
  return async (c, next) => {
    if (!c.get('user')) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    await next();
  };
}

/** Use after requireAuth — non-null by contract. */
export function getUser<E extends { Variables: SessionVariables }>(c: Context<E>): SessionUser {
  return c.get('user')!;
}
