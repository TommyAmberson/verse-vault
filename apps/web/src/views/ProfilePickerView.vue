<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { type RouteLocationRaw, RouterLink, useRoute, useRouter } from 'vue-router'

import { api, ApiError } from '@/api'
import CodeField from '@/components/CodeField.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ProfileCard from '@/components/ProfileCard.vue'
import SignInForm from '@/components/SignInForm.vue'
import { queryWithout, socialSignInError } from '@/lib/socialSignInError'
import { reconcileDeviceSessions, useAuth } from '@/composables/useAuth'
import { useEmailRequest } from '@/composables/useEmailRequest'
import { CODE_FAILURES, codeErrorMessage } from '@/lib/authEmail'
import { safeRedirect } from '@/router'
import type { ProfileRow } from '@/lib/engine/registry'

const {
  activeProfile,
  profiles,
  signInSocial,
  signInEmail,
  signUpEmail,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  sendVerificationCode,
  signOut,
  enterProfile,
  deleteProfile,
} = useAuth()

const router = useRouter()
const route = useRoute()

// A failed social sign-in comes back here with `?error=`. The cards don't
// render SignInForm, so open the form, which shows and strips the error.
const returnedWithError = socialSignInError(window.location.search) !== null
const mode = ref<'empty' | 'cards' | 'add'>(
  profiles.value.length === 0 ? 'empty' : returnedWithError ? 'add' : 'cards',
)
const reauthTarget = ref<ProfileRow | null>(null)
const pendingDelete = ref<ProfileRow | null>(null)
const deleteBusy = ref(false)
// Set while a sign-up is under way, so the watcher below doesn't
// swap it for the cards before it can show its post-sign-up note.
const holdForm = ref(false)

// Populated when we arrive here from a redirect: an expired/revoked
// session (`reason=expired`, set by the 401 handler in main.ts) or a
// plain unauthenticated navigation the router guard bounced (a
// `redirect` target but no reason).
const banner = ref<string | null>(
  route.query.reason === 'expired'
    ? 'Your session expired — sign in again to pick up where you left off.'
    : route.query.redirect
      ? 'Please sign in to continue.'
      : null,
)

// A Google sign-in onto an unverified password account comes back with
// `?pending=` and the address: the learner says whether the account is
// theirs. The token is single-use proof of that Google sign-in. Where
// Google doesn't speak for the address, `code=1` asks first for the code
// emailed to it, which proves the inbox (research D16); `sent=0` means a
// limit stopped that code. Once proven, the token alone can take the
// account over, so it moves out of the URL (history, synced tabs) into this
// tab's storage, which also carries it across the reload email sign-in
// causes.
interface PendingChoice {
  token: string
  email: string
  step: 'code' | 'ask' | 'mine'
  unsent: boolean
  savedAt: number
}
const PENDING_KEY = 'vv:google-pending'
// Past the server's 10 minutes, plus the code step's own 10.
const PENDING_MAX_AGE_MS = 20 * 60 * 1000
function loadPending(): PendingChoice | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as PendingChoice | null
    return saved && Date.now() - saved.savedAt < PENDING_MAX_AGE_MS ? saved : null
  } catch {
    return null
  }
}
function savePending(pending: PendingChoice | null) {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
    else sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // Storage blocked: after a reload the learner signs in with Google again.
  }
}
const fromUrl: PendingChoice | null = typeof route.query.pending === 'string'
  ? {
    token: route.query.pending,
    email: typeof route.query.email === 'string' ? route.query.email : '',
    step: route.query.code === '1' ? 'code' : 'ask',
    unsent: route.query.sent === '0',
    savedAt: Date.now(),
  }
  : null
const savedChoice = fromUrl ?? loadPending()
if (fromUrl) {
  savePending(fromUrl)
  void router.replace({ query: queryWithout(route.query, 'pending', 'email', 'code', 'sent') })
}
const pendingToken = savedChoice?.token ?? null
const pendingEmail = savedChoice?.email ?? ''
const codeUnsent = ref(savedChoice?.unsent ?? false)
const codeStep = ref(savedChoice?.step === 'code')
const googleCode = ref('')
const codeBusy = ref(false)
const {
  pending: codeResending,
  notice: codeNotice,
  run: resendGoogleCode,
} = useEmailRequest(
  () => sendVerificationCode(pendingEmail),
  () => `We sent a new code to ${pendingEmail}.`,
)
const choice = ref<'ask' | 'mine' | null>(
  savedChoice && savedChoice.step !== 'code' ? savedChoice.step : null,
)
// Keep the stored step in line, so a reload lands where the learner was.
watch([codeStep, choice, codeUnsent], ([code, chosen, unsent]) => {
  if (!savedChoice) return
  const step = code ? 'code' : chosen
  savePending(step ? { ...savedChoice, step, unsent } : null)
})
const confirmTakeover = ref(false)
const choiceBusy = ref(false)
const choiceError = ref('')
const CHOICE_EXPIRED = 'That choice has expired. Sign in with Google again.'

