import { createHash } from 'node:crypto';

import { defineRequestState } from '@better-auth/core/context';
import { and, eq, ne } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import {
  APIError,
  createAuthMiddleware,
  getIp,
  getOAuthState,
  getSessionFromCtx,
} from 'better-auth/api';
import { generateRandomString } from 'better-auth/crypto';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, multiSession } from 'better-auth/plugins';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  type SendEmail,
  googleCodeEmail,
  googleLinkedEmail,
  googleUnlinkedEmail,
  resetCodeEmail,
  verificationCodeEmail,
} from './email.js';
import { type RateLimitTier, TokenBucketStore } from './rate-limit.js';

export interface AuthEnv {
  baseUrl: string;
  secret: string;
  webOrigin: string;
  googleOAuth?: { clientId: string; clientSecret: string };
  /** Resend API key. Without it, reset and verification codes are logged
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

/** Requests that email an address a code: reset and verification. The
 *  phase 1 verification route stays, sending a code now. */
const EMAILING_PATHS = new Set([
  '/email-otp/request-password-reset',
  '/email-otp/send-verification-otp',
  '/send-verification-email',
]);

/** Email-code routes outside this app: code sign-in, changing the address,
 *  the deprecated reset alias, and checking a code without using it. The
 *  check route counts wrong guesses without consuming the code row, so
 *  guesses sent at the same moment each see the old count (research D15).
 *  Better Auth refuses these over HTTP only; server calls through
 *  `auth.api` still work, and D16's confirm route checks codes that way. */
const REFUSED_PATHS = [
  '/sign-in/email-otp',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
  '/forget-password/email-otp',
  '/email-otp/check-verification-otp',
  // Disconnecting Google is our own route, which also ends other sessions.
  '/unlink-account',
];

/** Phase 1's link routes. Links emailed before codes would otherwise keep
 *  working for up to an hour, without the hook that verified the address
 *  and cancelled the user's other reset links. */
const LINK_PATHS = ['/request-password-reset', '/reset-password', '/verify-email'];

/** Code types the send route serves; `sign-in` and `change-email` belong to
 *  the refused flows. */
const SENDABLE_TYPES = new Set(['email-verification', 'forget-password']);

/** Codes last 10 minutes; the plugin's defaults give 6 digits and 3 wrong
 *  tries. */
const CODE_TTL_S = 10 * 60;

/** At most 3 such requests per address per hour, across both paths. */
const PER_ADDRESS_TIER: RateLimitTier = { capacity: 3, refillPerSec: 3 / 3600 };

/** Better Auth's default for "a recent sign-in". */
export const FRESH_SESSION_MS = 24 * 60 * 60 * 1000;

/** At most 10 emails per IP per day: requests on those paths, plus
 *  verification emails sent at sign-up. */
const PER_IP_TIER: RateLimitTier = { capacity: 10, refillPerSec: 10 / (24 * 3600) };

const MAX_EMAIL_LENGTH = 254;

/** Verification rows for a refused Google sign-in: the code step, then
 *  "That's me" or "That's not me" (research D7, D16). */
export const PENDING_GOOGLE_PREFIX = 'pending-google:';

/** What a pending row holds: the account the sign-in matched, the Google
 *  identity to link to it, and whether the inbox is proven yet, by Google
 *  being authoritative for the address or by an emailed code. */
export interface PendingGoogle {
  userId: string;
  sub: string;
  email: string;
  proven: boolean;
  /** The code step's code, hashed, and its wrong tries. The code lives here
   *  rather than in the email-code plugin's shared row, so it works for this
   *  step only (FR-021). */
  codeHash?: string;
  tries?: number;
}

/** How a code is stored: SHA-256, base64url. */
export const hashCode = (code: string) => createHash('sha256').update(code).digest('base64url');

/** Users whose Google links and unlinks should send no notice: the
 *  learner's own takeover, which also removes the password a notice would
 *  point to. */
const quietLinks = new Set<string>();

/** One step at a time per pending Google row: the code step's checks and
 *  sends read and write the same row, so each must see what the one before
 *  it wrote (research D16). A lock in this process suffices, as the API
 *  runs as one process. */
const pendingLocks = new Map<string, Promise<unknown>>();
export async function onePendingAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (pendingLocks.get(key) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => {});
  pendingLocks.set(key, settled);
  try {
    return await run;
  } finally {
    if (pendingLocks.get(key) === settled) pendingLocks.delete(key);
  }
}


