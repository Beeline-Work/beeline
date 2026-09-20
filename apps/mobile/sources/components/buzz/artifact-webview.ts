/**
 * The one sandbox prop table for every artifact render, preview and full
 * screen: script off, no origins, no new windows, no file access, no message
 * bridge (the key is absent, not set to undefined), and the navigation guard
 * that allows exactly the initial string load and denies every later request.
 *
 * `javaScript` is the single exception and it is not for artifact markup: the
 * generated PDF document (`buzz/artifact-pdf.ts`) IS the renderer, carrying
 * the vendored pdf.js build over bytes it decodes as data. Everything else in
 * the table — no origins, no windows, no file access, no bridge, one-shot
 * guard — holds for it too.
 */
export interface ArtifactSource {
  source: { html: string; baseUrl?: string } | { uri: string };
  guard: { allow(requestUrl: string): boolean };
  scrollEnabled?: boolean;
  javaScript?: boolean;
}

export function artifactWebViewProps({
  source,
  guard,
  scrollEnabled = false,
  javaScript = false,
}: ArtifactSource): Record<string, unknown> {
  return {
    source,
    javaScriptEnabled: javaScript,
    originWhitelist: [],
    setSupportMultipleWindows: false,
    allowFileAccess: false,
    scrollEnabled,
    onShouldStartLoadWithRequest: (request: { url: string }) => guard.allow(request.url),
  };
}
