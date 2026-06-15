/**
 * Typed fetch wrapper for the verse-vault Hono API. Mirrors the
 * `createApiClient` factory pattern from `~/Code/qzr-sheet`. All endpoints
 * require an authenticated user; the Better Auth session cookie flows
 * through `credentials: 'include'`.
 */

import type {
  SyncEventsRequest,
  SyncEventsResponse,
  SyncStateResponse,
} from './lib/engine/types'

export type Grade = 1 | 2 | 3 | 4

/** Wire-format tier string on a `CardRender` (`Club150` / `Club300`).
 *  Distinct from `ClubTier` in settings, which uses the bare numeric
 *  form (`'150'` / `'300'`). */
export type CardTier = 'Club150' | 'Club300'

/** User-facing label for a card's tier — used by every render site
 *  that shows a tier to avoid drift across components. */
export function formatCardTier(tier: CardTier | undefined): string {
  if (tier === 'Club150') return 'Club 150'
  if (tier === 'Club300') return 'Club 300'
  return ''
}

export interface CardRender {
  cardId: number
  verseId: number
  kind: CardKind
  position?: number
  headingIdx?: number
  tier?: CardTier
  withCitation?: boolean
  verse: VerseRender
  /** Server-composed HTML from the api.bible cache layered with user
   *  annotations. `null` when the cache is unavailable (e.g. BIBLE_API_KEY
   *  unset on the server). */
  composed: ComposedRender | null
}

export interface ComposedRender {
  phraseHtml: string[]
  ftvHtml: string | null
  headings: { headingIdx: number; title: string | null }[]
}

export type CardKind =
  | 'PhraseFill'
  | 'VerseAtVerseRef'
  | 'VerseInChapter'
  | 'VerseInBook'
  | 'VerseInHeading'
  | 'VerseInClub'
  | 'Recitation'
  | 'Citation'
  | 'Ftv'
  | 'ChapterClubList'
  | 'HeadingPassage'
  | 'Reading'

export interface VerseRender {
  book: string
  chapter: number
  verse: number
  phraseWordCounts: number[]
  annotations: { wordIndex: number; kind: 'bold' | 'italic' | 'boldItalic' }[]
  ftvWordCount: number | null
  headings: {
    headingIdx: number
    startChapter: number
    startVerse: number
    endChapter: number
    endVerse: number
  }[]
  clubs: CardTier[]
  /** Verse numbers on a `ChapterClubList` pseudo-verse — the chapter's
   *  tier members the card asks about. Empty elsewhere. */
  chapterMembers: number[]
}

export interface TestUpdate {
  key: { kind: string; element: unknown }
  kind: 'Root' | 'Sub'
  before: TestState
  after: TestState
}

export interface TestState {
  stability: number
  difficulty: number
  last_seen_secs: number
  last_base_secs: number
  last_root_secs: number
  pending_relearn: boolean
}

export interface ReviewResponse {
  updates: TestUpdate[]
  nextCardId: number | null
}

export type StabilityBucket = 'weak' | 'learning' | 'familiar' | 'strong' | 'mastered'
export type StabilityHistogram = Record<StabilityBucket, number>

export interface ActivityDay {
  /** `YYYY-MM-DD` in UTC. */
  date: string
  count: number
}

export interface ActivityResponse {
  /** Per-day review grade events. Sparse. */
  reviews: ActivityDay[]
  /** Per-day verse graduations — the "memorize" series. Sparse. */
  memorize: ActivityDay[]
  /** Echoed; server clamps to `[1, 1825]`. */
  requestedDays: number
}

export interface StatsResponse {
  materialId: string
  versesLearned: number
  retentionRate: number | null
  totalGrades: number
  /** Per active card, bucketed by its weakest test's stability —
   *  matches the engine's own due-ness aggregation. Engine-derived
   *  via `WasmEngine.card_stability_histogram`. */
  cardDistribution: StabilityHistogram
  /** Per graduated verse, bucketed by the verse's weakest test's
   *  stability (`MIN(stability) GROUP BY verse_id`). Same boundaries
   *  as `cardDistribution`. */
  verseDistribution: StabilityHistogram
  /** Count of active cards whose retrievability is below the engine's
   *  target — the "reviews waiting" queue size. Server-computed from
   *  the engine. */
  reviewsDueCount: number
  /** Count of distinct verses with at least one `New` card —
   *  pairs with the memorize-queue card count. Pseudo verses
   *  anchoring multi-verse cards are excluded. */
  newVerseCount: number
  /** Count of distinct verses with at least one due card — pairs
   *  with `reviewsDueCount`. Pseudo verses excluded. */
  versesDueCount: number
}

