/**
 * The one sandbox prop table for every artifact render, preview and full
 * screen: script off, no origins, no new windows, no file access, no message
 * bridge (the key is absent, not set to undefined), and the navigation guard
 * that allows exactly the initial string load and denies every later request.
 */
export interface ArtifactSource {
  source: { html: string } | { uri: string };
  guard: { allow(requestUrl: string): boolean };
  scrollEnabled?: boolean;
}

export function artifactWebViewProps({
  source,
  guard,
  scrollEnabled = false,
}: ArtifactSource): Record<string, unknown> {
  return {
    source,
    javaScriptEnabled: false,
    originWhitelist: [],
    setSupportMultipleWindows: false,
    allowFileAccess: false,
    scrollEnabled,
    onShouldStartLoadWithRequest: (request: { url: string }) => guard.allow(request.url),
  };
}
