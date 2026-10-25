import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadXPixel,
  parseXAttribution,
  readWebXAttribution,
  trackXSignup,
} from './x-attribution.js';

afterEach(() => vi.unstubAllGlobals());
function browser(url: string, cookie = '') {
  const scripts: unknown[] = [];
  const document = {
    cookie,
    head: { appendChild: (value: unknown) => scripts.push(value) },
    createElement: () => ({}),
  };
  const window = {};
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('location', new URL(url));
  return { document, window, scripts };
}
describe('first-party X ad click across landing and web signup', () => {
  it('keeps click/campaign/clip/audience across origins and OAuth return, and sends the shared deduplication ID', () => {
    const landing = browser(
      'https://usebeeline.app/?twclid=click&utm_source=x&utm_campaign=campaign&utm_content=clip&utm_term=audience',
    );
    const context = readWebXAttribution();
    expect(context).toMatchObject({
      twclid: 'click',
      campaignId: 'campaign',
      adId: 'clip',
      adGroupId: 'audience',
    });
    expect(landing.document.cookie).toContain('Domain=usebeeline.app; Secure');
    const web = browser('https://web.usebeeline.app/', landing.document.cookie.split(';')[0]);
    expect(readWebXAttribution()).toEqual(context);
    const queue = loadXPixel();
    trackXSignup({ eventId: 'tw-rhefr-rhym5', conversionId: 'a'.repeat(64) });
    expect(web.scripts).toHaveLength(1);
    expect(queue?.queue).toEqual([
      ['config', 'rhefr'],
      ['event', 'tw-rhefr-rhym5', { conversion_id: 'a'.repeat(64) }],
    ]);
    const delivered = vi.fn();
    queue!.exe = delivered;
    queue!('event', 'next');
    expect(delivered).toHaveBeenCalledWith('event', 'next');
  });
  it('loads no vendor script for ordinary visits, expired contexts or OAuth callbacks containing credentials', () => {
    const ordinary = browser('https://usebeeline.app/');
    expect(loadXPixel()).toBeUndefined();
    expect(ordinary.scripts).toEqual([]);
    expect(
      parseXAttribution({ twclid: 'click', capturedAt: Date.now() - 31 * 86400000 }),
    ).toBeUndefined();
    const auth = browser('https://web.usebeeline.app/?code=private-code&state=state');
    expect(loadXPixel({ twclid: 'click', capturedAt: Date.now() })).toBeUndefined();
    expect(auth.scripts).toEqual([]);
  });
  it('rejects extra account data, malformed identifiers and future timestamps', () => {
    for (const input of [
      { twclid: 'click', email: 'x@example.com', capturedAt: Date.now() },
      { twclid: '<script>', capturedAt: Date.now() },
      { twclid: 'click', capturedAt: Date.now() + 120000 },
    ])
      expect(parseXAttribution(input)).toBeUndefined();
  });
});
