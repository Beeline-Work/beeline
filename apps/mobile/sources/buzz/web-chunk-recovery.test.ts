// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { TextDraft, textDraftKey } from './text-draft-store';
const chunk = 'https://web.usebeeline.app/_expo/static/js/web/room-page-observation-deadbeef0000.js';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('STALE-CHUNK-1: parse failure flushes the composer, reloads once, and survives remount', async () => {
  const saved = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => saved.get(key) ?? null,
    setItem: async (key: string, value: string) => { saved.set(key, value); },
    removeItem: async (key: string) => { saved.delete(key); },
  };
  const key = textDraftKey('viewer', 'room:composer');
  const draft = new TextDraft(key, storage, '');
  await draft.hydrate();
  draft.set('Still typing across a release');
  const reload = vi.fn();
  const sessionStorage = window.sessionStorage;
  sessionStorage.clear();
  vi.stubGlobal('window', { sessionStorage, location: { reload } });
  const { recoverWebChunk } = await import('./web-chunk-recovery.web');
  expect(recoverWebChunk({ filename: chunk, message: "Unexpected token '<'", name: 'SyntaxError' })).toBe(true);
  expect(reload).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  draft.dispose();
  const reopened = new TextDraft(key, storage, '');
  await reopened.hydrate();
  expect(reopened.value).toBe('Still typing across a release');
  reopened.dispose();
  vi.resetModules();
  const afterReload = await import('./web-chunk-recovery.web');
  expect(afterReload.recoverWebChunk({ request: chunk })).toBe(true);
  await Promise.resolve();
  expect(reload).toHaveBeenCalledOnce();
});

it('handles script load rejection, concurrent failures, unrelated errors and blocked storage', async () => {
  const reload = vi.fn();
  const sessionStorage = window.sessionStorage;
  sessionStorage.clear();
  vi.stubGlobal('window', { sessionStorage, location: { reload } });
  const { recoverWebChunk } = await import('./web-chunk-recovery.web');
  expect(recoverWebChunk(new SyntaxError("Unexpected token '<'"))).toBe(false);
  expect(recoverWebChunk({ filename: chunk, message: 'Unexpected token in JSON', name: 'SyntaxError' })).toBe(false);
  expect(recoverWebChunk({ filename: 'https://example.com/app.js' })).toBe(false);
  const error = new Error(`Loading module ${chunk} failed.\n(error: ${chunk})`);
  expect(recoverWebChunk(error)).toBe(true);
  expect(recoverWebChunk(error)).toBe(true);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  vi.resetModules();
  vi.stubGlobal('window', { get sessionStorage() { throw new Error('disabled'); }, location: { reload } });
  expect((await import('./web-chunk-recovery.web')).recoverWebChunk(error)).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it('installs capture listeners that recover caught chunk parse errors without hiding app errors', async () => {
  window.sessionStorage.clear();
  const recovery = await import('./web-chunk-recovery.web');
  recovery.installWebChunkRecovery();
  const ordinary = new ErrorEvent('error', { filename: chunk, message: 'render failed', error: new TypeError('render failed'), cancelable: true });
  window.dispatchEvent(ordinary);
  expect(ordinary.defaultPrevented).toBe(false);
  window.sessionStorage.setItem('beeline.web-chunk-reload.v1', '1');
  const parse = new ErrorEvent('error', { filename: chunk, message: "Unexpected token '<'", error: new SyntaxError("Unexpected token '<'"), cancelable: true });
  window.dispatchEvent(parse);
  expect(parse.defaultPrevented).toBe(true);
  const script = document.createElement('script');
  script.src = chunk;
  document.head.appendChild(script);
  const failed = new Event('error', { cancelable: true });
  script.dispatchEvent(failed);
  expect(failed.defaultPrevented).toBe(true);
  script.remove();
});

it('filters stale chunks at the Sentry boundary but preserves application errors', async () => {
  const init = vi.fn();
  vi.doMock('@sentry/react-native', () => ({ init }));
  vi.doMock('./web-chunk-recovery', () => import('./web-chunk-recovery.web'));
  vi.stubGlobal('__DEV__', false);
  vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
  window.sessionStorage.setItem('beeline.web-chunk-reload.v1', '1');
  await import('./sentry');
  const { beforeSend } = init.mock.calls[0]![0];
  const event = { exception: { values: [{ type: 'SyntaxError', value: "Unexpected token '<'", stacktrace: { frames: [{ filename: chunk }] } }] } };
  expect(beforeSend(event, {})).toBeNull();
  expect(beforeSend({ message: 'import failed' }, { originalException: new Error(`Loading module ${chunk} failed.`) })).toBeNull();
  event.exception.values[0]!.type = 'TypeError';
  event.exception.values[0]!.value = 'render failed';
  expect(beforeSend(event, {})).not.toBeNull();
  vi.unstubAllEnvs();
});
