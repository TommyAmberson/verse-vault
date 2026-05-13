/**
 * Typed fetch wrapper for the verse-vault Hono API. Mirrors the
 * `createApiClient` factory pattern from `~/Code/qzr-sheet`. All endpoints
 * require an authenticated user; the Better Auth session cookie flows
 * through `credentials: 'include'`.
 */

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

export interface YearSettings {
  headings: boolean
  ftv: boolean
  lessonBatchSize: number
}

export interface ClubView {
  status: ClubStatus
  clubCards: boolean
  chapterLists: boolean
  cardCount: number
}

export interface YearView {
  materialId: string
  settings: YearSettings
  clubs: Record<ClubTier, ClubView>
}

export interface ClubPatch {
  status?: ClubStatus
  clubCards?: boolean
  chapterLists?: boolean
}

export interface YearsResponse {
  years: YearView[]
}

export interface ApiClient {
  enroll(materialId: string): Promise<{ snapshotId: string; version: number }>
  getNextCard(materialId: string): Promise<{ cardId: number | null }>
  getCardRender(materialId: string, cardId: number): Promise<CardRender>
  submitReview(materialId: string, cardId: number, grade: Grade): Promise<ReviewResponse>
  getStats(materialId: string): Promise<StatsResponse>
  getYears(): Promise<YearsResponse>
  updateYearSettings(materialId: string, settings: Partial<YearSettings>): Promise<{ settings: YearSettings }>
  updateClub(
    materialId: string,
    tier: ClubTier,
    patch: ClubPatch,
  ): Promise<{
    tier: ClubTier
    status: ClubStatus
    clubCards: boolean
    chapterLists: boolean
  }>
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
    getNextCard: (materialId) =>
      request('GET', `/api/cards/next?materialId=${encodeURIComponent(materialId)}`),
    getCardRender: (materialId, cardId) =>
      request('GET', `/api/cards/${cardId}?materialId=${encodeURIComponent(materialId)}`),
    submitReview: (materialId, cardId, grade) =>
      request('POST', '/api/cards/review', { materialId, cardId, grade }),
    getStats: (materialId) =>
      request('GET', `/api/stats/${encodeURIComponent(materialId)}`),
    getYears: () => request('GET', '/api/years'),
    updateYearSettings: (materialId, settings) =>
      request('POST', `/api/years/${encodeURIComponent(materialId)}/settings`, settings),
    updateClub: (materialId, tier, patch) =>
      request('POST', `/api/years/${encodeURIComponent(materialId)}/clubs/${tier}`, patch),
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
 *  Falls back to the local dev server when no override is provided. */
export const api = createApiClient(import.meta.env.VITE_API_URL ?? 'http://localhost:3000')

/** Material id rendered in the thin client. Override with VITE_MATERIAL_ID. */
export const MATERIAL_ID = import.meta.env.VITE_MATERIAL_ID ?? 'nkjv-1cor'
