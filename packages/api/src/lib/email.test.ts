import { describe, expect, it, vi } from 'vitest';

import { createEmailSender, resetPasswordEmail, verifyEmail } from './email.js';

const message = resetPasswordEmail('a@example.com', 'https://example.com/reset?token=secret-token');

describe('createEmailSender', () => {
  it('logs the message instead of sending when no key is set', () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    createEmailSender(undefined, log, fetchImpl)(message);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toContain('secret-token');
  });

  it('posts to Resend from the fixed sender', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    createEmailSender('re_key', vi.fn(), fetchImpl)(message);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_key');
    const body = JSON.parse(init.body as string) as { from: string; to: string };
    expect(body.from).toBe('VerseVault <no-reply@versevault.ca>');
    expect(body.to).toBe('a@example.com');
  });

  it('returns before the provider answers and logs a failure without the link', async () => {
    const log = vi.fn();
    let fail!: (res: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (fail = resolve)));
    const send = createEmailSender('re_key', log, fetchImpl);
    expect(send(message)).toBeUndefined();
    fail(new Response('rate limited', { status: 429 }));
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain('429');
    expect(line).not.toContain('secret-token');
  });

  it('logs a network error instead of rejecting', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    createEmailSender('re_key', log, fetchImpl)(message);
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
  });
});

describe('message bodies', () => {
  it('carry the link as plain text and as an escaped button', () => {
    const url = 'https://example.com/verify-email?token=a&b';
    const m = verifyEmail('a@example.com', url);
    expect(m.text).toContain(url);
    expect(m.html).toContain('href="https://example.com/verify-email?token=a&amp;b"');
    expect(m.text).toContain("If you didn't ask for this");
  });
});
