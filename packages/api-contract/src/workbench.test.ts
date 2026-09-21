import { describe, expect, it } from 'vitest';
import { faviconDomain } from './workbench.js';

describe('faviconDomain', () => {
  it('reduces an API subdomain to the registrable domain', () => {
    expect(faviconDomain(['api.resend.com'])).toBe('resend.com');
    expect(faviconDomain(['app.posthog.com'])).toBe('posthog.com');
    expect(faviconDomain(['console.neon.tech'])).toBe('neon.tech');
  });

  it('keeps a bare or two-label host as-is', () => {
    expect(faviconDomain(['sentry.io'])).toBe('sentry.io');
    expect(faviconDomain(['ipinfo.io'])).toBe('ipinfo.io');
    expect(faviconDomain(['localhost'])).toBe('localhost');
  });

  it('reads only the credential FIRST allowed host', () => {
    expect(faviconDomain(['api.resend.com', 'resend.com'])).toBe('resend.com');
  });

  it('answers null when the credential reports no host', () => {
    expect(faviconDomain([])).toBeNull();
    expect(faviconDomain([''])).toBeNull();
  });

  it('answers null for a literal address, which names no brand', () => {
    expect(faviconDomain(['127.0.0.1'])).toBeNull();
    expect(faviconDomain(['::1'])).toBeNull();
  });
});
