# Account Data Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Export / Import / Delete-all-progress to the profile card kebab menu, backed by the
existing export-import endpoints plus one new progress-reset endpoint.

**Architecture:** Server gains `DELETE /api/account/progress` (a thin route over a new
`lib/reset.ts` helper that wipes review/graduation/test-state rows per enrolled material under the
engine's per-key lock, keeping enrollment + settings). The web app adds three kebab actions that
switch to the target profile's session first (`enterProfile`), then call the endpoints; import uses
a neutral confirm + result modal, delete uses a type-the-email destructive modal with an in-dialog
backup download.

**Tech Stack:** Hono + Drizzle (better-sqlite3) on the server with Vitest; Vue 3 `<script setup>`
SFCs with scoped CSS on the web (no test harness — web changes are type-checked + manually
verified).

**Spec:** `docs/superpowers/specs/2026-05-29-account-data-management-design.md`

---

## File structure

**Server (`packages/api`)**

* Create `src/lib/reset.ts` — `deleteAccountProgress(db, engines, userId)` +
  `ProgressDeletionSummary`. One responsibility: wipe learning state.
* Create `src/lib/reset.test.ts` — unit tests for the helper.
* Modify `src/routes/account.ts` — add the `DELETE /account/progress` route.
* Modify `src/routes/account.test.ts` — route-level tests.

**Web (`apps/web`)**

* Modify `src/api.ts` — `'DELETE'` method, three new client methods + types.
* Create `src/lib/account-file.ts` — pure download/read/filename helpers.
* Create `src/components/ImportResultDialog.vue` — neutral import-summary/error modal.
* Create `src/components/TypeToConfirmDialog.vue` — destructive type-to-match modal.
* Modify `src/components/ProfileCard.vue` — three kebab items + emits.
* Modify `src/views/ProfilePickerView.vue` — orchestration of all three flows.

**Release / docs**

* Modify `docs/server-api.md`, `packages/api/CHANGELOG.md` + `package.json`,
  `apps/web/CHANGELOG.md` + `package.json`.

**Conventions to know**

* Run all commands from the repo root `/home/amberson/Code/verse-vault`.
* Server tests: `pnpm --filter @verse-vault/api exec vitest run <path>`.
* Server type-check: `pnpm --filter @verse-vault/api run type-check`.
* Web type-check: `pnpm --filter @verse-vault/web run type-check`. If it errors about missing
  `verse-vault-wasm` types, the bundler wasm build is stale — run
  `pnpm --filter @verse-vault/web run build:wasm:dev` once first (see the `pkg-web/` gotcha in
  `CLAUDE.md`).
* Commit subjects: Conventional Commits, **≤ 50 chars** including the `type(scope):` prefix
  (commitlint blocks longer). No `Co-Authored-By`.
* Pre-commit hooks run `lint-staged` (dprint on md/toml), `cargo fmt`, `typos`. Use `--no-verify`
  only for behaviour-neutral commits if a hook misfires; these tasks shouldn't need it.

---

## Task 1: Server — `deleteAccountProgress` helper (TDD)

**Files:**

* Create: `packages/api/src/lib/reset.ts`
* Test: `packages/api/src/lib/reset.test.ts`

* [ ] **Step 1: Write the failing test**

Create `packages/api/src/lib/reset.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb } from '../test-utils.js';

import { EngineStore } from './engine.js';
import { deleteAccountProgress } from './reset.js';

const MATERIAL_ID = 'nkjv-cor';
const NOW = 1_700_000_000;

function seedProgress(db: ReturnType<typeof createTestDb>['db']) {
  // Enrolls u1 (seeds user_materials, graph_snapshot, test_states) and
  // gives us settings + events + graduations to wipe.
  seedUserWithFixture({ db, userId: 'u1', materialId: MATERIAL_ID });
  db.insert(schema.userYearSettings)
    .values({
      userId: 'u1',
      materialId: MATERIAL_ID,
      headingCard: true,
      headingPassageCard: true,
      ftv: true,
      newScope: 'all',
      reviewScope: 'all',
      clubCardScope: 'off',
      chapterListScope: 'up150',
      lessonBatchSize: 3,
      desiredRetention: 0.9,
      updatedAt: NOW,
    })
    .run();
  db.insert(schema.reviewEvents)
    .values([
      {
        id: 'e1',
        userId: 'u1',
        materialId: MATERIAL_ID,
        snapshotVersion: 1,
        timestampSecs: NOW,
        cardId: 0,
        grade: 3,
        clientEventId: 'e1',
        createdAt: NOW,
      },
      {
        id: 'e2',
        userId: 'u1',
        materialId: MATERIAL_ID,
        snapshotVersion: 1,
        timestampSecs: NOW + 1,
        cardId: 0,
        grade: 4,
        clientEventId: 'e2',
        createdAt: NOW + 1,
      },
    ])
    .run();
  db.insert(schema.graduatedVerses)
    .values({ userId: 'u1', materialId: MATERIAL_ID, verseId: 0, graduatedAtSecs: NOW })
    .run();
  db.insert(schema.graduatedCards)
    .values({ userId: 'u1', materialId: MATERIAL_ID, cardId: 0, graduatedAtSecs: NOW })
    .run();
}

describe('deleteAccountProgress', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('wipes learning state but keeps enrollment + settings', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedProgress(test.db);

    const engines = new EngineStore(test.db);
    try {
      const summary = await deleteAccountProgress(test.db, engines, 'u1');

      expect(summary.materialsReset).toBe(1);
      expect(summary.eventsDeleted).toBe(2);
      expect(summary.graduationsDeleted).toBe(2);

      expect(test.db.select().from(schema.reviewEvents).all()).toHaveLength(0);
      expect(test.db.select().from(schema.graduatedVerses).all()).toHaveLength(0);
      expect(test.db.select().from(schema.graduatedCards).all()).toHaveLength(0);
      expect(test.db.select().from(schema.testStates).all()).toHaveLength(0);

      // Enrollment + settings survive — decks stay, just reset to new.
      expect(test.db.select().from(schema.userMaterials).all()).toHaveLength(1);
      expect(test.db.select().from(schema.userYearSettings).all()).toHaveLength(1);
    } finally {
      engines.clear();
    }
  });

  it('is idempotent: a second call returns zeros', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedProgress(test.db);

    const engines = new EngineStore(test.db);
    try {
      await deleteAccountProgress(test.db, engines, 'u1');
      const second = await deleteAccountProgress(test.db, engines, 'u1');
      expect(second).toEqual({ materialsReset: 0, eventsDeleted: 0, graduationsDeleted: 0 });
    } finally {
      engines.clear();
    }
  });
});
```

* [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @verse-vault/api exec vitest run src/lib/reset.test.ts` Expected: FAIL —
`Cannot find module './reset.js'` (the helper doesn't exist yet).

* [ ] **Step 3: Write the helper**

Create `packages/api/src/lib/reset.ts`:

```ts
import { and, eq } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

import { EngineStore } from './engine.js';

export interface ProgressDeletionSummary {
  /** Enrolled materials that actually had rows removed. */
  materialsReset: number;
  /** Total `review_events` rows removed across all materials. */
  eventsDeleted: number;
  /** `graduated_verses` + `graduated_cards` rows removed. */
  graduationsDeleted: number;
}

/**
 * Wipe a user's learning state — review events, graduations, and the
 * derived test_states — across every material they're enrolled in.
 * Enrollment (`user_materials`), per-year settings, and the content
 * snapshot are deliberately kept: decks stay in the user's list, reset
 * to all-new. Each material is cleared under the engine's per-key lock
 * (mirroring import / rebuildFromEvents) so the delete can't race a
 * concurrent review POST, then the cached engine is invalidated so the
 * next load rebuilds from the now-empty event log.
 *
 * Idempotent: a second call finds nothing to delete and returns zeros.
 */
export async function deleteAccountProgress(
  db: DB,
  engines: EngineStore,
  userId: string,
): Promise<ProgressDeletionSummary> {
  const materials = db
    .select({ materialId: schema.userMaterials.materialId })
    .from(schema.userMaterials)
    .where(eq(schema.userMaterials.userId, userId))
    .all();

  let materialsReset = 0;
  let eventsDeleted = 0;
  let graduationsDeleted = 0;

  for (const { materialId } of materials) {
    const key = { userId, materialId };
    await engines.withLock(key, async () => {
      let materialChanges = 0;
      db.transaction((tx) => {
        const ev = tx
          .delete(schema.reviewEvents)
          .where(
            and(
              eq(schema.reviewEvents.userId, userId),
              eq(schema.reviewEvents.materialId, materialId),
            ),
          )
          .run();
        const gv = tx
          .delete(schema.graduatedVerses)
          .where(
            and(
              eq(schema.graduatedVerses.userId, userId),
              eq(schema.graduatedVerses.materialId, materialId),
            ),
          )
          .run();
        const gc = tx
          .delete(schema.graduatedCards)
          .where(
            and(
              eq(schema.graduatedCards.userId, userId),
              eq(schema.graduatedCards.materialId, materialId),
            ),
          )
          .run();
        const ts = tx
          .delete(schema.testStates)
          .where(
            and(
              eq(schema.testStates.userId, userId),
              eq(schema.testStates.materialId, materialId),
            ),
          )
          .run();
        eventsDeleted += ev.changes;
        graduationsDeleted += gv.changes + gc.changes;
        materialChanges = ev.changes + gv.changes + gc.changes + ts.changes;
      });
      // Only count + invalidate when something was actually removed, so a
      // re-run is a clean all-zeros no-op and we don't evict engines for
      // nothing.
      if (materialChanges > 0) {
        materialsReset += 1;
        engines.invalidate(key);
      }
    });
  }

  return { materialsReset, eventsDeleted, graduationsDeleted };
}
```

* [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @verse-vault/api exec vitest run src/lib/reset.test.ts` Expected: PASS (2
tests).

* [ ] **Step 5: Type-check**

Run: `pnpm --filter @verse-vault/api run type-check` Expected: no output, exit 0.

* [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/reset.ts packages/api/src/lib/reset.test.ts
git commit -m "feat(api): deleteAccountProgress helper"
```

---

## Task 2: Server — `DELETE /api/account/progress` route

**Files:**

* Modify: `packages/api/src/routes/account.ts`
* Test: `packages/api/src/routes/account.test.ts`

* [ ] **Step 1: Write the failing route tests**

Append these to the existing `describe('account routes', ...)` block in
`packages/api/src/routes/account.test.ts` (before its closing `});`). They reuse the file's existing
`enroll` helper (sign up + `seedUserWithFixture`) and imports (`createTestApp`, `signUpTestUser`).
No new imports are needed — the two tests below don't reference `schema` directly:

```ts
  it('DELETE /api/account/progress requires auth', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const res = await test.app.request('/api/account/progress', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('wipes progress but keeps the enrolled material', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'reset@example.com');

    const res = await test.app.request('/api/account/progress', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as {
      materialsReset: number;
      eventsDeleted: number;
      graduationsDeleted: number;
    };
    expect(summary.materialsReset).toBeGreaterThanOrEqual(0);

    // The deck is still enrolled after a reset.
    const exportRes = await test.app.request('/api/export', { headers: { cookie } });
    const payload = (await exportRes.json()) as {
      materials: { materialId: string; reviewEvents: unknown[] }[];
    };
    expect(payload.materials).toHaveLength(1);
    expect(payload.materials[0]!.reviewEvents).toHaveLength(0);
  });
```

* [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @verse-vault/api exec vitest run src/routes/account.test.ts` Expected: FAIL —
the DELETE returns 404 (route not mounted), so the 200/401 assertions fail.

* [ ] **Step 3: Add the route**

In `packages/api/src/routes/account.ts`, add the import alongside the existing `../lib/*` imports:

```ts
import { deleteAccountProgress } from '../lib/reset.js';
```

Then inside `accountRoutes`, after the `app.post('/import', ...)` block and before `return app;`,
add:

```ts
app.delete('/account/progress', async (c) => {
  const user = getUser(c);
  const summary = await deleteAccountProgress(deps.db, deps.engines, user.id);
  return c.json(summary);
});
```

(`requireAuth()` already applies via the `app.use('*', requireAuth())` at the top of
`accountRoutes`. The app is mounted at `/api` in `app.ts`, so this route resolves to
`/api/account/progress`. `getUser` is already imported in this file.)

* [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @verse-vault/api exec vitest run src/routes/account.test.ts` Expected: PASS
(existing tests + the 2 new ones).

* [ ] **Step 5: Full server suite + type-check**

Run: `pnpm --filter @verse-vault/api exec vitest run` Expected: all pass. Run:
`pnpm --filter @verse-vault/api run type-check` Expected: exit 0.

* [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/account.ts packages/api/src/routes/account.test.ts
git commit -m "feat(api): DELETE /api/account/progress route"
```

---

## Task 3: Web — api client methods + types

**Files:**

* Modify: `apps/web/src/api.ts`

* [ ] **Step 1: Add the wire types**

In `apps/web/src/api.ts`, after the existing `YearsResponse` interface (anywhere in the type section
is fine), add:

```ts
/** Full account export payload. Opaque to the web — it's downloaded and
 *  re-uploaded verbatim; the server owns the shape + validation. */
export type AccountExport = Record<string, unknown>;

/** Result of POST /api/import — mirrors the server's ImportSummary. */
export interface ImportSummary {
  materialsApplied: number
  eventsInserted: number
  eventsSkipped: number
  graduationsApplied: number
  unresolvedCardRefs: number
}

/** Result of DELETE /api/account/progress. */
export interface ProgressDeletionSummary {
  materialsReset: number
  eventsDeleted: number
  graduationsDeleted: number
}
```

* [ ] **Step 2: Widen the request method union + add interface methods**

In the private `request` signature inside `createApiClient`, change:

```ts
method: 'GET' | 'POST' | 'PATCH',
```

to:

```ts
method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
```

In the `ApiClient` interface, add these three members (e.g. after `getMaterialRenders`):

```ts
/** Full account data dump for download (GET /api/export). */
exportAccount(): Promise<AccountExport>
/** Layer an export payload onto the account (POST /api/import). */
importAccount(payload: unknown): Promise<ImportSummary>
/** Wipe all review history / graduations across decks; keeps
 *  enrollments + settings (DELETE /api/account/progress). */
deleteAllProgress(): Promise<ProgressDeletionSummary>
```

* [ ] **Step 3: Implement the methods in the factory return**

In the object returned by `createApiClient`, after `getMaterialRenders: ...,` add:

```ts
exportAccount: () => request('GET', '/api/export'),
importAccount: (payload) => request('POST', '/api/import', payload),
deleteAllProgress: () => request('DELETE', '/api/account/progress'),
```

* [ ] **Step 4: Type-check**

Run: `pnpm --filter @verse-vault/web run type-check` Expected: exit 0. (If it complains about
`verse-vault-wasm` types, run `pnpm --filter @verse-vault/web run build:wasm:dev` once, then
re-run.)

* [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts
git commit -m "feat(web): account export/import/reset api methods"
```

---

## Task 4: Web — file-I/O helpers

**Files:**

* Create: `apps/web/src/lib/account-file.ts`

* [ ] **Step 1: Write the helpers**

Create `apps/web/src/lib/account-file.ts`:

```ts
/**
 * Browser file-I/O for account export/import. Kept framework-free so
 * it's testable in isolation if a web test harness is added later.
 */

/** Trigger a download of `data` as a pretty-printed JSON file. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Read a user-picked file as JSON. Rejects on malformed JSON — the
 *  caller surfaces the error before any network call. */
export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text()
  return JSON.parse(text)
}

/** `verse-vault-export-<email>-<YYYY-MM-DD>.json`, with the email
 *  sanitised to filename-safe characters. */
export function exportFilename(email: string, isoDate: string): string {
  const safeEmail = email.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `verse-vault-export-${safeEmail}-${isoDate}.json`
}
```

* [ ] **Step 2: Type-check**

Run: `pnpm --filter @verse-vault/web run type-check` Expected: exit 0.

* [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/account-file.ts
git commit -m "feat(web): account-file download/read helpers"
```

---

## Task 5: Web — import result dialog

**Files:**

* Create: `apps/web/src/components/ImportResultDialog.vue`

* [ ] **Step 1: Write the component**

Create `apps/web/src/components/ImportResultDialog.vue` (modeled on `ConfirmDialog.vue`'s
overlay/aria/style conventions; single "Done" action; renders either a summary or an error):

```vue
<script setup lang="ts">
import { useId } from 'vue'

import type { ImportSummary } from '@/api'

defineProps<{
  /** The import summary on success, or null when `error` is set. */
  summary: ImportSummary | null
  /** A human-readable error message when the import failed. */
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const titleId = useId()
</script>

<template>
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    @click.self="emit('close')"
  >
    <div class="modal">
      <h2 :id="titleId">{{ error ? 'Import failed' : 'Import complete' }}</h2>
      <div class="body">
        <p v-if="error" class="error">{{ error }}</p>
        <ul v-else-if="summary" class="summary">
          <li><span>Materials applied</span><strong>{{ summary.materialsApplied }}</strong></li>
          <li><span>Events imported</span><strong>{{ summary.eventsInserted }}</strong></li>
          <li><span>Events skipped (already present)</span><strong>{{ summary.eventsSkipped }}</strong></li>
          <li><span>Graduations applied</span><strong>{{ summary.graduationsApplied }}</strong></li>
          <li><span>Unresolved cards (dropped)</span><strong>{{ summary.unresolvedCardRefs }}</strong></li>
        </ul>
      </div>
      <div class="actions">
        <button type="button" class="btn confirm" @click="emit('close')">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}

.modal {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  max-width: 440px;
  width: 100%;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.modal h2 {
  font-size: 1.1rem;
  margin: 0;
}

.body {
  color: var(--color-muted);
  line-height: 1.5;
}

.error {
  margin: 0;
  color: var(--color-grade-again);
}

.summary {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.summary li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.summary strong {
  color: var(--color-text);
}

.actions {
  display: flex;
  justify-content: flex-end;
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-weight: 500;
  font-size: 0.95rem;
  border: 1px solid transparent;
  font-family: inherit;
  cursor: pointer;
}

.confirm {
  background: var(--color-accent);
  color: var(--color-on-accent);
}
</style>
```

* [ ] **Step 2: Type-check**

Run: `pnpm --filter @verse-vault/web run type-check` Expected: exit 0.

* [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ImportResultDialog.vue
git commit -m "feat(web): import result dialog"
```

---

## Task 6: Web — type-to-confirm dialog

**Files:**

* Create: `apps/web/src/components/TypeToConfirmDialog.vue`

* [ ] **Step 1: Write the component**

Create `apps/web/src/components/TypeToConfirmDialog.vue` — generalises `ConfirmDialog` with a text
input the user must match before the destructive confirm enables. The warning body (and any extra
controls like a backup button) come from the default slot:

```vue
<script setup lang="ts">
import { ref, useId } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    confirmLabel?: string
    cancelLabel?: string
    /** The exact string the user must type to enable confirm. */
    matchText: string
    busy?: boolean
  }>(),
  {
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    busy: false,
  },
)

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const typed = ref('')
const titleId = useId()
const inputId = useId()

const matched = () => typed.value.trim() === props.matchText
</script>

<template>
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    @click.self="emit('cancel')"
  >
    <div class="modal">
      <h2 :id="titleId">{{ title }}</h2>
      <div class="body">
        <slot />
        <label :for="inputId" class="match-label">
          Type <code>{{ matchText }}</code> to confirm
        </label>
        <input
          :id="inputId"
          v-model="typed"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="match-input"
        />
      </div>
      <div class="actions">
        <button type="button" class="btn cancel" :disabled="busy" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="btn confirm destructive"
          :disabled="busy || !matched()"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}

.modal {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  max-width: 440px;
  width: 100%;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.modal h2 {
  font-size: 1.1rem;
  margin: 0;
}

.body {
  color: var(--color-muted);
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.match-label {
  font-size: 0.85rem;
}

.match-label code {
  color: var(--color-text);
  font-family: monospace;
}

.match-input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 0.9rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-weight: 500;
  font-size: 0.95rem;
  border: 1px solid transparent;
  font-family: inherit;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cancel {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-muted);
}

.confirm.destructive {
  background: var(--color-grade-again-bg);
  color: var(--color-grade-again);
}
</style>
```

* [ ] **Step 2: Type-check**

Run: `pnpm --filter @verse-vault/web run type-check` Expected: exit 0.

* [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/TypeToConfirmDialog.vue
git commit -m "feat(web): type-to-confirm dialog"
```

---

## Task 7: Web — profile card kebab items

**Files:**

* Modify: `apps/web/src/components/ProfileCard.vue`

* [ ] **Step 1: Add the emits**

In `apps/web/src/components/ProfileCard.vue`, extend `defineEmits` (currently `enter` / `reauth` /
`sign-out` / `delete`) to add three members:

```ts
const emit = defineEmits<{
  /** Clicked a signed-in card — swap workspace to this profile. */
  (e: 'enter'): void
  /** Clicked a signed-out card — re-auth required to use it. */
  (e: 'reauth'): void
  (e: 'sign-out'): void
  (e: 'export'): void
  (e: 'import'): void
  (e: 'delete-progress'): void
  (e: 'delete'): void
}>()
```

* [ ] **Step 2: Add the click handlers**

After the existing `onSignOutClick` function, add three handlers following the same
`stopPropagation` + `closeMenu` + `emit` pattern:

```ts
function onExportClick(ev: Event) {
  ev.stopPropagation()
  closeMenu()
  emit('export')
}

function onImportClick(ev: Event) {
  ev.stopPropagation()
  closeMenu()
  emit('import')
}

function onDeleteProgressClick(ev: Event) {
  ev.stopPropagation()
  closeMenu()
  emit('delete-progress')
}
```

* [ ] **Step 3: Add the menu items**

In the template's `<div v-if="menuOpen" class="menu" role="menu">`, the order is Export, Import,
Sign out, Delete all progress, Delete profile. Replace the menu's inner buttons with:

```vue
<button
  v-if="signedIn"
  type="button"
  class="menu-item"
  role="menuitem"
  @click="onExportClick"
>
  Export my data
</button>
<button
  v-if="signedIn"
  type="button"
  class="menu-item"
  role="menuitem"
  @click="onImportClick"
>
  Import data
</button>
<button
  v-if="signedIn"
  type="button"
  class="menu-item"
  role="menuitem"
  @click="onSignOutClick"
>
  Sign out
</button>
<button
  v-if="signedIn"
  type="button"
  class="menu-item destructive"
  role="menuitem"
  @click="onDeleteProgressClick"
>
  Delete all progress
</button>
<button
  type="button"
  class="menu-item destructive"
  role="menuitem"
  @click="onDeleteClick"
>
  Delete profile
</button>
```

(No CSS change — `.menu-item` / `.menu-item.destructive` already exist.)

* [ ] **Step 4: Type-check**

Run: `pnpm --filter @verse-vault/web run type-check` Expected: exit 0.

* [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ProfileCard.vue
git commit -m "feat(web): export/import/reset kebab items"
```

---

## Task 8: Web — picker orchestration

**Files:**

* Modify: `apps/web/src/views/ProfilePickerView.vue`

* [ ] **Step 1: Extend the script imports + state**

In `apps/web/src/views/ProfilePickerView.vue`, update the imports at the top of `<script setup>`:

```ts
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
```

After the existing `pendingDelete` / `deleteBusy` refs, add the new state:

```ts
const banner = ref<string | null>(null)

const fileInput = ref<HTMLInputElement | null>(null)
const pendingImport = ref<{ profile: ProfileRow; payload: unknown } | null>(null)
const importBusy = ref(false)
const importResult = ref<{ summary: ImportSummary | null; error: string | null } | null>(null)

const pendingDeleteProgress = ref<ProfileRow | null>(null)
const deleteProgressBusy = ref(false)
```

* [ ] **Step 2: Add the switch-first + export helpers**

After `onCardSignOut`, add the shared helpers + export flow:

```ts
/** Make `profile`'s session active (no-op if it already is). Returns
 *  false and routes to the reauth form when the token is dead. */
async function switchTo(profile: ProfileRow): Promise<boolean> {
  if (activeProfile.value?.profileId === profile.profileId) return true
  const result = await enterProfile(profile.profileId)
  if (result.ok) return true
  prefillEmail.value = profile.email
  mode.value = 'add'
  return false
}

/** Download the active account's full export. Shared by the kebab
 *  Export item and the backup button inside the delete dialog. */
async function exportActiveAccount() {
  const email = activeProfile.value?.email ?? 'account'
  const data = await api.exportAccount()
  const isoDate = new Date().toISOString().slice(0, 10)
  downloadJson(exportFilename(email, isoDate), data)
}

async function onCardExport(profile: ProfileRow) {
  banner.value = null
  if (!(await switchTo(profile))) return
  try {
    await exportActiveAccount()
  } catch (err) {
    banner.value = err instanceof ApiError ? err.message : 'Export failed.'
  }
}

async function onBackupClick() {
  banner.value = null
  try {
    await exportActiveAccount()
  } catch (err) {
    banner.value = err instanceof ApiError ? err.message : 'Backup download failed.'
  }
}
```

* [ ] **Step 3: Add the import flow**

After the export helpers, add:

```ts
async function onCardImport(profile: ProfileRow) {
  banner.value = null
  if (!(await switchTo(profile))) return
  // Stash the target so the file-input change handler knows which
  // account it's importing into, then open the OS file picker.
  pendingImport.value = { profile, payload: null }
  fileInput.value?.click()
}

async function onFilePicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // allow re-picking the same file later
  if (!file || !pendingImport.value) return
  try {
    const payload = await readJsonFile(file)
    pendingImport.value = { ...pendingImport.value, payload }
  } catch {
    pendingImport.value = null
    importResult.value = { summary: null, error: 'That file isn’t valid JSON.' }
  }
}

function cancelImport() {
  pendingImport.value = null
}

async function confirmImport() {
  const target = pendingImport.value
  if (!target || target.payload === null) return
  importBusy.value = true
  try {
    const summary = await api.importAccount(target.payload)
    importResult.value = { summary, error: null }
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Import failed.'
    importResult.value = { summary: null, error: message }
  } finally {
    importBusy.value = false
    pendingImport.value = null
  }
}

function closeImportResult() {
  importResult.value = null
}
```

* [ ] **Step 4: Add the delete-progress flow**

After the import flow, add:

```ts
function requestDeleteProgress(profile: ProfileRow) {
  pendingDeleteProgress.value = profile
}

function cancelDeleteProgress() {
  pendingDeleteProgress.value = null
}

async function onCardDeleteProgress(profile: ProfileRow) {
  banner.value = null
  if (!(await switchTo(profile))) return
  requestDeleteProgress(profile)
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
```

* [ ] **Step 5: Wire the template**

On the `<ProfileCard>` element, add the three new event bindings alongside the existing ones:

```vue
@export="onCardExport(p)"
@import="onCardImport(p)"
@delete-progress="onCardDeleteProgress(p)"
```

Add a status banner just under the `<h2>`s (inside `.picker`, before the `mode === 'cards'`
template):

```vue
<p v-if="banner" class="banner">{{ banner }}</p>
```

Add the hidden file input, the import confirm dialog, the import result dialog, and the
delete-progress dialog before the closing `</div>` of `.picker` (the existing delete-profile
`<ConfirmDialog>` stays):

```vue
    <input
      ref="fileInput"
      type="file"
      accept="application/json"
      class="hidden-file"
      @change="onFilePicked"
    />

    <ConfirmDialog
      v-if="pendingImport && pendingImport.payload !== null"
      title="Import data?"
      confirm-label="Import"
      :busy="importBusy"
      @confirm="confirmImport"
      @cancel="cancelImport"
    >
      <p>
        Import data into <strong>{{ pendingImport.profile.email }}</strong>?
        This adds review history and graduations from the file. Existing
        data is kept, and re-importing the same file is safe.
      </p>
    </ConfirmDialog>

    <ImportResultDialog
      v-if="importResult"
      :summary="importResult.summary"
      :error="importResult.error"
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
```

Add the styles to the component's `<style scoped>` block:

```css
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
```

* [ ] **Step 6: Type-check**

Run: `pnpm --filter @verse-vault/web run type-check` Expected: exit 0.

* [ ] **Step 7: Commit**

```bash
git add apps/web/src/views/ProfilePickerView.vue
git commit -m "feat(web): wire export/import/reset on picker"
```

---

## Task 9: Docs + version bumps + changelogs

**Files:**

* Modify: `docs/server-api.md`
* Modify: `packages/api/package.json`, `packages/api/CHANGELOG.md`
* Modify: `apps/web/package.json`, `apps/web/CHANGELOG.md`

* [ ] **Step 1: Document the endpoint**

In `docs/server-api.md`, find the section listing account routes (the `GET /api/export` /
`POST /api/import` entries added in the prior PR — if they're missing, add them too). Add an entry:

```markdown
### `DELETE /api/account/progress`

Auth required. Wipes the caller's learning state — review events, graduations, and derived test
states — across every enrolled material. Keeps enrollments, per-year settings, and the content
snapshot (decks stay, reset to all-new). Idempotent. Returns
`{ materialsReset, eventsDeleted, graduationsDeleted }`.
```

* [ ] **Step 2: Bump the API version + changelog**

In `packages/api/package.json`, change `"version": "0.1.25"` to `"version": "0.1.26"`.

In `packages/api/CHANGELOG.md`, under `## [Unreleased]`, add a new dated section (today is
2026-05-29):

```markdown
## [0.1.26] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Account progress reset endpoint

* **`DELETE /api/account/progress`** — wipes the caller's review events, graduations, and derived
  test states across every enrolled material, under the engine's per-key lock; keeps enrollments +
  per-year settings + the content snapshot. Idempotent; returns
  `{ materialsReset, eventsDeleted, graduationsDeleted }`. Backs the web "Delete all progress"
  action. Logic in `lib/reset.ts`, route in `routes/account.ts`.

Bundled algorithm contract unchanged. No wire-format break.
```

* [ ] **Step 3: Bump the web version + changelog**

In `apps/web/package.json`, change `"version": "0.1.19"` to `"version": "0.1.20"`.

In `apps/web/CHANGELOG.md`, under `## [Unreleased]`, add a new dated section. Mirror the existing
entries' shape — keep the `### Bundled algorithm contract` subsection carrying
`verse-vault-core@0.5.0` / `verse-vault-wasm@0.5.0` forward unchanged:

```markdown
## [0.1.20] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Account data management on the profile card

* The profile card kebab menu gains **Export my data**, **Import data**, and **Delete all progress**
  (all gated on a signed-in card). Each switches the active session to that profile first
  (`enterProfile`).
* **Export** downloads the account as `verse-vault-export-<email>-<date>.json`.
* **Import** picks a JSON file, confirms (neutral — import is additive and idempotent), and shows
  the server's summary (events inserted/skipped, graduations, unresolved cards).
* **Delete all progress** is gated behind a type-the-email confirmation and offers a one-click
  backup download inside the dialog. It wipes review history and graduations across all decks but
  keeps the decks + settings.
* New: `lib/account-file.ts` (download/read helpers), `ImportResultDialog.vue`,
  `TypeToConfirmDialog.vue`; `api.ts` gains `exportAccount` / `importAccount` / `deleteAllProgress`.
```

* [ ] **Step 4: Verify the contract-version check passes**

Run: `tools/check-contract-versions.sh` Expected: no output, exit 0 (both bumped packages now have
matching dated changelog sections).

* [ ] **Step 5: Commit**

```bash
git add docs/server-api.md packages/api/package.json packages/api/CHANGELOG.md apps/web/package.json apps/web/CHANGELOG.md
git commit -m "chore: release api 0.1.26 + web 0.1.20"
```

---

## Task 10: Final verification

**Files:** none (verification only)

* [ ] **Step 1: Full server suite**

Run: `pnpm --filter @verse-vault/api exec vitest run` Expected: all pass (includes the new
`reset.test.ts` + `account.test.ts` cases).

* [ ] **Step 2: Both type-checks**

Run: `pnpm --filter @verse-vault/api run type-check` Run:
`pnpm --filter @verse-vault/web run type-check` Expected: both exit 0.

* [ ] **Step 3: Manual smoke (dev server)**

Start the API + web dev servers, sign in with a profile that has review history, then on
`/profiles`:

* Kebab → **Export my data**: a `verse-vault-export-<email>-<date>.json` file downloads; open it and
  confirm it has `materials[].reviewEvents`.
* Kebab → **Import data**: pick that file → confirm → the result dialog shows a summary (on a fresh
  re-import, `eventsSkipped` equals the event count and `eventsInserted` is 0 — idempotent).
* Kebab → **Delete all progress**: the confirm button stays disabled until the email is typed
  exactly; click **Download a backup** and confirm it downloads; confirm the delete → banner reports
  the reset counts; re-enter the profile and confirm decks are still listed but progress is reset.
* On a non-active signed-in card, confirm the action switches to that profile first (its card
  becomes the active one).

* [ ] **Step 4: Done**

All tasks complete. Open the PR per the repo's PR conventions (feature branch
`feat/account-data-management`, one PR, conventional-commit merge subject).

---

## Notes for the implementer

* **TDD applies to the server only.** The web app has no test harness (repo convention); web tasks
  are type-checked and manually verified. Don't scaffold a web test framework — out of scope.
* **`enterProfile` is the switch primitive** (`useAuth.ts`): it calls `multiSession.setActive`,
  returns `{ ok: false }` only when reauth is needed. The kebab items are gated on `signedIn`, so
  `switchTo` returning false is the rare token-died-mid-session case — it routes to the sign-in form
  and aborts.
* **The import payload is opaque to the web.** Don't validate its shape client-side; the server
  returns 400 (bad version / unknown material / invalid settings) or 413 (>50 MB), surfaced via
  `ApiError.message` in the result dialog.
* **Delete keeps decks + settings** by design — only `review_events`, `graduated_verses`,
  `graduated_cards`, `test_states` are removed. Don't touch `user_materials`, `user_year_settings`,
  or `graph_snapshots`.
* **`matched()` is called as a function** in `TypeToConfirmDialog`'s `:disabled` binding
  (re-evaluates on `typed` change via the reactive `v-model`); keep it that way rather than a
  `computed` only if you mirror this exactly — a
  `computed(() => typed.value.trim() === props.matchText)` is equally fine and slightly cleaner if
  you prefer.
