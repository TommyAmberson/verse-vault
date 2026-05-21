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

export interface CardRender {
  cardId: number
  verseId: number
  kind: CardKind
  position?: number
  headingIdx?: number
  tier?: 'Club150' | 'Club300'
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
  clubs: ('Club150' | 'Club300')[]
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

export interface StatsResponse {
  materialId: string
  versesLearned: number
  retentionRate: number | null
  totalGrades: number
  testDistribution: Record<'weak' | 'learning' | 'familiar' | 'strong' | 'mastered', number>
}

export type ClubStatus = 'active' | 'maintenance' | 'paused'
export type ClubTier = '150' | '300' | 'full'
export type TierScope = 'off' | 'up150' | 'up300' | 'all'
export type ChapterListScope = 'off' | 'up150' | 'up300'

export interface YearSettings {
  headings: boolean
  ftv: boolean
  newScope: TierScope
  reviewScope: TierScope
  clubCardScope: TierScope
  chapterListScope: ChapterListScope
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
  settings: YearSettings
  clubs: Record<ClubTier, ClubView>
  /** Total `New` cards in the engine — drives the "N to memorize" pill. */
  newCardCount: number
}

export interface YearsResponse {
  years: YearView[]
}

export interface MemorizeSessionVerse {
  verseId: number
  /** Every per-verse card to drill, in builder order. */
  cardIds: number[]
  /** Card id of the verse's Recitation, when emitted. Used as the
   *  anchor render for the session-opening + closing walkthroughs so
   *  the verse displays without a PhraseFill's phrase-0 highlight. */
  recitationCardId: number | null
}

export interface MemorizeSessionResponse {
  verses: MemorizeSessionVerse[]
}

export interface ApiClient {
  enroll(materialId: string): Promise<{ snapshotId: string; version: number }>
  getNextReviewCard(materialId: string): Promise<{ cardId: number | null }>
  getMemorizeSession(materialId: string, max: number): Promise<MemorizeSessionResponse>
  graduateVerse(materialId: string, verseId: number): Promise<{ graduated: number }>
  getCardRender(materialId: string, cardId: number): Promise<CardRender>
  submitReview(materialId: string, cardId: number, grade: Grade): Promise<ReviewResponse>
  getStats(materialId: string): Promise<StatsResponse>
  getYears(): Promise<YearsResponse>
  updateYearSettings(materialId: string, settings: Partial<YearSettings>): Promise<{ settings: YearSettings }>
  /** Fat-client sync: snapshot + materialised test states + last
   *  applied event id. Mirrors `/sync/:materialId/state` on the API. */
  getSyncState(materialId: string): Promise<SyncStateResponse>
  /** Fat-client sync: batch-upload queued events. The server applies
   *  them, possibly triggering a full-log rebuild (`rebuilt: true`) or
   *  returning a `needsConfirm` envelope for stale-merge UX. */
  postSyncEvents(materialId: string, body: SyncEventsRequest): Promise<SyncEventsResponse>
}

/** Build an API client targeting `apiUrl`. Sends `credentials: 'include'`
 *  so the Better Auth session cookie flows through on every call. */
export function createApiClient(apiUrl: string): ApiClient {
  async function request<T>(
    method: 'GET' | 'POST',
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
    getCardRender: (materialId, cardId) =>
      request('GET', `/api/cards/${cardId}?materialId=${encodeURIComponent(materialId)}`),
    submitReview: (materialId, cardId, grade) =>
      request('POST', '/api/cards/review', { materialId, cardId, grade }),
    getStats: (materialId) =>
      request('GET', `/api/stats/${encodeURIComponent(materialId)}`),
    getYears: () => request('GET', '/api/years'),
    updateYearSettings: (materialId, settings) =>
      request('POST', `/api/years/${encodeURIComponent(materialId)}/settings`, settings),
    getSyncState: (materialId) =>
      request('GET', `/api/sync/${encodeURIComponent(materialId)}/state`),
    postSyncEvents: (materialId, body) =>
      request('POST', `/api/sync/${encodeURIComponent(materialId)}/events`, body),
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
