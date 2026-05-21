import { createAppAuthClient } from '@/lib/authClient'

// Better Auth's baseURL is the URL prefix in front of `/api/auth/*` — i.e.
// the API base with the `/api` suffix stripped. In dev that's just the API
// origin (`http://localhost:3000`). In prod the SPA sees the API through the
// vv-router at `/vv/api`, so the stripped base is `/vv` — but Better Auth's
// client validates baseURL via `new URL(...)` which rejects relative paths,
// so resolve relative results against `window.location.origin`. VITE_API_URL
// is the legacy flat-URL form, kept as a fallback.
const apiBase =
  import.meta.env.VITE_API_BASE ??
  import.meta.env.VITE_API_URL ??
  'http://localhost:3000'
const stripped = apiBase.replace(/\/api$/, '')
const authBaseURL = stripped.startsWith('/')
  ? window.location.origin + stripped
  : stripped

export const { authClient, useAuth } = createAppAuthClient(authBaseURL)
