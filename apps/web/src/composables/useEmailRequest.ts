import { ref } from 'vue'

import { type EmailRequestResult, emailRequestMessage } from '@/lib/authEmail'

/** State for a button that asks the server to email a link: whether the
 *  request is in flight, and what to tell the learner once it answers. */
export function useEmailRequest(send: () => Promise<EmailRequestResult>, sent: () => string) {
  const pending = ref(false)
  const notice = ref('')

  async function run() {
    pending.value = true
    try {
      notice.value = emailRequestMessage(await send(), sent())
    } catch {
      // Offline, or the server never answered.
      notice.value = emailRequestMessage({ error: {} }, sent())
    } finally {
      pending.value = false
    }
  }

  return { pending, notice, run }
}
