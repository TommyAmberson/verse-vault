/**
 * Word-level diff between expected and actual prose, for type-to-recite
 * feedback. Comparison is normalised — lowercased, punctuation
 * stripped, whitespace collapsed — so the user's diff doesn't punish
 * them for forgetting a comma or capitalising "Lord". The original
 * (un-normalised) token is preserved on each diff item so the rendered
 * diff still shows real text.
 */

export type DiffItem =
  | { kind: 'match'; raw: string }
  | { kind: 'missing'; raw: string }
  | { kind: 'extra'; raw: string }

interface Token {
  raw: string
  norm: string
}

const NON_WORD = /[^\p{L}\p{N}']+/gu

/** Lowercase a single token and strip everything but letters, digits,
 *  and apostrophes. Exported so callers that need the same notion of
 *  "same word" outside the diff (e.g. greedy prefix matching) stay in
 *  sync. */
export function normalize(raw: string): string {
  return raw.toLowerCase().replace(NON_WORD, '')
}

function tokenize(s: string): Token[] {
  const out: Token[] = []
  for (const piece of s.split(/\s+/)) {
    if (piece === '') continue
    const norm = normalize(piece)
    if (norm === '') continue
    out.push({ raw: piece, norm })
  }
  return out
}

/** Standard LCS dp table over normalised tokens. Returns the diff in
 *  expected order: each matched word, missing word (in expected, not
 *  typed), and extra word (typed but not in expected) appears as a
 *  separate item. The renderer can interleave them in input order. */
export function wordDiff(expected: string, actual: string): DiffItem[] {
  const e = tokenize(expected)
  const a = tokenize(actual)

  const n = e.length
  const m = a.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = e[i - 1]!.norm === a[j - 1]!.norm
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }

  const out: DiffItem[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (e[i - 1]!.norm === a[j - 1]!.norm) {
      // Standard back-to-front LCS would match here unconditionally,
      // which biases toward matching at the LATEST valid expected
      // position (the "last 'was'" in the screenshot, even when the
      // user clearly meant the first). When we can skip this expected
      // token without shortening the LCS — i.e. the same actual word
      // appears at an earlier expected position too — defer the match
      // by treating the current token as missing. The next iteration
      // of the loop will find the earlier occurrence and force the
      // match there.
      if (dp[i - 1]![j]! === dp[i]![j]!) {
        out.push({ kind: 'missing', raw: e[i - 1]!.raw })
        i--
      } else {
        out.push({ kind: 'match', raw: e[i - 1]!.raw })
        i--
        j--
      }
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      out.push({ kind: 'missing', raw: e[i - 1]!.raw })
      i--
    } else {
      out.push({ kind: 'extra', raw: a[j - 1]!.raw })
      j--
    }
  }
  while (i > 0) {
    out.push({ kind: 'missing', raw: e[i - 1]!.raw })
    i--
  }
  while (j > 0) {
    out.push({ kind: 'extra', raw: a[j - 1]!.raw })
    j--
  }
  out.reverse()
  return out
}

