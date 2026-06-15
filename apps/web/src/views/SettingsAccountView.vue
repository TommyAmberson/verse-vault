<script setup lang="ts">
import { computed, ref } from 'vue'

import { api, ApiError, type ImportSummary } from '@/api'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ImportResultDialog from '@/components/ImportResultDialog.vue'
import TypeToConfirmDialog from '@/components/TypeToConfirmDialog.vue'
import { useAuth } from '@/composables/useAuth'
import { downloadJson, exportFilename, readJsonFile } from '@/lib/account-file'

const { activeProfile, resetProfileLocalData } = useAuth()

const banner = ref<{ kind: 'info' | 'error'; text: string } | null>(null)

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