async function onResendCode() {
  if (await resendGoogleCode()) codeUnsent.value = false
}

/** Says why a choice request failed. Only a 400 means the token is gone;
 *  after anything else it still works, so the step stays for a retry. */
function choiceFailed(err: unknown) {
  if (err instanceof ApiError && err.status === 400) {
    leaveChoice(CHOICE_EXPIRED)
  } else if (err instanceof ApiError && err.status === 403) {
    choiceError.value = "You're signed in to a different account. Sign in with this address."
  } else if (err instanceof ApiError && err.status === 401) {
    choiceError.value = 'Your session has ended. Sign in with the password again.'
  } else if (err instanceof ApiError && err.status === 429) {
    choiceError.value = 'Too many tries. Try again later.'
  } else {
    choiceError.value = 'Something went wrong. Try again.'
  }
}

// Set by the Google sign-in that finishes a takeover. Read once, so a
// reload doesn't repeat the notice.
const takenOver = route.query['taken-over'] === '1'
if (takenOver) void router.replace({ query: queryWithout(route.query, 'taken-over') })

// "That's me" claims once the account is the active profile: right after
// signing in, once the active profile is restored after the reload sign-in
// causes, or at once when it was active already.
const mineReady = computed(
  () =>
    choice.value === 'mine' &&
    !!activeProfile.value?.sessionToken &&
    activeProfile.value.email.toLowerCase() === pendingEmail.toLowerCase(),
)
// Keyed on the session token too, so signing in again after a session
// ended elsewhere retries the claim.
watch(
  () => (mineReady.value ? activeProfile.value?.sessionToken : null),
  (token) => {
    if (token) void onMineSignedIn()
  },
  { immediate: true },
)

// Keep mode in sync with the shared profiles list (reconcile, sign-in
// from another flow, etc.). Skip when the user is mid-add — don't
// yank them out of the sign-in form just because a chip flipped.
// `immediate: true` defends against any future router refactor where
// `loadActiveProfileFromRegistry` isn't awaited before navigation:
// the synchronous `mode` init at setup would otherwise read the
// pre-populate value and never get a chance to flip.
watch(
  profiles,
  (rows) => {
    if (mode.value === 'add' || holdForm.value) return
    mode.value = rows.length === 0 ? 'empty' : 'cards'
  },
  { immediate: true },
)

function redirectTarget(): string {
  return safeRedirect(route.query.redirect)
}

/** Absolute same-origin URL for the destination, for OAuth callbackURLs.
 *  `router.resolve(...).href` re-applies the history base
 *  (`VITE_BASE_PATH`, `/` in production) that router paths strip, so a
 *  subpath build would otherwise 302 to `/review` instead of
 *  `<base>/review`, landing outside the SPA. */
function redirectCallbackUrl(to: RouteLocationRaw = redirectTarget()): string {
  return window.location.origin + router.resolve(to).href
}

/** Social sign-in from this picker returns to the destination, matching
 *  the email path's `router.replace(redirectTarget())` — the default
 *  callbackURL (current href) would land back on this force=1 picker,
 *  which the guard deliberately doesn't forward off. */
function signInSocialToDestination(provider: Parameters<typeof signInSocial>[0]) {
  signInSocial(provider, redirectCallbackUrl())
}

// Token missing or rejected — re-authenticate. A Google profile goes
// straight back through the OAuth flow (the callbackURL is the current
// URL, so the router guard forwards to `redirect` on return); an email
// profile drops into the sign-in form prefilled with its address. A
// profile with no recorded provider (legacy row) could be either, so it
// gets the provider picker: a password form would strand an OAuth user.
function reauth(profile: ProfileRow) {
  if (profile.provider === 'google') {
    // Land the OAuth round-trip on the destination, not back on this
    // force=1 picker (the guard won't forward off a force=1 picker).
    signInSocialToDestination('google')
    return
  }
  reauthTarget.value = profile
  mode.value = 'add'
}

async function onCardEnter(profile: ProfileRow) {
  const result = await enterProfile(profile.profileId)
  if (result.ok) {
    await router.replace(redirectTarget())
    return
  }
  reauth(profile)
}

function onCardReauth(profile: ProfileRow) {
  reauth(profile)
}