export type ClubStatus = 'active' | 'maintenance' | 'paused'
export type ClubTier = '150' | '300' | 'full'
export type TierScope = 'off' | 'up150' | 'up300' | 'all'
export type ChapterListScope = 'off' | 'up150' | 'up300'

export interface YearSettings {
  headingCard: boolean
  headingPassageCard: boolean
  ftv: boolean
  newScope: TierScope
  reviewScope: TierScope
  clubCardScope: TierScope
  chapterListScope: ChapterListScope
  lessonBatchSize: number
  /** Legacy FSRS target retention. Pre-Phase-1 clients honoured this
   *  as the per-material slider. As of Phase 1 it survives only as a
   *  mirror for backward compat — the engine reads per-club retention
   *  from `configJson.review.{club}.desiredRetention`. */
  desiredRetention: number
}

// === Phase 1+ per-club shape ===============================================
//
// Mirrors `crates/core::material_config::MaterialConfig`'s JSON wire form and
// the API's `PerClubYearSettings` (`packages/api/src/lib/year-settings.ts`).
// The `POST /api/years/:materialId/settings` route accepts EITHER this shape
// or the legacy flat `YearSettings`; per-club is required complete (no
// partial-merge), legacy keeps its existing partial-merge semantics.

export type Club = 'club150' | 'club300' | 'full'
export type CatchUp = 'sequential' | 'calendarCascade'
export type MoveToNextGate =
  | 'fullyMemorized'
  | 'afterMajorCheckpoint'
  | 'afterMinorCheckpoint'
  | 'caughtUp'
  | 'always'

export interface ClubMemorizeConfig {
  enabled: boolean
  catchUp: CatchUp
}

export interface ClubReviewConfig {
  enabled: boolean
  /** Valid range `[0.5, 0.9]`. The engine clamps on read for defence-
   *  in-depth; the API rejects out-of-range values at the boundary. */
  desiredRetention: number
}

export interface ClubMemorizeMap {
  club150: ClubMemorizeConfig
  club300: ClubMemorizeConfig
  full: ClubMemorizeConfig
}

export interface ClubReviewMap {
  club150: ClubReviewConfig
  club300: ClubReviewConfig
  full: ClubReviewConfig
}

export interface MoveToNextConfig {
  p150To300: MoveToNextGate
  p300ToFull: MoveToNextGate
}

/** New per-club settings shape. The POST settings route accepts this
 *  as a complete body (every field required); the chain UI on the
 *  Phase 2 settings page builds + sends this directly. */
export interface PerClubYearSettings {
  headingCard: boolean
  headingPassageCard: boolean
  ftv: boolean
  clubCardScope: TierScope
  chapterListScope: ChapterListScope
  memorize: ClubMemorizeMap
  review: ClubReviewMap
  moveToNext: MoveToNextConfig
  lessonBatchSize: number
}

export interface ClubView {
  /** Derived from `activeScope` + `maintenanceScope`. The API returns
   *  it for display; the client doesn't write to it directly. */
  status: ClubStatus
  cardCount: number
}

export interface YearView {
  materialId: string
  title: string
  description: string
  /** True when the user has a graph_snapshot + user_materials row for
   *  this year. Bumping any scope above Off and saving will auto-enroll. */
  enrolled: boolean
  /** True when the user has opted into bulk-renders download for this
   *  year. Server returns false for unenrolled years. */
  offlineMode: boolean
  settings: YearSettings
  clubs: Record<ClubTier, ClubView>
  /** Total `New` cards in the engine — drives the "N to memorize" pill. */
  newCardCount: number
}

export interface YearsResponse {
  years: YearView[]
}

/** Full account export payload. Opaque to the web — it's downloaded and
 *  re-uploaded verbatim; the server owns the shape + validation. */
export type AccountExport = Record<string, unknown>

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

