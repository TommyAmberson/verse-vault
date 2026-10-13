import { and, eq, like } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getIp } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { multiSession } from 'better-auth/plugins';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type SendEmail, resetPasswordEmail, verifyEmail } from './email.js';
import { type RateLimitTier, TokenBucketStore } from './rate-limit.js';

export interface AuthEnv {
  baseUrl: string;
  secret: string;
  webOrigin: string;
  googleOAuth?: { clientId: string; clientSecret: string };
  /** Resend API key. Without it, reset and verification links are logged
   *  instead of emailed. */
  resendApiKey?: string;
}

/** Origins served inside the Tauri desktop shell — one per webview
 *  family. WebKit (macOS / Linux) loads the frontend at `tauri://`;
 *  Edge WebView2 (Windows) loads it at `https://tauri.localhost`
 *  because `useHttpsScheme: true` in `apps/web/src-tauri/tauri.conf.json`
 *  is what makes Secure session cookies eligible to be sent. Both
 *  values must be allowlisted on every server surface that gates by
 *  origin (CORS, Better Auth `trustedOrigins`). */
export const TAURI_ORIGINS = ['tauri://localhost', 'https://tauri.localhost'] as const;

/** Requests that email an address: reset links and verification links. */
const EMAILING_PATHS = new Set(['/request-password-reset', '/send-verification-email']);

/** At most 3 such requests per address per hour, across both paths. */
const PER_ADDRESS_TIER: RateLimitTier = { capacity: 3, refillPerSec: 3 / 3600 };

/** At most 10 emails per IP per day: requests on those paths, plus
 *  verification emails sent at sign-up. */
const PER_IP_TIER: RateLimitTier = { capacity: 10, refillPerSec: 10 / (24 * 3600) };

const MAX_EMAIL_LENGTH = 254;

