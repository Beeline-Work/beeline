import { describe, expect, it, vi } from 'vitest';
import { deliverDesktopDeepLink, desktopDeepLinkDestination } from './desktop-deep-link';

const REVIEW_SECRET = 'play-review-secret-value-0001';

describe('desktop native deep-link delivery', () => {
  it('routes cold and running review links to the visible review sign-in', () => {
    const replace = vi.fn();
    const url = `beeline://review/${REVIEW_SECRET}`;

    expect(desktopDeepLinkDestination(url)).toEqual({
      kind: 'review',
      href: { pathname: '/review/[secret]', params: { secret: REVIEW_SECRET } },
    });
    expect(deliverDesktopDeepLink(url, { replace } as never)).toBe(true);
    expect(replace).toHaveBeenCalledWith({
      pathname: '/review/[secret]',
      params: { secret: REVIEW_SECRET },
    });
  });

  it('delivers the other registered callback routes without broadening the allowlist', () => {
    expect(desktopDeepLinkDestination('beeline://beeline/github-callback?code=ok')).toEqual({
      kind: 'github-callback',
      href: '/beeline/github-callback?code=ok',
    });
    expect(desktopDeepLinkDestination('beeline://beeline/github-installation?installed=1')).toEqual(
      {
        kind: 'github-installation',
        href: '/beeline/github-installation?installed=1',
      },
    );
    expect(desktopDeepLinkDestination('beeline://unknown/path')).toBeNull();
    expect(desktopDeepLinkDestination('https://example.test/review/nope')).toBeNull();
  });

  it('still opens malformed review links so the route can explain the error', () => {
    expect(desktopDeepLinkDestination('beeline://review/short')).toEqual({
      kind: 'review',
      href: { pathname: '/review/[secret]', params: { secret: 'short' } },
    });
  });
});
