import { ref } from 'vue'

import { type EmailRequestResult, emailRequestMessage } from '@/lib/authEmail'

/** State for a button that asks the server to email a code: whether the
 *  request is in flight, and what to tell the learner once it answers.
 *  `run` resolves true when the server accepted the request. */
export function useEmailRequest(send: () => Promise<EmailRequestResult>, sent: () => string) {
  const pending = ref(false)
  const notice = ref('')

  async function run(): Promise<boolean> {
    pending.value = true
    // Read before the await: the notice names what was asked for, even if
    // the active profile changes while the request is out.
    const sentMessage = sent()
    try {
      const result = await send()
      notice.value = emailRequestMessage(result, sentMessage)
      return !result?.error
    } catch {
      // Offline, or the server never answered.
      notice.value = emailRequestMessage({ error: {} }, sentMessage)
      return false
    } finally {
      pending.value = false
    }
  }

  return { pending, notice, run }
}
