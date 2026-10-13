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
    // Local dev has no provider: print the link so sign-up, reset and
    // verification can still be walked through by hand.
    return (message) => log(`[email] not sent (no RESEND_API_KEY) to ${message.to}:\n${message.text}`);
  }
  return (message) => {
    void deliver(apiKey, message, fetchImpl).catch((err: unknown) => {
      // The body holds a live token, so log only who and what failed.
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

export function resetPasswordEmail(to: string, url: string): EmailMessage {
  return linkEmail(to, {
    subject: 'Reset your VerseVault password',
    reason: 'Someone asked to reset the password for your VerseVault account.',
    action: 'Reset password',
    expiry: 'This link works once and expires in 1 hour.',
    url,
  });
}

export function verifyEmail(to: string, url: string): EmailMessage {
  return linkEmail(to, {
    subject: 'Verify your VerseVault email',
    reason: 'Confirm that this address belongs to your VerseVault account.',
    action: 'Verify email',
    expiry: 'This link expires in 24 hours. You will be asked to sign in first if you are not already.',
    url,
  });
}

interface LinkEmailParts {
  subject: string;
  reason: string;
  action: string;
  expiry: string;
  url: string;
}

function linkEmail(to: string, parts: LinkEmailParts): EmailMessage {
  const ignore = "If you didn't ask for this, you can ignore this email.";
  const text = [parts.reason, '', `${parts.action}: ${parts.url}`, '', parts.expiry, ignore].join('\n');
  const href = escapeHtml(parts.url);
  const html = [
    `<p>${escapeHtml(parts.reason)}</p>`,
    `<p><a href="${href}" style="display:inline-block;padding:10px 18px;background:#2f5d50;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(parts.action)}</a></p>`,
    `<p>Or open this link:<br>${href}</p>`,
    `<p>${escapeHtml(parts.expiry)} ${escapeHtml(ignore)}</p>`,
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
