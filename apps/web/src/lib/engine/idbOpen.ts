/**
 * Shared IndexedDB open for the profile DBs and the registry, so neither
 * can wedge the app when another tab holds a connection (#175).
 *
 * A version upgrade waits until every other connection to the database
 * closes, and while it waits the browser queues every later open of that
 * database behind it, in this tab and every other. Two rules keep that
 * wait from becoming a hang:
 *
 *   - Every connection closes itself on `versionchange`, so a newer tab's
 *     upgrade never waits on this one. The tab is then stale (its code
 *     predates the new schema) and reports `superseded`, or `removed` when
 *     the other tab deleted the database rather than upgrading it.
 *   - An open that is blocked reports `blocked` until it proceeds. Only a
 *     tab running code from before this rule can hold out, and nothing
 *     here can make it let go, so the user is told to close or refresh it.
 *
 * Framework-free: the app subscribes with `onIdbInterruption`.
 */

/** Why local storage is unavailable: `blocked` while an upgrade waits on
 *  another tab, `superseded` once a newer tab took the database over,
 *  `removed` once another tab deleted it (a profile delete or reset). */
export type IdbInterruption = 'blocked' | 'superseded' | 'removed'

let interruption: IdbInterruption | null = null
// Opens currently waiting on another tab. `blocked` holds while any do,
// so one database going through doesn't hide another still stuck.
let blockedOpens = 0
const listeners = new Set<(state: IdbInterruption | null) => void>()

function setInterruption(next: IdbInterruption | null): void {
  // Both let-go states are terminal: this tab's handle is closed and only
  // a reload opens the database as it now stands.
  if (interruption === 'superseded' || interruption === 'removed') return
  if (interruption === next) return
  interruption = next
  for (const listener of listeners) listener(next)
}

export function getIdbInterruption(): IdbInterruption | null {
  return interruption
}

/** Subscribe to interruption changes; returns the unsubscribe. */
export function onIdbInterruption(listener: (state: IdbInterruption | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test helper: forget any interruption so suites start clean. */
export function resetIdbInterruption(): void {
  interruption = null
  blockedOpens = 0
}

/** `indexedDB.open` with the blocked and versionchange handling above.
 *  `upgrade` runs inside the version-change transaction, as
 *  `onupgradeneeded` would. */
export function openIdb(
  name: string,
  version: number,
  upgrade: (req: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version)
    let wasBlocked = false
    // The wait is over whether the open succeeded or failed; on failure
    // the caller's error should show, not a stale "close your other tab".
    const settleBlocked = () => {
      if (!wasBlocked) return
      wasBlocked = false
      blockedOpens -= 1
      if (blockedOpens === 0) setInterruption(null)
    }
    req.onupgradeneeded = (ev) => upgrade(req, ev)
    req.onblocked = () => {
      if (wasBlocked) return
      wasBlocked = true
      blockedOpens += 1
      setInterruption('blocked')
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = (ev) => {
        // close() lets transactions already running finish.
        db.close()
        setInterruption(ev.newVersion === null ? 'removed' : 'superseded')
      }
      settleBlocked()
      resolve(db)
    }
    req.onerror = () => {
      settleBlocked()
      reject(req.error)
    }
  })
}