async function onCardSignOut(profile: ProfileRow) {
  // multiSession.revoke is per-token; the active and non-active
  // cases differ only in whether useAuth.signOut also clears the
  // in-memory active state — both branches handled inside signOut().
  // The shared profiles list refreshes automatically.
  await signOut(profile.profileId)
}

function requestDelete(profile: ProfileRow) {
  pendingDelete.value = profile
}

function cancelDelete() {
  pendingDelete.value = null
}

async function confirmDelete() {
  const target = pendingDelete.value
  if (!target) return
  deleteBusy.value = true
  try {
    await deleteProfile(target.profileId)
  } finally {
    deleteBusy.value = false
    pendingDelete.value = null
  }
}

function startAdd() {
  reauthTarget.value = null
  mode.value = 'add'
}

function cancelAdd() {
  reauthTarget.value = null
  holdForm.value = false
  mode.value = profiles.value.length === 0 ? 'empty' : 'cards'
}

async function onSignInSuccess() {
  await router.replace(redirectTarget())
}

function leaveChoice(error = '') {
  codeStep.value = false
  choice.value = null
  choiceError.value = error
  savePending(null)
}

// The code step: a verified account is now linked, so sign in with Google
// again; an unverified one goes on to the choice. A learner who can't
// enter the code sees nothing more about the account.
async function onConfirmCode() {
  if (!pendingToken) return
  choiceError.value = ''
  codeBusy.value = true
  let result
  try {
    result = await api.confirmGoogle(pendingToken, googleCode.value)
  } catch (err) {
    // The code's own failures get their messages; anything else, such as a
    // code the plugin adds later, falls back to the token's handling.
    const codeFailure = err instanceof ApiError && CODE_FAILURES.has(err.code ?? '')
    if (codeFailure) choiceError.value = codeErrorMessage({ error: { code: err.code } }) ?? ''
    else choiceFailed(err)
    return
  } finally {
    codeBusy.value = false
  }
  if (result.signIn) {
    leaveChoice()
    signInSocialToDestination('google')
    return
  }
  codeStep.value = false
  choice.value = 'ask'
}

// "That's me": signed in with the account's password, so link Google to it.
async function onMineSignedIn() {
  if (!pendingToken || choiceBusy.value) return
  choiceBusy.value = true
  try {
    await api.claimGoogle(pendingToken)
    leaveChoice()
    // Pick up the now-verified address on this device's profile rows.
    await reconcileDeviceSessions()
    await router.replace(redirectTarget())
  } catch (err) {
    choiceFailed(err)
  } finally {
    choiceBusy.value = false
  }
}

// "That's not me", confirmed: take the account over, then sign in with
// Google again, which now finds it linked.
async function onTakeover() {
  if (!pendingToken) return
  choiceBusy.value = true
  try {
    await api.takeOverWithGoogle(pendingToken)
  } catch (err) {
    confirmTakeover.value = false
    choiceBusy.value = false
    choiceFailed(err)
    return
  }
  // Drop the used token first: a failed Google sign-in returns here.
  leaveChoice()
  signInSocial(
    'google',
    redirectCallbackUrl({ path: '/profiles', query: { force: '1', 'taken-over': '1' } }),
  )
}
</script>

