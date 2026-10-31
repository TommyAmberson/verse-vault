/** What a device does with a reset counter that differs from the one it
 *  has stored (spec 007):
 *  - `ignore`: the same value;
 *  - `adopt`: store it, nothing else: a first value (a device new to the
 *    counter, whose outbox older clients could send without one anyway),
 *    or a lower one, which means the server went back (a restore) and this
 *    device's data is worth uploading, not clearing;
 *  - `catch-up`: the account was wiped since this device last heard, so
 *    its local data predates the wipe: clear it first. */
type ResetCounterStep = 'ignore' | 'adopt' | 'catch-up'

export function resetCounterStep(known: number | undefined, counter: number): ResetCounterStep {
  if (counter === known) return 'ignore'
  if (known === undefined || counter < known) return 'adopt'
  return 'catch-up'
}
