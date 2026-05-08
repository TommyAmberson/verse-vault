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
}

export type CardKind =
  | 'PhraseFill'
  | 'PhraseChain'
  | 'VerseAtVerseRef'
  | 'VerseInChapter'
  | 'VerseInBook'
  | 'VerseInHeading'
  | 'VerseInClub'
  | 'Recitation'
  | 'Citation'
  | 'Ftv'
  | 'Reading'

export interface VerseRender {
  book: string
  chapter: number
  verse: number
  text: string
  phrases: string[]
  ftv: string | null
  headings: { headingIdx: number; text: string }[]
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

export interface ApiClient {
  enroll(materialId: string): Promise<{ snapshotId: string; version: number }>
  getNextCard(materialId: string): Promise<{ cardId: number | null }>
  getCardRender(materialId: string, cardId: number): Promise<CardRender>
  submitReview(materialId: string, cardId: number, grade: Grade): Promise<ReviewResponse>
  getStats(materialId: string): Promise<StatsResponse>
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
