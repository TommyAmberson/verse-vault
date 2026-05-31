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