<template>
  <div class="picker">
    <h2 v-if="mode === 'cards'">Profiles</h2>
    <h2 v-else-if="mode === 'add'">Add a profile</h2>
    <h2 v-else>Sign in</h2>

    <p v-if="banner" class="banner">{{ banner }}</p>
    <p v-if="choiceError" class="banner" role="alert">{{ choiceError }}</p>
    <p v-if="takenOver" class="banner" role="status">
      The account is yours now. It may still hold progress someone else recorded; clear it with
      Delete all progress in <RouterLink to="/settings/account">account settings</RouterLink>.
    </p>

    <form v-if="codeStep" class="choice" @submit.prevent="onConfirmCode">
      <p v-if="codeUnsent">
        To connect Google, enter a code sent to <strong>{{ pendingEmail }}</strong>. We couldn't
        send one just now; try "Send a new code" in a few minutes.
      </p>
      <p v-else>
        To connect Google, enter the code we sent to <strong>{{ pendingEmail }}</strong>.
      </p>
      <CodeField v-model="googleCode" :resending="codeResending" @resend="onResendCode" />
      <p v-if="codeNotice" class="auth-notice" role="status">{{ codeNotice }}</p>
      <button type="submit" class="choice-btn" :disabled="codeBusy">
        {{ codeBusy ? 'Checking…' : 'Continue' }}
      </button>
      <button type="button" class="back-btn" @click="leaveChoice()">Cancel</button>
    </form>

    <div v-else-if="choice === 'ask'" class="choice">
      <p>
        An unverified account for <strong>{{ pendingEmail }}</strong> already exists. Is it
        yours?
      </p>
      <button type="button" class="choice-btn" @click="choice = 'mine'">
        That's me: sign in with its password
      </button>
      <button type="button" class="choice-btn" @click="confirmTakeover = true">
        That's not me
      </button>
      <button type="button" class="back-btn" @click="leaveChoice()">Cancel</button>
    </div>

    <template v-else-if="choice === 'mine'">
      <SignInForm
        :sign-in-social="signInSocialToDestination"
        :sign-in-email="signInEmail"
        :sign-up-email="signUpEmail"
        :request-password-reset="requestPasswordReset"
        :reset-password="resetPassword"
        :verify-email="verifyEmail"
        :send-verification-code="sendVerificationCode"
        :reauth="{ email: pendingEmail, provider: 'email' }"
      />
      <!-- Signed in already, so a failed claim retries from here. -->
      <button
        v-if="mineReady && choiceError"
        type="button"
        class="choice-btn"
        :disabled="choiceBusy"
        @click="onMineSignedIn"
      >
        Try again
      </button>
      <button type="button" class="back-btn" :disabled="choiceBusy" @click="choice = 'ask'">
        ← Back
      </button>
    </template>

    <template v-else-if="mode === 'cards'">
      <div class="cards">
        <ProfileCard
          v-for="p in profiles"
          :key="p.profileId"
          :profile="p"
          :active="activeProfile?.profileId === p.profileId"
          :signed-in="p.sessionToken !== null"
          @enter="onCardEnter(p)"
          @reauth="onCardReauth(p)"
          @sign-out="onCardSignOut(p)"
          @delete="requestDelete(p)"
        />
      </div>
      <button type="button" class="add-btn" @click="startAdd">
        Add another profile
      </button>
    </template>

    <template v-else>
      <SignInForm
        :sign-in-social="signInSocialToDestination"
        :sign-in-email="signInEmail"
        :sign-up-email="signUpEmail"
        :request-password-reset="requestPasswordReset"
        :reset-password="resetPassword"
        :verify-email="verifyEmail"
        :send-verification-code="sendVerificationCode"
        :key="reauthTarget?.profileId ?? ''"
        :reauth="reauthTarget ?? undefined"
        @success="onSignInSuccess"
        @hold="holdForm = $event"
      />
      <button v-if="mode === 'add'" type="button" class="back-btn" @click="cancelAdd">
        ← Back to profiles
      </button>
    </template>

    <ConfirmDialog
      v-if="pendingDelete"
      title="Delete profile?"
      confirm-label="Delete"
      destructive
      :busy="deleteBusy"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    >
      <p>
        Permanently remove <strong>{{ pendingDelete.email }}</strong>
        from this device. Cached review history will be deleted. You
        can sign in again later to start fresh.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      v-if="confirmTakeover"
      title="Take over this account?"
      confirm-label="Take over"
      destructive
      :busy="choiceBusy"
      @confirm="onTakeover"
      @cancel="confirmTakeover = false"
    >
      <p>
        Whoever set this account's password loses access, and every device signed in to it is
        signed out. The account may hold someone else's progress, which you can clear afterwards.
      </p>
      <p>
        If it's actually yours, you lose only the password: your progress stays, and Google or a
        password reset still gets you in.
      </p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1rem;
  width: 100%;
  max-width: 26rem;
}

h2 {
  margin: 0;
  font-size: 1.5rem;
  text-align: center;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.add-btn {
  width: 100%;
  padding: 0.6rem 0.75rem;
  background: none;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  color: var(--color-muted);
  font-size: 0.9rem;
  font-family: inherit;
  cursor: pointer;
}

.add-btn:hover {
  color: var(--color-text);
  border-color: var(--color-accent);
}

.back-btn {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 0;
  color: var(--color-muted);
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
}

.back-btn:hover {
  color: var(--color-text);
}

.choice {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.choice p {
  margin: 0;
}

.choice-btn {
  width: 100%;
  padding: 0.6rem 0.75rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 0.9rem;
  font-family: inherit;
  cursor: pointer;
}

.choice-btn:hover {
  border-color: var(--color-accent);
}

.banner {
  margin: 0;
  padding: 0.6rem 0.75rem;
  background: var(--color-accent-soft);
  color: var(--color-text);
  border-radius: 6px;
  font-size: 0.85rem;
  text-align: center;
}
</style>
