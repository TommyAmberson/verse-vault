<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api, ApiError, type ImportSummary } from '@/api'
import CodeField from '@/components/CodeField.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ImportResultDialog from '@/components/ImportResultDialog.vue'
import StatusChip from '@/components/StatusChip.vue'
import TypeToConfirmDialog from '@/components/TypeToConfirmDialog.vue'
import { useAuth } from '@/composables/useAuth'
import { useEmailRequest } from '@/composables/useEmailRequest'
import { downloadJson, exportFilename, readJsonFile } from '@/lib/account-file'
import { codeErrorMessage } from '@/lib/authEmail'
import { queryWithout, socialSignInError } from '@/lib/socialSignInError'

const {
  activeProfile,
  resetProfileLocalData,
  sendVerificationCode,
  verifyEmail,
  linkGoogle,
  signInMethods,
  unlinkGoogle,
} = useAuth()
const route = useRoute()
const router = useRouter()

const banner = ref<{ kind: 'info' | 'error'; text: string } | null>(null)

// Connect Google. Unknown (null) until the account list loads, so the card
// doesn't flash up for an account that already has Google.
const methods = ref<string[] | null>(null)
const hasGoogle = computed(() => (methods.value ? methods.value.includes('google') : null))
// Disconnecting is offered only while a password remains to sign in with.
const canDisconnectGoogle = computed(
  () => !!methods.value?.includes('google') && methods.value.includes('credential'),
)
const disconnectBusy = ref(false)
const connectBusy = ref(false)
// A refused link comes back here with `?error=`.
// Asked to verify first, the message sits with the verification controls.
const linkError = socialSignInError(window.location.search)
const verifyFirst = ref(linkError?.code === 'verify_email_first' ? linkError.message : '')
if (linkError) {
  if (!verifyFirst.value) banner.value = { kind: 'error', text: linkError.message }
  void router.replace({ query: queryWithout(route.query, 'error', 'error_description') })
}
// Per account, so reload when the active profile changes.
watch(
  () => activeProfile.value?.profileId,
  async (profileId) => {
    methods.value = null
    try {
      const found = await signInMethods()
      // A slower answer for the profile before a switch must not land here.
      if (activeProfile.value?.profileId === profileId) methods.value = found
    } catch {
      // Offline: leave the card hidden.
    }
  },
  { immediate: true },
)

async function onDisconnectGoogle() {
  banner.value = null
  disconnectBusy.value = true
  const result = await unlinkGoogle().catch(() => null)
  disconnectBusy.value = false
  if (!result || result.error) {
    banner.value = { kind: 'error', text: "Couldn't disconnect Google. Try again." }
    return
  }
  methods.value = methods.value?.filter((m) => m !== 'google') ?? null
  banner.value = { kind: 'info', text: 'Google disconnected. Sign in with your password from now on.' }
}

async function onConnectGoogle() {
  banner.value = null
  connectBusy.value = true
  // On success the browser leaves for Google.
  const result = await linkGoogle().catch(() => null)
  if (!result || result.error) {
    banner.value = { kind: 'error', text: "Couldn't connect Google. Try again." }
    connectBusy.value = false
  }
}

// Export
const exportBusy = ref(false)

// Import
const fileInput = ref<HTMLInputElement | null>(null)
const pendingImportPayload = ref<unknown | null>(null)
const importBusy = ref(false)
// Mutually exclusive: a summary on success, a message on failure. Both
// null while no result dialog is showing.
const importSummary = ref<ImportSummary | null>(null)
const importError = ref<string | null>(null)
const showImportResult = ref(false)

// Delete all progress
const showDeleteProgress = ref(false)
const deleteProgressBusy = ref(false)

const email = computed(() => activeProfile.value?.email ?? '')

// Verification: send a code, then enter it here, with the active session
// the server needs.
const {
  pending: verifyBusy,
  notice: verifyNotice,
  run: requestVerificationCode,
} = useEmailRequest(
  () => sendVerificationCode(email.value),
  () => `We sent a code to ${email.value}.`,
)
const verificationCodeSent = ref(false)
const verificationCode = ref('')
const verifyError = ref('')
const checkingCode = ref(false)
// A code belongs to one account, so start over when the profile changes.
watch(
  () => activeProfile.value?.profileId,
  () => {
    verificationCodeSent.value = false
    verificationCode.value = ''
    verifyError.value = ''
    verifyNotice.value = ''
    // Asked of the profile that tried to connect Google, not this one.
    verifyFirst.value = ''
  },
)

