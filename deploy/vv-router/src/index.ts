/**
 * Edge router for verse-vault's temporary /vv/* mount on versevault.ca.
 *
 * - /vv/api/* → Tunnel-fronted Node API on the VPS (env.API_HOST)
 * - /vv/*     → CF Pages project hosting the SPA bundle (env.PAGES_HOST)
 *
 * The /vv prefix is stripped before forwarding so the origin services
 * don't need to know they're hosted under a subpath. When qzr-sheet moves
 * off this domain, this Worker is deleted and the Pages project + Tunnel
 * are wired to subdomains directly.
 */

interface Env {
  PAGES_HOST: string;
  API_HOST: string;
}

const PREFIX = '/vv';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith(PREFIX)) {
      // Worker route is /vv/*, so anything that lands here without the
      // prefix is a routing misconfiguration. Surface it loudly.
      return new Response('vv-router: path outside /vv prefix', { status: 500 });
    }

    const rest = url.pathname.slice(PREFIX.length) || '/';
    const target = new URL(url);
    target.pathname = rest;
    target.hostname = rest === '/api' || rest.startsWith('/api/')
      ? env.API_HOST
      : env.PAGES_HOST;

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
