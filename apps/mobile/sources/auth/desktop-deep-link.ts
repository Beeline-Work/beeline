import { captureGooglePreviewUrl } from './google-preview';
import type { Href, Router } from 'expo-router';
import { parseCommunityInviteToken } from '@/buzz/community-invite';
import { parseReviewSecret } from '@/buzz/review-link';

export type DesktopDeepLinkDestination = {
  href: Href;
  kind: 'review' | 'invite' | 'github-callback' | 'github-installation' | 'google-callback' | 'google-preview' | 'browser-share';
};

function routeValue(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/**
 * The desktop shell's allowlist for native URL delivery. Keeping this at the
 * platform boundary prevents every shared screen from growing a Tauri branch.
 * Review and invite hosts are routed even when their payload is malformed so
 * their destination can explain the failure instead of silently doing nothing.
 */
export function desktopDeepLinkDestination(rawUrl: string): DesktopDeepLinkDestination | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'beeline:') return null;
  if (url.hostname === 'beeline' && (url.pathname === '/onboarding' || url.pathname === '/') && url.searchParams.has('google_preview')) {
    const captured = captureGooglePreviewUrl(rawUrl);
    void captured.saved.catch(() => undefined);
    return { kind: 'google-preview', href: '/beeline/onboarding' };
  }

  if (url.hostname === 'review') {
    return {
      kind: 'review',
      href: {
        pathname: '/review/[secret]',
        params: { secret: parseReviewSecret(rawUrl) ?? routeValue(url) },
      },
    };
  }
  if (url.hostname === 'join') {
    return {
      kind: 'invite',
      href: {
        pathname: '/join/[token]',
        params: { token: parseCommunityInviteToken(rawUrl) ?? routeValue(url) },
      },
    };
  }
  if (url.hostname !== 'beeline') return null;

  if (url.pathname === '/browser-share') {
    return {
      kind: 'browser-share',
      href: { pathname: '/beeline/browser-share', params: { id: url.searchParams.get('id') ?? '' } },
    };
  }
  if (url.pathname === '/google-callback') {
    return { kind: 'google-callback', href: `/beeline/google-callback${url.search}` as Href };
  }
  if (url.pathname === '/github-callback') {
    return {
      kind: 'github-callback',
      href: `/beeline/github-callback${url.search}` as Href,
    };
  }
  if (url.pathname === '/github-installation') {
    return {
      kind: 'github-installation',
      href: `/beeline/github-installation${url.search}` as Href,
    };
  }
  return null;
}

export function deliverDesktopDeepLink(rawUrl: string, router: Pick<Router, 'replace'>): boolean {
  const destination = desktopDeepLinkDestination(rawUrl);
  if (!destination) return false;
  router.replace(destination.href);
  return true;
}
