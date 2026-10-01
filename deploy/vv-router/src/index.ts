/**
 * Edge router for verse-vault at the root of www.versevault.ca.
 *
 * - /api, /api/* → Tunnel-fronted Node API on the VPS (env.API_HOST), path unchanged
 * - /vv, /vv/*   → 308 to the same path without the /vv prefix, query kept
 *
 * Everything else at the root is the CF Pages project, bound to the hostname as
 * a custom domain, so it never reaches this Worker. qzr owns /qzr/* on the same
 * host through its own Workers.
 */

interface Env {
  API_HOST: string;
}

const LEGACY_PREFIX = '/vv';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // verse-vault lived under /vv/ until it moved to the root. 308 rather than
    // 301 so a POST (an in-flight OAuth callback, a queued sync) keeps its
    // method and body.
    if (url.pathname === LEGACY_PREFIX || url.pathname.startsWith(`${LEGACY_PREFIX}/`)) {
      const target = new URL(url);
      target.pathname = url.pathname.slice(LEGACY_PREFIX.length) || '/';
      return Response.redirect(target.toString(), 308);
    }

    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      // The Worker's routes are /vv* and /api*, so anything else here is a
      // routing misconfiguration. Surface it loudly.
      return new Response('vv-router: path outside its routes', { status: 500 });
    }

    const target = new URL(url);
    target.hostname = env.API_HOST;

    // redirect: manual preserves Better Auth's OAuth bounce (Set-Cookie
    // + Location both flow through to the browser). Body omitted on
    // bodiless verbs because some runtimes throw if body is set on GET/HEAD.
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    return fetch(target, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    });
  },
};
