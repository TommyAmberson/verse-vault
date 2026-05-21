import { createAppAuthClient } from '@/lib/authClient'

// Better Auth's client appends `/api/auth` to baseURL — but only when
// baseURL has no path component (see `withPath` in better-auth/utils/url).
// Once there's a path (`/vv` in prod), nothing is appended and route calls
// land at `/vv/sign-up/email` instead of `/vv/api/auth/sign-up/email`.
// So we hand it the full auth route prefix explicitly and resolve to an
// absolute URL (Better Auth validates via `new URL(...)`, which rejects
// relative paths). VITE_API_URL is the legacy flat-URL form, kept as a
// fallback.
const apiBase =
  import.meta.env.VITE_API_BASE ??
  import.meta.env.VITE_API_URL ??
  'http://localhost:3000'
const withAuth = apiBase.endsWith('/api') ? `${apiBase}/auth` : `${apiBase}/api/auth`
const authBaseURL = withAuth.startsWith('/')
  ? window.location.origin + withAuth
  : withAuth

export const { authClient, useAuth } = createAppAuthClient(authBaseURL)
