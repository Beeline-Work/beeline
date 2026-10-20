import { flushActiveTextDrafts } from './text-draft-store';

const RETRY_KEY = 'beeline.web-chunk-reload.v1';
const CHUNK_PATH = /\/_expo\/static\/js\/[^\s"'<>)]*\.js(?:[?#][^\s"'<>)]*)?/;
let recovering = false;

/** Match only Expo JavaScript assets, never unrelated application syntax errors. */
function isWebChunkFailure(value: unknown): boolean {
  if (typeof window === 'undefined' || !value || typeof value !== 'object') return false;
  const error = value as { filename?: string; message?: string; request?: string };
  return (CHUNK_PATH.test(error.filename ?? '') &&
    /Unexpected token\s+['"]?<|expected expression, got\s+['"]?</i.test(error.message ?? '')) || CHUNK_PATH.test(error.request ?? '') ||
    (/Loading module|Failed to fetch dynamically imported module|Importing a module script failed/.test(error.message ?? '') &&
      CHUNK_PATH.test(error.message ?? ''));
}

/** A session-wide marker also stops loops when successive releases are both broken. */
export function recoverWebChunk(value: unknown): boolean {
  if (!isWebChunkFailure(value)) return false;
  if (recovering) return true;
  try {
    if (window.sessionStorage.getItem(RETRY_KEY)) return true;
    window.sessionStorage.setItem(RETRY_KEY, '1');
  } catch {
    // Without a durable marker, a reload cannot be made safe.
    return true;
  }
  recovering = true;
  // Await pending composer saves rather than relying on asynchronous pagehide work.
  void flushActiveTextDrafts().then(() => window.location.reload());
  return true;
}

export function installWebChunkRecovery(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    const target = event.target;
    const failure = target instanceof HTMLScriptElement ? { request: target.src } : event;
    if (recoverWebChunk(failure)) event.preventDefault();
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    if (recoverWebChunk(event.reason)) event.preventDefault();
  });
}