async function onSendVerification() {
  verifyError.value = ''
  const profileId = activeProfile.value?.profileId
  if ((await requestVerificationCode()) && activeProfile.value?.profileId === profileId) {
    verificationCode.value = ''
    verificationCodeSent.value = true
  }
}

async function onVerifyCode() {
  verifyError.value = ''
  checkingCode.value = true
  const profileId = activeProfile.value?.profileId
  let message: string
  try {
    // On success Better Auth refetches the session, and the session watcher
    // in useAuth copies the new status onto the profile row.
    message = codeErrorMessage(await verifyEmail(email.value, verificationCode.value)) ?? ''
  } catch {
    message = 'Something went wrong. Try again.'
  } finally {
    checkingCode.value = false
  }
  if (activeProfile.value?.profileId === profileId) verifyError.value = message
}

async function downloadActiveExport() {
  const targetEmail = activeProfile.value?.email ?? 'account'
  const data = await api.exportAccount()
  const isoDate = new Date().toISOString().slice(0, 10)
  downloadJson(exportFilename(targetEmail, isoDate), data)
}

async function onExport() {
  if (exportBusy.value) return
  banner.value = null
  exportBusy.value = true
  try {
    await downloadActiveExport()
    banner.value = { kind: 'info', text: 'Export downloaded.' }
  } catch (err) {
    banner.value = {
      kind: 'error',
      text: err instanceof ApiError ? err.message : 'Export failed.',
    }
  } finally {
    exportBusy.value = false
  }
}

