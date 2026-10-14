/**
 * Whether the agent's own Squire browser session is signed in to an app.
 * Squire marks sign-in and sign-up controls with the `a=login` and
 * `a=signup` facts in its compact control map, and names a login page's
 * stage `auth`. Nothing here reads or keeps a cookie or token.
 */
import { urlBelongsToApp } from '@beeline/api-contract/app-connections';

type SquireCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
type Page = {
  url?: unknown;
  session_id?: unknown;
  stage?: unknown;
  safe_table?: unknown;
  semantic?: { blockers?: ReadonlyArray<{ kind?: unknown }> };
};

function showsSignIn(page: Page): boolean {
  return page.stage === 'auth' || Array.isArray(page.safe_table) && page.safe_table.some((row) =>
    Array.isArray(row) && typeof row[2] === 'string' &&
    row[2].split('|').some((fact) => fact === 'a=login' || fact === 'a=signup'));
}

/** The page URL when one Squire MCP result shows a login page or sign-in controls. */
export function squireSignedOutUrl(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')?.text as string | undefined;
  if (!text || text.length > 2_000_000 || !text.trimStart().startsWith('{')) return undefined;
  let page: Page;
  try { page = JSON.parse(text) as Page; } catch { return undefined; }
  return typeof page.url === 'string' && showsSignIn(page) ? page.url : undefined;
}

/**
 * Open a page only a signed-in user can open in a fresh Squire session. A
 * signed-out session is redirected away from it or shown sign-in controls.
 * The page must be on the app's own site. Any failure reads as signed out.
 */
export async function squireSessionSignedIn(call: SquireCall, signedInUrl: string, appKey: string): Promise<boolean> {
  if (!urlBelongsToApp(signedInUrl, appKey)) return false;
  // A home page is public; only a deeper page proves a signed-in session.
  const path = new URL(signedInUrl).pathname.replace(/\/+$/, '');
  if (!path) return false;
  let sessionId: string | undefined;
  try {
    const start = await call('operate_start', { service_url: signedInUrl }) as Page;
    if (typeof start.session_id !== 'string') return false;
    sessionId = start.session_id;
    const signedIn = (page: Page) => typeof page.url === 'string' && urlBelongsToApp(page.url, appKey)
      && `${new URL(page.url).pathname.replace(/\/+$/, '')}/`.startsWith(`${path}/`)
      && !showsSignIn(page) && !(page.semantic?.blockers ?? []).some((blocker) => blocker.kind !== 'dialog');
    if (!signedIn(start)) return false;
    // The first observation pages only part of the control map; a query reaches the rest.
    for (const query of ['sign in', 'log in', 'sign up'])
      if (!signedIn(await call('operate_observe', { session_id: sessionId, query }) as Page)) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (sessionId) await call('operate_finish', { session_id: sessionId }).catch(() => {});
  }
}
