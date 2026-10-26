<script setup lang="ts">
import { ref, watch } from 'vue'
import { type RouteLocationRaw, RouterLink, useRoute, useRouter } from 'vue-router'

import { api } from '@/api'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ProfileCard from '@/components/ProfileCard.vue'
import SignInForm from '@/components/SignInForm.vue'
import { queryWithout, socialSignInError } from '@/lib/socialSignInError'
import { reconcileDeviceSessions, useAuth } from '@/composables/useAuth'
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
// theirs. The token is single-use proof of that Google sign-in.
// The token stays in the URL until the choice is done: email sign-in
// reloads the page, so "That's me" is also remembered for this tab.
const pendingToken = typeof route.query.pending === 'string' ? route.query.pending : null
const pendingEmail = typeof route.query.email === 'string' ? route.query.email : ''
const CLAIM_KEY = 'vv:google-claim'
function rememberedClaim(): string | null {
  try {
    return sessionStorage.getItem(CLAIM_KEY)
  } catch {
    return null
  }
}
function rememberClaim(token: string | null) {
  try {
    if (token) sessionStorage.setItem(CLAIM_KEY, token)
    else sessionStorage.removeItem(CLAIM_KEY)
  } catch {
    // Storage blocked: the learner just chooses again after the reload.
  }
}
const choice = ref<'ask' | 'mine' | null>(
  pendingToken ? (rememberedClaim() === pendingToken ? 'mine' : 'ask') : null,
)
watch(choice, (c) => rememberClaim(c === 'mine' ? pendingToken : null))
const confirmTakeover = ref(false)
const choiceBusy = ref(false)
const choiceError = ref('')
const CHOICE_EXPIRED = 'That choice has expired. Sign in with Google again.'

// Set by the Google sign-in that finishes a takeover. Read once, so a
// reload doesn't repeat the notice.
const takenOver = route.query['taken-over'] === '1'
if (takenOver) void router.replace({ query: queryWithout(route.query, 'taken-over') })

// "That's me" claims once the account is the active profile: right after
// signing in, or, since that reloads the page, once the active profile is
// restored after this view mounts.
watch(
  activeProfile,
  (active) => {
    if (
      choice.value === 'mine' &&
      active?.sessionToken &&
      active.email.toLowerCase() === pendingEmail.toLowerCase()
    ) {
      void onMineSignedIn()
    }
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

function dropChoiceQuery() {
  return router.replace({ query: queryWithout(route.query, 'pending', 'email') })
}

function leaveChoice(error = '') {
  choice.value = null
  choiceError.value = error
  void dropChoiceQuery()
}

// "That's me": signed in with the account's password, so link Google to it.
async function onMineSignedIn() {
  if (!pendingToken || choiceBusy.value) return
  choiceBusy.value = true
  try {
    await api.claimGoogle(pendingToken)
    rememberClaim(null)
    // Pick up the now-verified address on this device's profile rows.
    await reconcileDeviceSessions()
    await router.replace(redirectTarget())
  } catch {
    leaveChoice(CHOICE_EXPIRED)
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
  } catch {
    confirmTakeover.value = false
    choiceBusy.value = false
    leaveChoice(CHOICE_EXPIRED)
    return
  }
  // Drop the used token first: a failed Google sign-in returns to this URL.
  await dropChoiceQuery()
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

    <div v-if="choice === 'ask'" class="choice">
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
