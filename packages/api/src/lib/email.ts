/** Transactional email through the Resend HTTPS API. SMTP isn't an option:
 *  DigitalOcean blocks outbound SMTP from droplets. */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Starts a send and returns at once. Never throws and never rejects: an
 *  auth flow that awaited the provider, or surfaced its error, would let a
 *  caller tell an existing address from an unknown one by timing or by
 *  status (FR-002). */
export type SendEmail = (message: EmailMessage) => void;

type FetchImpl = typeof fetch;

const RESEND_URL = 'https://api.resend.com/emails';
const FROM = 'VerseVault <no-reply@versevault.ca>';

export function createEmailSender(
  apiKey: string | undefined,
  log: (line: string) => void = (line) => console.warn(line),
  fetchImpl: FetchImpl = fetch,
): SendEmail {
  if (!apiKey) {
    // Local dev has no provider: print the code so sign-up, reset and
    // verification can still be walked through by hand.
    return (message) => log(`[email] not sent (no RESEND_API_KEY) to ${message.to}:\n${message.text}`);
  }
  return (message) => {
    void deliver(apiKey, message, fetchImpl).catch((err: unknown) => {
      // The body holds a live code, so log only who and what failed.
      log(`[email] send failed to ${message.to} (${message.subject}): ${String(err)}`);
    });
  };
}

async function deliver(apiKey: string, message: EmailMessage, fetchImpl: FetchImpl): Promise<void> {
  const res = await fetchImpl(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, ...message }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

export function resetCodeEmail(to: string, code: string, ttlMinutes: number): EmailMessage {
  return codeEmail(to, ttlMinutes, {
    subject: 'Your VerseVault reset code',
    reason: 'Someone asked to reset the password for your VerseVault account. Enter this code with ' +
      'your new password:',
    code,
  });
}

export function verificationCodeEmail(to: string, code: string, ttlMinutes: number): EmailMessage {
  return codeEmail(to, ttlMinutes, {
    subject: 'Your VerseVault code',
    reason: 'Enter this code in VerseVault to confirm that this address is yours:',
    code,
  });
}

/** The Google code step's code, which says what it is for, so a code the
 *  learner didn't ask for isn't typed in on someone else's say-so. */
export function googleCodeEmail(to: string, code: string, ttlMinutes: number): EmailMessage {
  return codeEmail(to, ttlMinutes, {
    subject: 'Your VerseVault code to connect Google',
    reason: 'Someone is connecting a Google account to your VerseVault account. Enter this code ' +
      'only if you just did that yourself; otherwise ignore this email, and your account stays as ' +
      'it is:',
    code,
  });
}

/** Sent whenever Google joins an account that already had another way to
 *  sign in, so the owner hears of a link they didn't make. */
export function googleLinkedEmail(to: string): EmailMessage {
  const subject = 'Google was connected to your VerseVault account';
  const lines = [
    'A Google account was just connected to your VerseVault account, so it can now be used to ' +
    'sign in.',
    'If this wasn\'t you, reset your password from the sign-in page ("Forgot password?").',
  ];
  return {
    to,
    subject,
    text: lines.join('\n\n'),
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n'),
  };
}

interface CodeEmailParts {
  subject: string;
  reason: string;
  code: string;
}

function codeEmail(to: string, ttlMinutes: number, parts: CodeEmailParts): EmailMessage {
  // Warns against handing the code over, not against the app asking for it.
  const expiry = `The code expires in ${ttlMinutes} minutes. Don't share it with anyone.`;
  const ignore = "If you didn't ask for this, you can ignore this email.";
  const text = [parts.reason, '', parts.code, '', expiry, ignore].join('\n');
  const html = [
    `<p>${escapeHtml(parts.reason)}</p>`,
    `<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${escapeHtml(parts.code)}</p>`,
    `<p>${escapeHtml(expiry)} ${escapeHtml(ignore)}</p>`,
  ].join('\n');
  return { to, subject: parts.subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