export const PENDING_GOOGLE_TTL_MS = 10 * 60 * 1000;

/** The cookie that carries a pending row's token, set on the callback's
 *  response and sent only to the Google routes. The token stays in the
 *  browser that signed in with Google: a copied page address carries none,
 *  so it can't be handed to the inbox's owner to finish someone else's link. */
export const PENDING_GOOGLE_COOKIE = 'pending_google';

/** The Google profile the current callback signed in with: whether Google
 *  says it checked the address, and whether it speaks for it. Better Auth
 *  passes the refused-link path nothing but a redirect, so the profile is
 *  kept here for the after hook. */
const googleProfile = defineRequestState<{
  sub: string;
  email: string;
  emailVerified: boolean;
  authoritative: boolean;
} | null>(() => null);

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

  // OAuth errors and the Google choice open the public web app.
  const webBase = env.webOrigin.replace(/\/$/, '');
  const webBaseOrigin = new URL(webBase).origin;
  // The Google routes as the browser addresses them, under any path prefix
  // the public API URL carries, so the pending cookie reaches them.
  const pendingCookiePath = `${new URL(env.baseUrl).pathname.replace(/\/$/, '')}/api/account/google`;

  // Two limits on top of Better Auth's own, which reset within a minute.
  // Per address, so one inbox can't be flooded from many IPs. Per IP per
  // day, so one client can't spend the provider's daily quota (100 on
  // Resend's free plan) by signing up many addresses or resetting its own
  // accounts. Many IPs together still can (research D13). Reset and
  // verification requests count when they arrive, not when they send, so
  // throttling reveals nothing about which addresses have accounts.
  const sendBuckets = new TokenBucketStore();

  /** Counts a request to email `email` against both limits, the address
   *  first so requests it refuses don't use up the whole network's
   *  allowance. Which limit refused it, with the error to answer, or null
   *  when the email may go. */
  function chargeSend(
    email: string,
    ip: string | null,
  ): { limit: 'address' | 'network'; error: APIError } | null {
    const perAddress = sendBuckets.consume(`email:${email.trim().toLowerCase()}`, PER_ADDRESS_TIER);
    if (!perAddress.allowed) {
      return {
        limit: 'address',
        error: new APIError(
          'TOO_MANY_REQUESTS',
          { message: 'Too many requests for this address. Try again later.' },
          { 'Retry-After': String(Math.ceil(perAddress.retryAfterSec)) },
        ),
      };
    }
    if (!ip) return null;
    const perIp = sendBuckets.consume(`ip:${ip}`, PER_IP_TIER);
    if (perIp.allowed) return null;
    return {
      limit: 'network',
      error: new APIError(
        'TOO_MANY_REQUESTS',
        { message: 'Too many requests from this network. Try again later.' },
        { 'Retry-After': String(Math.ceil(perIp.retryAfterSec)) },
      ),
    };
  }

  const auth = betterAuth({
    baseURL: betterAuthBaseURL,
    secret: env.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    trustedOrigins,
    disabledPaths: [...REFUSED_PATHS, ...LINK_PATHS],
    // Better Auth's default error page is `${baseURL}/error`, a bare page
    // on the API rather than the app. Send any OAuth error the client didn't
    // give its own errorCallbackURL for to the profile picker instead, which
    // shows it. force=1 keeps the
    // router guard from forwarding a signed-in user off the picker (and
    // dropping `?error=`); Better Auth appends `&error=<code>`.
    onAPIError: { errorURL: `${webBase}/profiles?force=1` },
    emailAndPassword: {
      enabled: true,
      // Reset by code (the email-code plugin below) ends every session; the
      // plugin also verifies the address, since the code proves the inbox.
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      // The email-code plugin sends this as a code.
      sendOnSignUp: true,
      // Verify only for that account's own session. The verify route sets
      // the flag and nothing else, so a signed-out code would verify an
      // address someone else registered, leaving their password on an
      // account that then accepts the owner's Google sign-in.
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
            // Better Auth trusts this flag to link a Google sign-in into an
            // existing account and to start a new account verified. Google
            // only speaks for an address whose mail it hosts: Gmail, or a
            // Workspace account (the token carries its `hd` claim; an
            // organization proves it owns a domain before putting users on
            // it). For any other address,
            // `email_verified` records a check made when the Google account
            // was created, and the address may since have changed hands.
            mapProfileToUser: async (profile) => {
              const authoritative = profile.email_verified &&
                (/@(gmail|googlemail)\.com$/.test(profile.email.toLowerCase()) || !!profile.hd);
              await googleProfile.set({
                sub: profile.sub,
                email: profile.email,
                emailVerified: profile.email_verified,
                authoritative,
              });
              return { emailVerified: authoritative };
            },
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
        // false, i.e. an address Google never confirmed, and the provider
        // config above narrows Google's flag to addresses it is
        // authoritative for.
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
        // The send route's types for the refused flows, from outside only.
        if (ctx.request && isRefusedSend(ctx.path, ctx.body)) {
          throw new APIError('NOT_FOUND');
        }
        // The plugin compares the code before `beforeEmailVerification`
        // checks the session, so without this a signed-out guess would still
        // count and still learn whether the code was right. Refuse first.
        if (ctx.request && ctx.path === '/email-otp/verify-email') {
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          const session = await getSessionFromCtx(ctx);
          if (
            typeof email !== 'string' ||
            session?.user.email.toLowerCase() !== email.trim().toLowerCase()
          ) {
            throw new APIError('FORBIDDEN', {
              message: 'Sign in to this account to verify its email.',
            });
          }
        }
        // Adding a sign-in method asks for a sign-in within the last day, as
        // disconnecting does (OWASP: re-authenticate before linking).
        if (ctx.request && ctx.path === '/link-social') {
          const session = await getSessionFromCtx(ctx);
          const age = session ? Date.now() - new Date(session.session.createdAt).getTime() : 0;
          if (age > FRESH_SESSION_MS) {
            throw new APIError('FORBIDDEN', {
              message: 'Sign in again to connect Google.',
              code: 'SESSION_NOT_FRESH',
            });
          }
        }
        if (!EMAILING_PATHS.has(ctx.path)) return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        // The body isn't validated yet. Anything longer than an address can
        // be (254 characters) matches no account, so skip it rather than
        // let oversized junk fill the bucket store.
        if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH) return;
        const refused = chargeSend(
          email,
          ctx.request ? getIp(ctx.request, ctx.context.options) : null,
        );
        if (refused) throw refused.error;
      }),
      // Follow-ups to a Google callback, all only when Google says it
      // checked the address. Where it doesn't speak for the address, the
      // inbox still needs proving (research D16, D17).
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/callback/:id') return;
        const location = ctx.context.responseHeaders?.get('location');
        const profile = await googleProfile.get();
        if (!location || !profile?.emailVerified) return;
        const internal = ctx.context.internalAdapter;
        const redirect = new URL(location, webBase);
        const error = redirect.searchParams.get('error');
        // A sign-in that went through needs nothing more unless it was
        // Google connecting from settings, where Google speaks for the address.
        if (!error && !profile.authoritative) return;
        const found = await internal.findUserByEmail(profile.email, { includeAccounts: true });
        if (!found) return;

        if (error === 'unable_to_link_account' && !profile.authoritative) {
          // Connecting Google from settings, which Better Auth refused since
          // Google doesn't speak for the address. A verified account has
          // proven the inbox already, so link it; an unverified one proves it
          // with a code first. The OAuth state names the account connecting.
          const state = await getOAuthState();
          if (!state?.link || state.link.userId !== found.user.id) return;
          if (!found.user.emailVerified) {
            redirect.searchParams.set('error', 'verify_email_first');
            throw ctx.redirect(redirect.toString());
          }
          const owner = await internal.findAccountByProviderId(profile.sub, 'google');
          // Linked already: back where Connect Google started, as Better Auth
          // does for an existing link of its own.
          if (owner?.userId === found.user.id) throw ctx.redirect(state.callbackURL);
          if (owner) {
            redirect.searchParams.set('error', 'account_already_linked_to_different_user');
            throw ctx.redirect(redirect.toString());
          }
          // The unique index refuses a link that raced another for the same
          // Google account; Better Auth's refusal then stands.
          const linked = await internal
            .linkAccount({ providerId: 'google', accountId: profile.sub, userId: found.user.id })
            .then(() => true, () => false);
          if (!linked) return;
          throw ctx.redirect(state.callbackURL);
        }

        if (error !== 'account_not_linked') {
          // Connecting Google from settings (`linkSocial`) links an
          // authoritative account without verifying the address, though
          // `linkSocial` refuses a different one. Verify it here.
          const linked = found.accounts.some(
            (a) => a.providerId === 'google' && a.accountId === profile.sub,
          );
          if (linked && profile.authoritative && !found.user.emailVerified) {
            await internal.updateUser(found.user.id, { emailVerified: true });
          }
          return;
        }

        // A refused sign-in onto a verified account, where Google doesn't
        // speak for the address, stays refused: adding a sign-in method needs
        // a session on the account (FR-014, OWASP), so the learner signs in
        // with the password and connects Google from settings.
        if (found.user.emailVerified) return;
        // Onto an unverified account: where Google speaks for the address,
        // offer the learner "That's me" or "That's not me". Otherwise email a
        // code-step code to prove the inbox first; the confirm route then
        // leads to the choice. Both go through a short-lived pending row,
        // handled by the picker on the client's own origin, whichever page
        // sign-in started from. The address rides along to prefill sign-in
        // and name where the code went; it's the one the learner just signed
        // in to Google with, so it tells them nothing new.
        const token = generateRandomString(32);
        const pending: PendingGoogle = {
          userId: found.user.id,
          sub: profile.sub,
          email: found.user.email,
          proven: profile.authoritative,
        };
        await internal.createVerificationValue({
          identifier: `${PENDING_GOOGLE_PREFIX}${token}`,
          value: JSON.stringify(pending),
          expiresAt: new Date(Date.now() + PENDING_GOOGLE_TTL_MS),
        });
        const cookie = ctx.context.createAuthCookie(PENDING_GOOGLE_COOKIE, {
          maxAge: PENDING_GOOGLE_TTL_MS / 1000,
          path: pendingCookiePath,
        });
        ctx.setCookie(cookie.name, token, cookie.attributes);
        const sent = pending.proven
          ? 'sent'
          : await sendGoogleCode(`${PENDING_GOOGLE_PREFIX}${token}`, ctx.request ?? null);
        // On the web app's own origin, keep its base path (a subpath deploy).
        // A desktop client's `tauri://localhost` has the opaque origin
        // "null", so rebuild it from the scheme and host.
        const origin = redirect.origin === 'null'
          ? `${redirect.protocol}//${redirect.host}`
          : redirect.origin;
        const base = origin === webBaseOrigin ? webBase : origin;
        const picker = new URL(`${base}/profiles`);
        const query: Record<string, string> = { force: '1', pending: '1', email: pending.email };
        if (!pending.proven) query.code = '1';
        // Keep where the learner was going when sign-in started.
        const destination = redirect.searchParams.get('redirect');
        if (destination) query.redirect = destination;
        // Over a limit no code went out; the picker says which.
        if (sent !== 'sent') query.sent = sent === 'network' ? 'network' : '0';
        picker.search = new URLSearchParams(query).toString();
        throw ctx.redirect(picker.toString());
      }),
    },
    databaseHooks: {
      account: {
        create: {
          // A Google account joining an account that already has a way to
          // sign in, by any route (choice, Connect Google, or Better Auth
          // linking an authoritative sign-in): tell the owner (FR-027). Not
          // for a new Google sign-up, which has nothing else, nor the
          // learner's own takeover.
          after: async (account) => {
            if (account.providerId !== 'google' || quietLinks.has(account.userId)) return;
            const others = db
              .select()
              .from(schema.account)
              .where(and(eq(schema.account.userId, account.userId), ne(schema.account.id, account.id)))
              .all();
            if (others.length === 0) return;
            const owner = db.select().from(schema.user).where(eq(schema.user.id, account.userId))
              .get();
            if (owner) sendEmail(googleLinkedEmail(owner.email));
          },
        },
        delete: {
          // Google disconnected while the account stays: tell the owner too.
          after: async (account) => {
            if (account.providerId !== 'google' || quietLinks.has(account.userId)) return;
            const owner = db.select().from(schema.user).where(eq(schema.user.id, account.userId))
              .get();
            if (owner) sendEmail(googleUnlinkedEmail(owner.email));
          },
        },
      },
    },
    advanced: {
      // Cloudflare Tunnel delivers the client's address in CF-Connecting-IP
      // without X-Forwarded-For, Better Auth's only default; reading neither
      // would put every production client in one rate-limit bucket.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
    },
    plugins: [
      multiSession(),
      emailOTP({
        expiresIn: CODE_TTL_S,
        storeOTP: 'hashed',
        // Sign-up and the phase 1 send route send a code instead of a link.
        overrideDefaultEmailVerification: true,
        // sendEmail starts the send and returns, so a real address answers
        // as fast as an unknown one, for which the plugin sends nothing.
        sendVerificationOTP: async ({ email, otp, type }, ctx) => {
          if (!SENDABLE_TYPES.has(type)) return;
          if (type === 'forget-password') {
            sendEmail(resetCodeEmail(email, otp, CODE_TTL_S / 60));
            return;
          }
          // A code sent on its own, at sign-up with a password or with
          // Google, counts towards its IP's daily limit only once the account
          // exists, and over the limit it skips the email instead of
          // refusing: a group signing up on one network still gets in, and
          // can send a code later from settings. The response is the same
          // either way. Requests to send one were counted on arrival.
          const request = ctx?.request;
          if (request && !EMAILING_PATHS.has(authPath(request))) {
            const ip = getIp(request, auth.options);
            if (ip && !sendBuckets.consume(`ip:${ip}`, PER_IP_TIER).allowed) {
              console.warn(`[email] sign-up verification skipped: daily limit reached for ${ip}`);
              return;
            }
          }
          sendEmail(verificationCodeEmail(email, otp, CODE_TTL_S / 60));
        },
      }),
    ],
  });
  /** Emails a new code-step code for the pending row `identifier` and
   *  stores its hash there, replacing any older one, under both email
   *  limits. `address` or `network` when that limit stopped the send. */
  async function sendGoogleCode(
    identifier: string,
    request: Request | null,
  ): Promise<'sent' | 'address' | 'network' | 'gone' | 'proven'> {
    const internal = (await auth.$context).internalAdapter;
    return onePendingAtATime(identifier, async () => {
      const row = await internal.findVerificationValue(identifier);
      if (!row || row.expiresAt < new Date()) return 'gone';
      const pending = JSON.parse(row.value) as PendingGoogle;
      // Confirmed meanwhile: nothing to send, and the row stays proven.
      if (pending.proven) return 'proven';
      const ip = request ? getIp(request, auth.options) : null;
      const refused = chargeSend(pending.email, ip);
      if (refused) return refused.limit;
      const code = generateRandomString(6, '0-9');
      // The code lasts 10 minutes from now, as its email says, and so does
      // the row it lives on.
      await internal.updateVerificationByIdentifier(identifier, {
        value: JSON.stringify({ ...pending, codeHash: hashCode(code), tries: 0 } satisfies PendingGoogle),
        expiresAt: new Date(Date.now() + PENDING_GOOGLE_TTL_MS),
      });
      sendEmail(googleCodeEmail(pending.email, code, CODE_TTL_S / 60));
      return 'sent';
    });
  }

  /** Runs `link` without the "Google was connected" or "disconnected"
   *  notices. */
  async function withoutLinkNotice<T>(userId: string, link: () => Promise<T>): Promise<T> {
    quietLinks.add(userId);
    try {
      return await link();
    } finally {
      quietLinks.delete(userId);
    }
  }

  return Object.assign(auth, { sendGoogleCode, withoutLinkNotice, pendingCookiePath });
}

export type Auth = ReturnType<typeof createAuth>;

function isRefusedSend(path: string, body: unknown): boolean {
  if (path !== '/email-otp/send-verification-otp') return false;
  const type = (body as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' && !SENDABLE_TYPES.has(type);
}

/** A request's path under Better Auth's `/api/auth` mount, as `ctx.path`
 *  names it. */
function authPath(request: Request): string {
  return new URL(request.url).pathname.replace(/^.*?\/api\/auth/, '');
}
