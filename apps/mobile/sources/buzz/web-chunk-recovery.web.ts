import { flushActiveTextDrafts } from './text-draft-store';

const RETRY_KEY = 'beeline.web-chunk-reload.v1';
const CHUNK_PATH = /\/_expo\/static\/js\/[^\s"'<>)]*\.js(?:[?#][^\s"'<>)]*)?/;
let recovering = false;
const recognizedErrors = new WeakSet<object>();

// Only the deferred boot scripts identify an export; lazy scripts vary as a tab is used.
function exportScripts(page: Document): string {
  return [...page.querySelectorAll<HTMLScriptElement>('script[src][defer]')]
    .map((script) => script.getAttribute('src') ?? '')
    .filter((src) => CHUNK_PATH.test(src)).sort().join('\n');
}

async function reloadNewExport(): Promise<void> {
  try {
    const current = exportScripts(document);
    if (!current) return;
    const response = await fetch(window.location.href, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return;
    const latest = exportScripts(new DOMParser().parseFromString(await response.text(), 'text/html'));
    // A changed export is evidence that reloading can help. A broken current export
    // must not keep reloading, even if its failed lazy chunk changes.
    if (!latest || latest === current || window.sessionStorage.getItem(RETRY_KEY) === latest) return;
    window.sessionStorage.setItem(RETRY_KEY, latest);
    await flushActiveTextDrafts();
    window.location.reload();
  } catch {
    // Offline or blocked storage: leave the current page and its draft intact.
  } finally {
    recovering = false;
  }
}

/** Match only Expo JavaScript assets, never unrelated application syntax errors. */
function isWebChunkFailure(value: unknown): boolean {
  if (typeof window === 'undefined' || !value || typeof value !== 'object') return false;
  const error = value as { filename?: string; message?: string; request?: string };
  return (CHUNK_PATH.test(error.filename ?? '') &&
    /Unexpected token\s+['"]?<|expected expression, got\s+['"]?</i.test(error.message ?? '')) || CHUNK_PATH.test(error.request ?? '') ||
    (/Loading module|Failed to fetch dynamically imported module|Importing a module script failed/.test(error.message ?? '') &&
      CHUNK_PATH.test(error.message ?? ''));
}

/** Retry only when the host offers a different, not-yet-retried export. */
export function recoverWebChunk(value: unknown): boolean {
  if (value && typeof value === 'object' && recognizedErrors.has(value)) return true;
  if (!isWebChunkFailure(value)) return false;
  if (recovering) return true;
  recovering = true;
  void reloadNewExport();
  return true;
}

export function installWebChunkRecovery(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    const target = event.target;
    const failure = target instanceof HTMLScriptElement ? { request: target.src } : event;
    if (recoverWebChunk(failure)) {
      // Sentry's RN integration rewrites frame URLs before beforeSend. Keep the
      // original Error identity from this narrowly matched browser event.
      if (event.error && typeof event.error === 'object') recognizedErrors.add(event.error);
      event.preventDefault();
    }
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    if (recoverWebChunk(event.reason)) event.preventDefault();
  });
}
