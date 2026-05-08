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

export function sessionMiddleware(auth: Auth): MiddlewareHandler<{ Variables: SessionVariables }> {
  return async (c, next) => {
    // Dev-mode bypass: when VV_DEV_USER_ID is set and the client opts in via
    // header, skip Better Auth and use the configured dev user. Lets the
    // Vue thin client run without wiring up OAuth in development. Two
    // safeguards make this safe: env var must be set (production won't),
    // and the client has to explicitly send the header.
    const devUserId = process.env.VV_DEV_USER_ID;
    if (devUserId && c.req.header('x-vv-dev-user') === '1') {
      c.set('user', { id: devUserId, email: 'dev@local', name: 'dev' });
      await next();
      return;
    }
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

export function requireAuth(): MiddlewareHandler<{ Variables: SessionVariables }> {
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