function onImportClick() {
  banner.value = null
  fileInput.value?.click()
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
    // The import mutated this account server-side but didn't bump the
    // snapshot version, so the local fat-client cache won't notice. Drop
    // it so the next deck open cold-loads the imported state.
    if (activeProfile.value) await resetProfileLocalData(activeProfile.value.profileId)
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

function onDeleteProgressClick() {
  banner.value = null
  showDeleteProgress.value = true
}

function cancelDeleteProgress() {
  showDeleteProgress.value = false
}

async function confirmDeleteProgress() {
  deleteProgressBusy.value = true
  try {
    const summary = await api.deleteAllProgress()
    banner.value = {
      kind: 'info',
      text: `Reset ${summary.materialsReset} deck(s): removed ${summary.eventsDeleted} reviews and ${summary.graduationsDeleted} graduations.`,
    }
    // The wipe didn't bump the snapshot version; without dropping the
    // local cache the engine would keep serving (and could re-sync) the
    // now-deleted progress.
    if (activeProfile.value) await resetProfileLocalData(activeProfile.value.profileId)
  } catch (err) {
    banner.value = {
      kind: 'error',
      text: err instanceof ApiError ? err.message : 'Delete failed.',
    }
  } finally {
    deleteProgressBusy.value = false
    showDeleteProgress.value = false
  }
}

// Lets the delete dialog offer a one-click backup without re-opening
// the result banner. Errors here surface inline rather than as a
// page-level banner so the user stays inside the dialog.
const backupErrorInDialog = ref<string | null>(null)
async function onBackupInsideDialog() {
  backupErrorInDialog.value = null
  try {
    await downloadActiveExport()
  } catch (err) {
    backupErrorInDialog.value =
      err instanceof ApiError ? err.message : 'Backup download failed.'
  }
}
</script>

<template>
  <div class="account">
    <p v-if="!activeProfile" class="status">No active profile.</p>
    <template v-else>
      <p v-if="banner" :class="['banner', `banner-${banner.kind}`]">{{ banner.text }}</p>

      <article class="action-card">
        <header>
          <h3>Email address</h3>
          <p>
            {{ email }}
            <StatusChip v-if="activeProfile.emailVerified === true" variant="accent">
              Verified
            </StatusChip>
            <StatusChip v-else-if="activeProfile.emailVerified === false" variant="warning">
              Not verified
            </StatusChip>
          </p>
          <p v-if="activeProfile.emailVerified === false">
            Until you verify, anyone with access to this inbox or its Google account can take
            over this account.
          </p>
        </header>
        <template v-if="activeProfile.emailVerified === false">
          <p v-if="verifyFirst" class="verify-error" role="alert">{{ verifyFirst }}</p>
          <p v-if="verifyNotice" role="status">{{ verifyNotice }}</p>
          <form
            v-if="verificationCodeSent"
            class="verify-code"
            @submit.prevent="onVerifyCode"
          >
            <CodeField
              v-model="verificationCode"
              :resending="verifyBusy"
              @resend="onSendVerification"
            />
            <p v-if="verifyError" class="verify-error" role="alert">{{ verifyError }}</p>
            <button type="submit" class="btn" :disabled="checkingCode">
              {{ checkingCode ? 'Checking…' : 'Verify' }}
            </button>
          </form>
          <button
            v-else
            type="button"
            class="btn"
            :disabled="verifyBusy"
            @click="onSendVerification"
          >
            {{ verifyBusy ? 'Sending…' : 'Send verification code' }}
          </button>
        </template>
      </article>

      <article v-if="canDisconnectGoogle" class="action-card">
        <header>
          <h3>Sign in with Google</h3>
          <p>
            A Google account is connected, so you can sign in with it as well as your password.
            If you didn't connect it, disconnect it here.
          </p>
        </header>
        <button type="button" class="btn" :disabled="disconnectBusy" @click="onDisconnectGoogle">
          {{ disconnectBusy ? 'Disconnecting…' : 'Disconnect Google' }}
        </button>
      </article>

      <article v-if="hasGoogle === false" class="action-card">
        <header>
          <h3>Sign in with Google</h3>
          <p>
            Connect a Google account that uses {{ email }} to sign in with it as well as your
            password. Connecting also verifies your address.
          </p>
        </header>
        <button type="button" class="btn" :disabled="connectBusy" @click="onConnectGoogle">
          {{ connectBusy ? 'Connecting…' : 'Connect Google' }}
        </button>
      </article>

      <article class="action-card">
        <header>
          <h3>Export my data</h3>
          <p>
            Download a JSON snapshot of this account's review history, graduations,
            and per-material settings.
          </p>
        </header>
        <button type="button" class="btn" :disabled="exportBusy" @click="onExport">
          {{ exportBusy ? 'Exporting…' : 'Download export' }}
        </button>
      </article>

      <article class="action-card">
        <header>
          <h3>Import data</h3>
          <p>
            Merge a previous export back into this account. Existing data is kept;
            re-importing the same file is safe.
          </p>
        </header>
        <button type="button" class="btn" @click="onImportClick">
          Choose file…
        </button>
      </article>

      <article class="action-card action-card-destructive">
        <header>
          <h3>Delete all progress</h3>
          <p>
            Permanently removes review history and graduations across every deck.
            Your decks and settings stay. Download a backup first if you might want
            to restore.
          </p>
        </header>
        <button type="button" class="btn btn-destructive" @click="onDeleteProgressClick">
          Delete all progress…
        </button>
      </article>
    </template>

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
        Import data into <strong>{{ email }}</strong>?
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
      v-if="showDeleteProgress && activeProfile"
      title="Delete all progress?"
      confirm-label="Delete all progress"
      :match-text="email"
      :busy="deleteProgressBusy"
      @confirm="confirmDeleteProgress"
      @cancel="cancelDeleteProgress"
    >
      <p>
        This permanently deletes <strong>all review history, graduations,
        and progress</strong> for <strong>{{ email }}</strong>
        across every deck. Your decks and settings stay. This cannot be undone.
      </p>
      <button type="button" class="backup-btn" @click="onBackupInsideDialog">
        ⬇ Download a backup (.json)
      </button>
      <p v-if="backupErrorInDialog" class="dialog-error" role="alert">
        {{ backupErrorInDialog }}
      </p>
    </TypeToConfirmDialog>
  </div>
</template>

<style scoped>
.verify-code {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 22rem;
}

.verify-error {
  color: var(--color-error);
  margin: 0;
}

.account {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.status {
  margin: 0;
  padding: 2rem;
  text-align: center;
  color: var(--color-muted);
  font-style: italic;
}

.banner {
  margin: 0;
  padding: 0.6rem 0.85rem;
  border-radius: 6px;
  font-size: 0.9rem;
}

.banner-info {
  background: var(--color-accent-soft);
  color: var(--color-text);
}

.banner-error {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.action-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.action-card-destructive {
  border-color: var(--color-grade-again);
}

.action-card header {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.action-card h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.action-card p {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-muted);
  line-height: 1.4;
}

.btn {
  align-self: flex-start;
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: none;
  border-radius: 4px;
  padding: 0.45rem 0.95rem;
  font-size: 0.9rem;
  font-family: inherit;
  cursor: pointer;
}

.btn:disabled {
  background: var(--color-border);
  color: var(--color-muted);
  cursor: not-allowed;
}

.btn-destructive {
  background: var(--color-grade-again);
  color: var(--color-on-accent);
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

.dialog-error {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  color: var(--color-error);
}
</style>
