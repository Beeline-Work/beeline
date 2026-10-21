import { getDomain } from 'tldts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ObjectService } from './object-service.js';

export const RUNNABLE_MIME = 'application/vnd.beeline.game+html';
export const RUNNABLE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

/** Arm the parent's load guard before any authored code or handlers can run. */
function embeddedDocument(bytes: Uint8Array): string {
  const data = Buffer.from(bytes).toString('base64');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>
addEventListener('message', function start(event) {
  if (event.source !== parent || event.data !== 'beeline-start-game') return;
  removeEventListener('message', start);
  const html = new TextDecoder().decode(Uint8Array.from(atob('${data}'), c => c.charCodeAt(0)));
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const scripts = Array.from(parsed.querySelectorAll('script'));
  for (const attribute of parsed.documentElement.attributes) document.documentElement.setAttribute(attribute.name, attribute.value);
  document.documentElement.replaceChildren(parsed.head, parsed.body);
  for (const inert of scripts) {
    if (!inert.isConnected) continue;
    const script = document.createElement('script');
    for (const attribute of inert.attributes) script.setAttribute(attribute.name, attribute.value);
    script.textContent = inert.textContent;
    inert.replaceWith(script);
  }
  document.dispatchEvent(new Event('DOMContentLoaded'));
  dispatchEvent(new Event('load'));
});
</script>`;
}

/** Fail closed: game documents must never share a site with the application. */
export function runnableOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const game = new URL(env.BEELINE_GAME_ORIGIN ?? 'https://beeline-games.fly.dev');
  const app = new URL(env.PUBLIC_ORIGIN ?? 'https://usebeeline.app');
  const site = getDomain(game.hostname, { allowPrivateDomains: true });
  if (
    game.protocol !== 'https:' ||
    game.username ||
    game.password ||
    game.pathname !== '/' ||
    game.search ||
    game.hash ||
    !site ||
    site === 'usebeeline.app' ||
    site === getDomain(app.hostname, { allowPrivateDomains: true })
  ) {
    throw new Error('BEELINE_GAME_ORIGIN must be an HTTPS origin on a separate registrable domain');
  }
  return game.origin;
}

/** This host serves only capability-addressed documents, never application APIs. */
export async function serveRunnableArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  objects?: ObjectService,
): Promise<void> {
  const url = new URL(request.url ?? '/', origin);
  const match = /^\/play\/([0-9a-f-]{36})$/.exec(url.pathname);
  const result =
    request.method === 'GET' && match && objects
      ? await objects.openRunnableArtifact(
          match[1]!,
          Number(url.searchParams.get('expires')),
          url.searchParams.get('token') ?? '',
        )
      : undefined;
  response.writeHead(result ? 200 : 404, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': RUNNABLE_CSP,
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), fullscreen=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  response.end(
    result
      ? url.searchParams.get('embed') === '1'
        ? embeddedDocument(result)
        : result
      : 'This game link is unavailable. Close and reopen the artifact.',
  );
}
