import { createAppAuthClient } from '@/lib/authClient'

// Better Auth's baseURL is the URL prefix in front of `/api/auth/*` — i.e.
// the API base with the `/api` suffix stripped. In dev that's just the API
// origin (`http://localhost:3000`). In prod the SPA sees the API through the
// vv-router at `/vv/api`, so the auth base is `/vv` (browser resolves it
// against `www.versevault.ca`). VITE_API_URL is the legacy flat-URL form,
// kept as a fallback.
const apiBase =
  import.meta.env.VITE_API_BASE ??
  import.meta.env.VITE_API_URL ??
  'http://localhost:3000'
const authBaseURL = apiBase.replace(/\/api$/, '')

export const { authClient, useAuth } = createAppAuthClient(authBaseURL)
