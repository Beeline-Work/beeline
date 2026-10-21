import { createHash, timingSafeEqual } from 'node:crypto';

export const GOOGLE_PREVIEW_HEADER = 'x-beeline-google-preview';

/** Preview enrollment changes discovery only; ticket exchange has its own allow list. */
export function googlePreviewVisible(
  options: { googleSignInEnabled?: boolean; googleSignInEveryone?: boolean; googleSignInPreviewToken?: string },
  supplied: unknown,
): boolean {
  if (!options.googleSignInEnabled) return false;
  if (options.googleSignInEveryone) return true;
  const expected = options.googleSignInPreviewToken;
  if (!expected || expected.length < 32 || typeof supplied !== 'string' || supplied.length > 512) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(supplied));
}