export interface MemorizeSessionVerse {
  verseId: number
  /** Verse-bound cards drilled with this verse, in builder order.
   *  HP / CCL surface separately via the slots below; orphans live
   *  at the top level of `MemorizeSessionResponse`. */
  cardIds: number[]
  /** Subset of `cardIds` that need an explicit `graduate_card` on
   *  step-3 verse graduation. `graduate_verse` already flips the
   *  rest. Omitted (treat as []) when the verse has no conditional
   *  kinds emitted. */
  conditionalCardIds?: number[]
  /** Recitation render — verse text without a PhraseFill's
   *  phrase-0 highlight. Null when the deck doesn't emit one. */
  recitationCardId: number | null
  /** HeadingPassage placed after this verse in the reading walkthrough. */
  hpCardId?: number
  /** ChapterClubList placed after this verse. */
  cclCardId?: number
}

export interface MemorizeSessionResponse {
  verses: MemorizeSessionVerse[]
  /** Standalone meta cards that don't anchor to a session-verse:
   *  HP/CCL overflow plus conditional verse-bound cards
   *  (Ftv / VerseInHeading / VerseInClub) on already-Active verses.
   *  Capped per kind at the year's `lessonBatchSize`. */
  orphans: number[]
}

export interface MaterialStatus {
  materialId: string
  clubTier: number | null
  offlineMode: boolean
  testCount: number
}

/** One row of the bulk `GET /materials/:id/renders` payload. Same
 *  shape as the single-card `GET /api/cards/:cardId` endpoint (full
 *  CardRender) plus a `fetchedAt` timestamp the client uses for the
 *  30-day TTL. The matching shape lets the client cache rows as-is
 *  in the same IDB `renders` store the lazy path writes to. */
export type MaterialRender = CardRender & { fetchedAt: number }

export interface ApiClient {
  enroll(materialId: string): Promise<{ snapshotId: string; version: number }>
  getNextReviewCard(materialId: string): Promise<{ cardId: number | null }>
  getMemorizeSession(materialId: string, max: number): Promise<MemorizeSessionResponse>
  graduateVerse(materialId: string, verseId: number): Promise<{ graduated: number }>
  graduateCard(materialId: string, cardId: number): Promise<{ graduated: boolean }>
  getCardRender(materialId: string, cardId: number): Promise<CardRender>
  submitReview(materialId: string, cardId: number, grade: Grade): Promise<ReviewResponse>
  getStats(materialId: string): Promise<StatsResponse>
  getActivity(days?: number): Promise<ActivityResponse>
  getYears(): Promise<YearsResponse>
  updateYearSettings(materialId: string, settings: Partial<YearSettings>): Promise<{ settings: YearSettings }>
  /** Phase 2 per-club POST. Sends the new shape; the API detects via
   *  the `looksLikePerClub` heuristic (presence of `memorize` or
   *  `review`) and validates every field. Returns the round-tripped
   *  legacy view (server collapses per-club → legacy YearSettings for
   *  the response). */
  updateYearSettingsPerClub(
    materialId: string,
    settings: PerClubYearSettings,
  ): Promise<{ settings: YearSettings }>
  /** GET /api/materials/:materialId/schedule — returns the user's
   *  customised schedule if present, else the bundled default, else
   *  `null` when no schedule ships for the material (memorize then
   *  collapses to pure-Sequential on the engine side). */
  getSchedule(materialId: string): Promise<unknown | null>
  /** PUT /api/materials/:materialId/schedule — upserts the user's copy.
   *  Server validates the body's shape AND cross-checks `materialId`. */
  putSchedule(materialId: string, schedule: unknown): Promise<{ ok: true }>
  /** DELETE /api/materials/:materialId/schedule — drops the user's
   *  override; bundled default reapplies on next read. */
  deleteSchedule(materialId: string): Promise<{ ok: true; fallbackToBundled: boolean }>
  /** Fat-client sync: snapshot + materialised test states + last
   *  applied event id. Mirrors `/sync/:materialId/state` on the API. */
  getSyncState(materialId: string): Promise<SyncStateResponse>
  /** Fat-client sync: batch-upload queued events. The server applies
   *  them, possibly triggering a full-log rebuild (`rebuilt: true`) or
   *  returning a `needsConfirm` envelope for stale-merge UX. */
  postSyncEvents(materialId: string, body: SyncEventsRequest): Promise<SyncEventsResponse>
  setOfflineMode(materialId: string, offlineMode: boolean): Promise<{ offlineMode: boolean }>
  /** Requires `offline_mode=true` on the server; returns 403 otherwise. */
  getMaterialRenders(materialId: string): Promise<{ renders: MaterialRender[] }>
  /** Full account data dump for download (GET /api/export). */
  exportAccount(): Promise<AccountExport>
  /** Layer an export payload onto the account (POST /api/import). */
  importAccount(payload: unknown): Promise<ImportSummary>
  /** Wipe all review history / graduations across decks; keeps
   *  enrollments + settings (DELETE /api/account/progress). */
  deleteAllProgress(): Promise<ProgressDeletionSummary>
}

