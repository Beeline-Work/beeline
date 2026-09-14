import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import type React from 'react';

type WebViewComponent = React.ComponentType<Record<string, unknown>>;

// Module-level so every card/viewer shares one load; `import()` (never
// `require`) so node-side unit tests can mock the module — a literal
// `require()` call bypasses vi.mock and resolves the real native package.
let webviewModule: WebViewComponent | null | undefined;
let webviewLoad: Promise<WebViewComponent | null> | null = null;

function loadSandboxWebView(): Promise<WebViewComponent | null> {
  if (webviewModule !== undefined) return Promise.resolve(webviewModule);
  if (Platform.OS === 'web') {
    webviewModule = null;
    return Promise.resolve(null);
  }
  webviewLoad ??= import('react-native-webview')
    .then((mod) => {
      webviewModule = (mod as { default?: WebViewComponent }).default ?? null;
      return webviewModule;
    })
    .catch(() => {
      webviewModule = null;
      return null;
    });
  return webviewLoad;
}

/** The sandboxed WebView component once it has loaded, or null before/never. */
export function useSandboxWebView(): WebViewComponent | null {
  // A component function passed directly is a value, but React's useState
  // and its setter both treat a bare function argument as a lazy
  // initializer/updater — wrap every read and write in `() => value`.
  const [webView, setWebView] = useState<WebViewComponent | null>(() =>
    webviewModule !== undefined ? webviewModule : null,
  );
  useEffect(() => {
    let live = true;
    void loadSandboxWebView().then((mod) => {
      if (live) setWebView(() => mod);
    });
    return () => {
      live = false;
    };
  }, []);
  return webView;
}

/** Test seam: forget the cached module so a test can re-probe it. */
export function resetSandboxWebViewCache(): void {
  webviewModule = undefined;
  webviewLoad = null;
}
