import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'beeline.google-preview.v1';
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const listeners = new Set<() => void>();
let saving: Promise<void> = Promise.resolve();

/** Remove enrollment from navigation before diagnostics or routing can observe it. */
export function captureGooglePreviewUrl(value: string): { url: string; saved: Promise<void> } {
  let url: URL;
  try { url = new URL(value, 'https://web.usebeeline.app'); }
  catch { return { url: value, saved: saving }; }
  const tokens = url.searchParams.getAll('google_preview');
  if (!tokens.length) return { url: value, saved: saving };
  url.searchParams.delete('google_preview');
  if (tokens.length === 1 && TOKEN.test(tokens[0])) {
    const token = tokens[0];
    saving = saving.catch(() => undefined).then(() => AsyncStorage.setItem(STORAGE_KEY, token))
      .then(() => { for (const listener of listeners) listener(); });
  }
  return { url: url.toString(), saved: saving };
}

export function captureWebGooglePreview(): void {
  if (typeof window === 'undefined' || !window.location?.href) return;
  const captured = captureGooglePreviewUrl(window.location.href);
  if (captured.url !== window.location.href) window.history.replaceState(window.history.state, '', captured.url);
  void captured.saved.catch(() => undefined);
}

export function watchGooglePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function readAuthCapabilities(base: string): Promise<{ google?: boolean }> {
  captureWebGooglePreview();
  await saving.catch(() => undefined);
  const token = await AsyncStorage.getItem(STORAGE_KEY);
  const response = await fetch(`${base}/auth/capabilities`, {
    headers: token && TOKEN.test(token) ? { 'x-beeline-google-preview': token } : {},
    signal: AbortSignal.timeout(5_000),
  });
  return response.ok ? response.json() : {};
}