/** Build an API client targeting `apiUrl`. Sends `credentials: 'include'`
 *  so the Better Auth session cookie flows through on every call. */
export function createApiClient(apiUrl: string): ApiClient {
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ApiError(res.status, text || res.statusText)
    }
    return res.json() as Promise<T>
  }

  return {
    enroll: (materialId) =>
      request('POST', '/api/materials/enroll', { materialId }),
    getNextReviewCard: (materialId) =>
      request('GET', `/api/cards/review/next?materialId=${encodeURIComponent(materialId)}`),
    getMemorizeSession: (materialId, max) =>
      request(
        'GET',
        `/api/cards/memorize/session?materialId=${encodeURIComponent(materialId)}&max=${max}`,
      ),
    graduateVerse: (materialId, verseId) =>
      request('POST', '/api/cards/memorize/graduate', { materialId, verseId }),
    graduateCard: (materialId, cardId) =>
      request('POST', '/api/cards/memorize/graduate-card', { materialId, cardId }),
    getCardRender: (materialId, cardId) =>
      request('GET', `/api/cards/${cardId}?materialId=${encodeURIComponent(materialId)}`),
    submitReview: (materialId, cardId, grade) =>
      request('POST', '/api/cards/review', { materialId, cardId, grade }),
    getStats: (materialId) =>
      request('GET', `/api/stats/${encodeURIComponent(materialId)}`),
    getActivity: (days = 365) =>
      request('GET', `/api/activity?days=${days}`),
    getYears: () => request('GET', '/api/years'),
    updateYearSettings: (materialId, settings) =>
      request('POST', `/api/years/${encodeURIComponent(materialId)}/settings`, settings),
    updateYearSettingsPerClub: (materialId, settings) =>
      request('POST', `/api/years/${encodeURIComponent(materialId)}/settings`, settings),
    getSchedule: async (materialId) => {
      // The GET route returns either the schedule JSON verbatim (with
      // content-type application/json) or `{ schedule: null }` when no
      // schedule ships for this material. Normalise both into a single
      // `unknown | null` for callers.
      const body = await request<unknown>(
        'GET',
        `/api/materials/${encodeURIComponent(materialId)}/schedule`,
      )
      if (
        body !== null
        && typeof body === 'object'
        && 'schedule' in body
        && (body as { schedule: unknown }).schedule === null
      ) {
        return null
      }
      return body
    },
    putSchedule: (materialId, schedule) =>
      request('PUT', `/api/materials/${encodeURIComponent(materialId)}/schedule`, schedule),
    deleteSchedule: (materialId) =>
      request('DELETE', `/api/materials/${encodeURIComponent(materialId)}/schedule`),
    getSyncState: (materialId) =>
      request('GET', `/api/sync/${encodeURIComponent(materialId)}/state`),
    postSyncEvents: (materialId, body) =>
      request('POST', `/api/sync/${encodeURIComponent(materialId)}/events`, body),
    setOfflineMode: (materialId, offlineMode) =>
      request('PATCH', `/api/materials/${encodeURIComponent(materialId)}/offline-mode`, {
        offlineMode,
      }),
    getMaterialRenders: (materialId) =>
      request('GET', `/api/materials/${encodeURIComponent(materialId)}/renders`),
    exportAccount: () => request('GET', '/api/export'),
    importAccount: (payload) => request('POST', '/api/import', payload),
    deleteAllProgress: () => request('DELETE', '/api/account/progress'),
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`API error ${status}: ${message}`)
    this.name = 'ApiError'
  }
}

/** Singleton instance configured against the Vite-injected API URL.
 *  Falls back to the local dev server when no override is provided.
 *
 *  `VITE_API_BASE` is an origin-relative subpath prefix that does NOT
 *  include `/api` (e.g. `/vv` when co-hosting under
 *  www.versevault.ca/vv/). Paths passed to `request()` start with `/api/`,
 *  so the final URL is `${VITE_API_BASE}/api/...`. `VITE_API_URL` is the
 *  legacy absolute-origin form, kept for any existing dev setups. */
export const api = createApiClient(
  import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
)
