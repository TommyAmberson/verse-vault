<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ProfileCard from '@/components/ProfileCard.vue'
import SignInForm from '@/components/SignInForm.vue'
import { useAuth } from '@/composables/useAuth'
import { safeRedirect } from '@/router'
import type { ProfileRow } from '@/lib/engine/registry'

const {
  activeProfile,
  profiles,
  signInSocial,
  signInEmail,
  signUpEmail,
  signOut,
  enterProfile,
  deleteProfile,
} = useAuth()

const router = useRouter()
const route = useRoute()

const mode = ref<'empty' | 'cards' | 'add'>(profiles.value.length === 0 ? 'empty' : 'cards')
const prefillEmail = ref<string | undefined>(undefined)
const pendingDelete = ref<ProfileRow | null>(null)
const deleteBusy = ref(false)

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
    if (mode.value === 'add') return
    mode.value = rows.length === 0 ? 'empty' : 'cards'
  },
  { immediate: true },
)

function redirectTarget(): string {
  return safeRedirect(route.query.redirect)
}

// Token missing or rejected — re-authenticate. A Google profile goes
// straight back through the OAuth flow (the callbackURL is the current
// URL, so the router guard forwards to `redirect` on return); an email
// profile drops into the sign-in form prefilled with its address. A
// profile with no recorded provider (legacy row) falls back to the form.
function reauth(profile: ProfileRow) {
  if (profile.provider === 'google') {
    signInSocial('google')
    return
  }
  prefillEmail.value = profile.email
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
  prefillEmail.value = undefined
  mode.value = 'add'
}

function cancelAdd() {
  prefillEmail.value = undefined
  mode.value = profiles.value.length === 0 ? 'empty' : 'cards'
}

async function onSignInSuccess() {
  await router.replace(redirectTarget())
}
</script>

<template>
  <div class="picker">
    <h2 v-if="mode === 'cards'">Profiles</h2>
    <h2 v-else-if="mode === 'add'">Add a profile</h2>
    <h2 v-else>Sign in</h2>

    <p v-if="banner" class="banner">{{ banner }}</p>

    <template v-if="mode === 'cards'">
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
        :sign-in-social="signInSocial"
        :sign-in-email="signInEmail"
        :sign-up-email="signUpEmail"
        :prefill-email="prefillEmail"
        @success="onSignInSuccess"
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
