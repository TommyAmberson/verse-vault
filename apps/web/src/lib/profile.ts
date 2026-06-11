import type { ProfileRow } from '@/lib/engine/registry'

/** Two uppercase letters that represent a profile in an avatar circle.
 *  Uses the display-name's first + last word when there are two or more,
 *  otherwise the first two characters of the source. Falls back to the
 *  email when no display name is set, and to `?` when both are missing
 *  so the circle never renders blank. */
export function profileInitials(profile: Pick<ProfileRow, 'displayName' | 'email'>): string {
  const source = (profile.displayName || profile.email).trim()
  if (!source) return '?'
  const parts = source.split(/\s+/)
  const letters = parts.length >= 2
    ? parts[0]![0]! + parts[parts.length - 1]![0]!
    : source.slice(0, 2)
  return letters.toUpperCase()
}
