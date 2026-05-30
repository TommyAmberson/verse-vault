<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api, ApiError, type ImportSummary } from '@/api'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ImportResultDialog from '@/components/ImportResultDialog.vue'
import ProfileCard from '@/components/ProfileCard.vue'
import SignInForm from '@/components/SignInForm.vue'
import TypeToConfirmDialog from '@/components/TypeToConfirmDialog.vue'
import { useAuth } from '@/composables/useAuth'
import { downloadJson, exportFilename, readJsonFile } from '@/lib/account-file'
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

const banner = ref<string | null>(null)

const fileInput = ref<HTMLInputElement | null>(null)
// The parsed payload awaiting the import confirm. `switchTo` has already
// made the target the active profile by the time this is set, so the
// confirm dialog reads the account from `activeProfile`, not from here.
const pendingImportPayload = ref<unknown | null>(null)
const importBusy = ref(false)
// Mutually exclusive: a summary on success, a message on failure. Both
// null while no result dialog is showing.
const importSummary = ref<ImportSummary | null>(null)
const importError = ref<string | null>(null)
const showImportResult = ref(false)

const pendingDeleteProgress = ref<ProfileRow | null>(null)
const deleteProgressBusy = ref(false)

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
  return typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard'
}

async function onCardEnter(profile: ProfileRow) {
  const result = await enterProfile(profile.profileId)
  if (result.ok) {
    await router.replace(redirectTarget())
    return
  }
  // Token missing or rejected — drop into the sign-in form prefilled
  // with this profile's email so the user can re-auth in one step.
  prefillEmail.value = profile.email
  mode.value = 'add'
}

function onCardReauth(profile: ProfileRow) {
  prefillEmail.value = profile.email
  mode.value = 'add'
}

async function onCardSignOut(profile: ProfileRow) {
  // multiSession.revoke is per-token; the active and non-active
  // cases differ only in whether useAuth.signOut also clears the
  // in-memory active state — both branches handled inside signOut().
  // The shared profiles list refreshes automatically.
  await signOut(profile.profileId)
}

/** Make `profile`'s session active (no-op if it already is). Returns
 *  false and routes to the reauth form when the token is dead. */
async function switchTo(profile: ProfileRow): Promise<boolean> {
  if (activeProfile.value?.profileId === profile.profileId) return true
  let result: { ok: boolean }
  try {
    result = await enterProfile(profile.profileId)
  } catch {
    // enterProfile normally resolves { ok: false } for a dead token, but
    // a network error during the multiSession switch can reject — surface
    // it as a banner rather than an unhandled rejection.
    banner.value = 'Could not switch to that profile. Please try again.'
    return false
  }
  if (result.ok) return true
  prefillEmail.value = profile.email
  mode.value = 'add'
  return false
}

/** Clear the banner, switch to `profile`, then run `fn` against the
 *  now-active account. Skips `fn` if the switch needed reauth. The
 *  shared preamble for every per-card account action. */
async function withActiveProfile(profile: ProfileRow, fn: () => Promise<void>) {
  banner.value = null
  if (!(await switchTo(profile))) return
  await fn()
}

/** Download the active account's full export. Shared by the kebab
 *  Export item and the backup button inside the delete dialog. */
async function exportActiveAccount() {
  const email = activeProfile.value?.email ?? 'account'
  const data = await api.exportAccount()
  const isoDate = new Date().toISOString().slice(0, 10)
  downloadJson(exportFilename(email, isoDate), data)
}

function onCardExport(profile: ProfileRow) {
  return withActiveProfile(profile, async () => {
    try {
      await exportActiveAccount()
    } catch (err) {
      banner.value = err instanceof ApiError ? err.message : 'Export failed.'
    }
  })
}

async function onBackupClick() {
  banner.value = null
  try {
    await exportActiveAccount()
  } catch (err) {
    banner.value = err instanceof ApiError ? err.message : 'Backup download failed.'
  }
}

function onCardImport(profile: ProfileRow) {
  return withActiveProfile(profile, async () => {
    // The active profile is now the import target; open the OS file
    // picker and let `onFilePicked` carry on from the change event.
    fileInput.value?.click()
  })
}

async function onFilePicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // allow re-picking the same file later
  if (!file) return
  try {
    pendingImportPayload.value = await readJsonFile(file)
  } catch {
    pendingImportPayload.value = null
    importSummary.value = null
    importError.value = 'That file isn’t valid JSON.'
    showImportResult.value = true
  }
}

function cancelImport() {
  pendingImportPayload.value = null
}

async function confirmImport() {
  if (pendingImportPayload.value === null) return
  importBusy.value = true
  try {
    importSummary.value = await api.importAccount(pendingImportPayload.value)
    importError.value = null
  } catch (err) {
    importSummary.value = null
    importError.value = err instanceof ApiError ? err.message : 'Import failed.'
  } finally {
    importBusy.value = false
    pendingImportPayload.value = null
    showImportResult.value = true
  }
}

function closeImportResult() {
  showImportResult.value = false
}

function cancelDeleteProgress() {
  pendingDeleteProgress.value = null
}

function onCardDeleteProgress(profile: ProfileRow) {
  return withActiveProfile(profile, async () => {
    pendingDeleteProgress.value = profile
  })
}

async function confirmDeleteProgress() {
  const target = pendingDeleteProgress.value
  if (!target) return
  deleteProgressBusy.value = true
  try {
    const summary = await api.deleteAllProgress()
    banner.value = `Reset ${summary.materialsReset} deck(s): removed ${summary.eventsDeleted} reviews and ${summary.graduationsDeleted} graduations.`
  } catch (err) {
    banner.value = err instanceof ApiError ? err.message : 'Delete failed.'
  } finally {
    deleteProgressBusy.value = false
    pendingDeleteProgress.value = null
  }
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
          @export="onCardExport(p)"
          @import="onCardImport(p)"
          @delete-progress="onCardDeleteProgress(p)"
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

    <input
      ref="fileInput"
      type="file"
      accept="application/json"
      class="hidden-file"
      @change="onFilePicked"
    />

    <ConfirmDialog
      v-if="pendingImportPayload !== null"
      title="Import data?"
      confirm-label="Import"
      :busy="importBusy"
      @confirm="confirmImport"
      @cancel="cancelImport"
    >
      <p>
        Import data into <strong>{{ activeProfile?.email }}</strong>?
        This adds review history and graduations from the file. Existing
        data is kept, and re-importing the same file is safe.
      </p>
    </ConfirmDialog>

    <ImportResultDialog
      v-if="showImportResult"
      :summary="importSummary"
      :error="importError"
      @close="closeImportResult"
    />

    <TypeToConfirmDialog
      v-if="pendingDeleteProgress"
      title="Delete all progress?"
      confirm-label="Delete all progress"
      :match-text="pendingDeleteProgress.email"
      :busy="deleteProgressBusy"
      @confirm="confirmDeleteProgress"
      @cancel="cancelDeleteProgress"
    >
      <p>
        This permanently deletes <strong>all review history, graduations,
        and progress</strong> for <strong>{{ pendingDeleteProgress.email }}</strong>
        across every deck. Your decks and settings stay. This cannot be undone.
      </p>
      <button type="button" class="backup-btn" @click="onBackupClick">
        ⬇ Download a backup (.json)
      </button>
    </TypeToConfirmDialog>
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

.hidden-file {
  display: none;
}

.backup-btn {
  align-self: flex-start;
  padding: 0.45rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.backup-btn:hover {
  border-color: var(--color-accent);
}
</style>
