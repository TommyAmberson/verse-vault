import { createAppAuthClient } from '@/lib/authClient'

// Better Auth's client auto-appends `/api/auth` to baseURL only when the
// URL has no path component (see `withPath` / `checkHasPath` in
// better-auth/utils/url). In our subpath deployment VITE_API_BASE is `/vv`,
// which already has a path, so the auto-append is skipped — we add the
// `/api/auth` suffix ourselves. Better Auth also validates baseURL via
// `new URL(...)`, which rejects relative inputs, so we absolutize against
// `window.location.origin` when VITE_API_BASE is origin-relative.
// VITE_API_URL is the legacy absolute-origin form, kept as a fallback.
const apiBase =
  import.meta.env.VITE_API_BASE ??
  import.meta.env.VITE_API_URL ??
  'http://localhost:3000'
const authBaseURL = apiBase.startsWith('/')
  ? `${window.location.origin}${apiBase}/api/auth`
  : `${apiBase}/api/auth`

export const { authClient, useAuth } = createAppAuthClient(authBaseURL)
