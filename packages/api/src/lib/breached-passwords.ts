/** Pwned Passwords' k-anonymity range API: only the first 5 characters of
 *  the password's SHA-1 are sent. */
const RANGE_URL = 'https://api.pwnedpasswords.com/range/';

/**
 * Whether a password appears in a data breach (FR-034, NIST SP 800-63B-4).
 * Throws when the service can't be reached, so a caller refuses the password
 * rather than accepting it unchecked.
 */
export async function isBreachedPassword(password: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  // Padding makes every answer about the same size, so its length reveals
  // nothing about the prefix. A stalled service fails the request quickly,
  // and Pwned Passwords asks callers to name themselves.
  const res = await fetch(`${RANGE_URL}${hash.slice(0, 5)}`, {
    headers: { 'Add-Padding': 'true', 'User-Agent': 'verse-vault-api' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Pwned Passwords HTTP ${res.status}`);
  const suffix = hash.slice(5);
  // Padding rows carry a count of 0 and aren't breaches.
  return (await res.text()).split('\n').some((line) => {
    const [lineSuffix, count] = line.split(':');
    return lineSuffix?.trim().toUpperCase() === suffix && Number(count) > 0;
  });
}