export function createAuth(db: DB, env: AuthEnv, sendEmail: SendEmail) {
  const isProd = process.env.NODE_ENV === 'production';
  // Browsers send Origin headers as scheme+host+port only — never a path.
  // env.webOrigin may include a subpath (production used
  // `https://www.versevault.ca/vv` before moving to the root), but matching
  // against trustedOrigins needs the bare origin. Strip the path here once and reuse below.
  const webOrigin = new URL(env.webOrigin).origin;

  // In dev, trust any localhost port the thin client might land on (Vite
  // falls back through 5180/5181/… when ports collide). Production sticks
  // to the configured web origin plus the Tauri origins — the desktop
  // shell reuses the same API so the user-facing surface is identical.
  const trustedOrigins = isProd
    ? [webOrigin, ...TAURI_ORIGINS]
    : [webOrigin, 'http://localhost:5173', 'http://localhost:5180', ...TAURI_ORIGINS];

  // Better Auth derives its request-matching basePath from
  // `new URL(baseURL).pathname` — so any path component in env.baseUrl
  // (a subpath deploy, as production's `/vv` was) becomes part of what
  // Better Auth expects every request URL to start with. The API always
  // receives requests at `/api/auth/*`: vv-router forwards `/api/*` with the
  // path unchanged (and used to strip `/vv`). Pass just the origin so the match path
  // stays empty and `/api/auth/*` is matched directly. We still keep
  // env.baseUrl as the source of truth for the public-facing URL (used
  // elsewhere for things like OAuth-flow URL construction).
  const betterAuthBaseURL = new URL(env.baseUrl).origin;

  // Email links always open the public web app, whichever client asked:
  // a desktop client's own origin (tauri://…) means nothing to the mail
  // client's browser.
  const webBase = env.webOrigin.replace(/\/$/, '');

  // Two limits on top of Better Auth's own, which reset within a minute.
  // Per address, so one inbox can't be flooded from many IPs. Per IP per
  // day, so one client can't spend the provider's daily quota (100 on
  // Resend's free plan) by signing up many addresses or resetting its own
  // accounts. Many IPs together still can (research D13). Reset and
  // verification requests count when they arrive, not when they send, so
  // throttling reveals nothing about which addresses have accounts.
  const sendBuckets = new TokenBucketStore();

  const auth = betterAuth({
    baseURL: betterAuthBaseURL,
    secret: env.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    trustedOrigins,
    // Better Auth's default error page is `${baseURL}/error`, a bare page
    // on the API rather than the app. Send any OAuth error the client didn't
    // give its own errorCallbackURL for to the profile picker instead, which
    // shows it. force=1 keeps the
    // router guard from forwarding a signed-in user off the picker (and
    // dropping `?error=`); Better Auth appends `&error=<code>`.
    onAPIError: { errorURL: `${webBase}/profiles?force=1` },
    emailAndPassword: {
      enabled: true,
      // sendEmail starts the send and returns, so a real address answers as
      // fast as an unknown one, for which Better Auth only fakes the work.
      sendResetPassword: async ({ user, token }) =>
        sendEmail(resetPasswordEmail(user.email, `${webBase}/reset-password?token=${token}`)),
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => {
        // Receiving the reset email proves the inbox, so the address counts
        // as verified.
        await db
          .update(schema.user)
          .set({ emailVerified: true, updatedAt: new Date() })
          .where(eq(schema.user.id, user.id));
        // Better Auth consumes only the token just used; any older reset
        // link for this user would otherwise still work until it expired.
        await db
          .delete(schema.verification)
          .where(
            and(
              like(schema.verification.identifier, 'reset-password:%'),
              eq(schema.verification.value, user.id),
            ),
          );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: 24 * 60 * 60,
      // Link to the web app's page rather than the API: the page signs the
      // learner in to the right account first, then verifies. The address
      // rides along so the page knows which account that is; the token
      // already carries it, so this exposes nothing new.
      sendVerificationEmail: async ({ user, token }, request) => {
        // A sign-up counts towards its IP's daily limit only once the account
        // exists, and over the limit it skips the email instead of refusing:
        // a group signing up on one network still gets in, and can send the
        // email later from settings. The response is the same either way.
        if (request && new URL(request.url).pathname.endsWith('/sign-up/email')) {
          const ip = getIp(request, auth.options);
          if (ip && !sendBuckets.consume(`ip:${ip}`, PER_IP_TIER).allowed) {
            console.warn(`[email] sign-up verification skipped: daily limit reached for ${ip}`);
            return;
          }
        }
        sendEmail(
          verifyEmail(
            user.email,
            `${webBase}/verify-email?token=${token}&email=${encodeURIComponent(user.email)}`,
          ),
        );
      },
      // Verify only for that account's own session. Better Auth's verify
      // route sets the flag and nothing else, so a signed-out click would
      // verify an address someone else registered, leaving their password
      // on an account that then accepts the owner's Google sign-in.
      beforeEmailVerification: async (user, request) => {
        const current = request ? await auth.api.getSession({ headers: request.headers }) : null;
        if (current?.user.id !== user.id) {
          throw new APIError('FORBIDDEN', {
            message: 'Sign in to this account to verify its email.',
          });
        }
      },
    },
    socialProviders: env.googleOAuth
      ? {
          google: {
            ...env.googleOAuth,
            // Pin the redirect URI to the public API URL (env.baseUrl) rather
            // than Better Auth's derived one, which is built from the
            // origin-only baseURL above and would drop any subpath. It must
            // match a URI registered in the Google console exactly. Tauri-shell OAuth is expected to reuse
            // this same URI (the flow lands on the API, which bounces to
            // the in-app `callbackURL`) but isn't smoke-tested yet — see
            // the Known limitations entry in apps/web/CHANGELOG.md.
            redirectURI: `${env.baseUrl}/api/auth/callback/google`,
          },
        }
      : {},
    account: {
      accountLinking: {
        // A Google sign-in links into an existing account only when both
        // sides have proven the address. Better Auth checks the local side
        // (`requireLocalEmailVerified`, default true since 1.6.11), which
        // stops someone pre-registering another person's address with a
        // password (GHSA-g38m-r43w-p2q7); email verification above is how a
        // password account gets there. Google stays out of
        // `trustedProviders` so the provider side is checked too: trusting
        // it would accept a Google account whose own `email_verified` is
        // false, i.e. an address Google never confirmed.
        enabled: true,
      },
    },
    // Multi-session lets the device hold cookies for several signed-in
    // accounts at once. Each new sign-in is stacked alongside any
    // existing session cookies rather than replacing them; the picker
    // uses `multiSession.{listDeviceSessions,setActive,revoke}` to
    // swap between accounts and to sign out a single profile without
    // disturbing the others. Schema-compatible — no new tables.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!EMAILING_PATHS.has(ctx.path)) return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        // The body isn't validated yet. Anything longer than an address can
        // be (254 characters) matches no account, so skip it rather than
        // let oversized junk fill the bucket store.
        if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH) return;
        const perAddress = sendBuckets.consume(
          `email:${email.trim().toLowerCase()}`,
          PER_ADDRESS_TIER,
        );
        if (!perAddress.allowed) {
          throw new APIError(
            'TOO_MANY_REQUESTS',
            { message: 'Too many requests for this address. Try again later.' },
            { 'Retry-After': String(Math.ceil(perAddress.retryAfterSec)) },
          );
        }
        // Checked second, so requests the address limit refuses don't use up
        // the whole network's allowance.
        const ip = ctx.request ? getIp(ctx.request, ctx.context.options) : null;
        if (!ip) return;
        const perIp = sendBuckets.consume(`ip:${ip}`, PER_IP_TIER);
        if (perIp.allowed) return;
        throw new APIError(
          'TOO_MANY_REQUESTS',
          { message: 'Too many requests from this network. Try again later.' },
          { 'Retry-After': String(Math.ceil(perIp.retryAfterSec)) },
        );
      }),
    },
    advanced: {
      // Cloudflare Tunnel delivers the client's address in CF-Connecting-IP
      // without X-Forwarded-For, Better Auth's only default; reading neither
      // would put every production client in one rate-limit bucket.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
    },
    plugins: [multiSession()],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
