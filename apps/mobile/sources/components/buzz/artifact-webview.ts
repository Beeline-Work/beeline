import { ARTIFACT_PDF_BASE_URL } from '@/buzz/artifact-pdf';
import { wrapArtifactSandbox } from '@/buzz/artifact';
/**
 * The one sandbox prop table for every artifact render, preview and full
 * screen: script off, no remote navigation, no new windows, no file access,
 * no message bridge (the key is absent, not set to undefined), and an inert
 * child document whose browser sandbox denies authored automatic refresh.
 *
 * `javaScript` is the single exception and it is not for artifact markup: the
 * generated PDF document (`buzz/artifact-pdf.ts`) IS the renderer, carrying
 * the vendored pdf.js build over bytes it decodes as data. Everything else in
 * the table — no remote navigation, no windows, no file access, no bridge, one-shot
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
  const file = 'uri' in source;
  if (file ? javaScript || !/^file:\/\/\/[^?#]*\.pdf$/i.test(source.uri)
    : javaScript ? source.baseUrl !== ARTIFACT_PDF_BASE_URL : source.baseUrl !== undefined)
    throw new Error('The private renderer requires an inline document or local PDF.');
  const initialUrl = file ? source.uri : source.baseUrl ?? 'about:blank';
  const inert = !file && !javaScript;
  let childLoaded = false;
  return {
    source: inert ? { html: wrapArtifactSandbox(source.html) } : source,
    javaScriptEnabled: javaScript,
    // An empty whitelist delegates rejected URLs to Linking before invoking
    // our callback. Every scheme must instead reach this deny-by-default gate.
    originWhitelist: ['*'],
    setSupportMultipleWindows: false,
    allowFileAccess: false,
    allowFileAccessFromFileURLs: false,
    allowUniversalAccessFromFileURLs: false,
    ...(file ? { allowingReadAccessToURL: source.uri } : {}),
    javaScriptCanOpenWindowsAutomatically: false,
    sharedCookiesEnabled: false,
    thirdPartyCookiesEnabled: false,
    domStorageEnabled: false,
    geolocationEnabled: false,
    mediaCapturePermissionGrantType: 'deny',
    mediaPlaybackRequiresUserAction: true,
    allowsFullscreenVideo: false,
    mixedContentMode: 'never',
    scrollEnabled,
    onShouldStartLoadWithRequest: (request: { url: string }) => {
      // This URL contains no transport or author-provided bytes. Native
      // engines may ask separately about the trusted inline child bootstrap.
      if (inert && request.url === 'about:srcdoc' && !childLoaded) {
        childLoaded = true;
        return true;
      }
      return request.url === initialUrl && guard.allow(request.url);
    },
  };
}
