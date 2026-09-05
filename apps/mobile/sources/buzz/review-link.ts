/**
 * The Google Play review link: `https://usebeeline.app/review/<secret>`.
 *
 * Android verifies that host already (`app.config.js` intentFilters), so the OS
 * hands the whole URL to the app and the secret never leaves the device except
 * in the one exchange request. This module only recognises the shape — the
 * server is the sole judge of whether a secret is real, and answers an unknown
 * one with an ordinary 404.
 *
 * Deliberately self-contained: Metro resolves `@beeline/*` to built `dist/`, so
 * a screen that depended on a brand-new SDK export would fail closed on a stale
 * build. Nothing here needs the SDK.
 */

// Keep in step with the installed schemes in app.config.js.
const MOBILE_APP_SCHEMES = ['beeline'] as const;
/** Opaque to the app; only bounded and URL-safe, matching the server's shape check. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** The secret in a review link (or a bare secret), else null. */
export function parseReviewSecret(value: string | string[] | undefined): string | null {
  const input = firstValue(value).trim();
  if (!input) return null;
  if (SECRET_SHAPE.test(input)) return input;
  try {
    const url = new URL(input);
    let candidate = '';
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      candidate = url.pathname.match(/^\/review\/([^/]+)\/?$/)?.[1] ?? '';
    } else if (
      MOBILE_APP_SCHEMES.some((scheme) => url.protocol === `${scheme}:`) &&
      url.hostname === 'review'
    ) {
      candidate = url.pathname.replace(/^\//, '');
    }
    const decoded = decodeURIComponent(candidate);
    return SECRET_SHAPE.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** True when this URL is a review link, so a cold start routes to it instead of onboarding. */
export function isReviewLink(value: string | null | undefined): boolean {
  return parseReviewSecret(value ?? undefined) !== null;
}
