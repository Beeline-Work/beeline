import { describe, expect, it } from 'vitest';
import { extractExpoPathFromURL } from 'expo-router/build/fork/extractPathFromURL';
import { isReviewLink, parseReviewSecret } from './review-link';

const SECRET = 'play-review-secret-value-0001';

describe('the Google Play review link', () => {
  it('resolves the custom-scheme and universal links to the same secret', () => {
    const universalLink = `https://usebeeline.app/review/${SECRET}`;
    const schemeLink = `beeline://review/${SECRET}`;
    const universalSecret = parseReviewSecret(universalLink);
    const schemeSecret = parseReviewSecret(schemeLink);

    expect(extractExpoPathFromURL([], schemeLink)).toBe(extractExpoPathFromURL([], universalLink));
    expect(extractExpoPathFromURL([], schemeLink)).toBe(`review/${SECRET}`);
    expect(schemeSecret).toBe(universalSecret);
    expect(schemeSecret).toBe(SECRET);
    expect(parseReviewSecret(`https://usebeeline.app/review/${SECRET}/`)).toBe(SECRET);
    expect(parseReviewSecret(SECRET)).toBe(SECRET);
    expect(parseReviewSecret([SECRET, 'ignored'])).toBe(SECRET);
    expect(isReviewLink(`https://usebeeline.app/review/${SECRET}`)).toBe(true);
  });

  it('takes nothing from a link that is not a review link', () => {
    for (const value of [
      undefined,
      '',
      '   ',
      'https://usebeeline.app/join/bzi_abc',
      'https://usebeeline.app/review/',
      `https://usebeeline.app/review/${SECRET}/extra`,
      `https://usebeeline.app/reviewer/${SECRET}`,
      'https://usebeeline.app/review/short',
      `https://usebeeline.app/review/${'x'.repeat(129)}`,
      `https://usebeeline.app/review/${SECRET}?x=1#y`.replace(`/${SECRET}?`, '/bad secret?'),
      'not a url',
      `beeline://join/${SECRET}`,
    ]) {
      expect([value, parseReviewSecret(value)]).toEqual([value, null]);
    }
    expect(isReviewLink(null)).toBe(false);
  });

  it('ignores a query string and fragment the OS may append', () => {
    expect(parseReviewSecret(`https://usebeeline.app/review/${SECRET}?utm=play#top`)).toBe(SECRET);
  });
});
