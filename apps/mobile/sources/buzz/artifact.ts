/**
 * One artifact kind keyed by mime (plan: artifacts on object storage, T4).
 * The mime type alone selects preview, viewer, and open treatment — the same
 * decision the server lane applies at post time. Pure so the per-format
 * branches are testable without a renderer.
 */
export type ArtifactFormat = 'html' | 'svg' | 'image' | 'pdf' | 'markdown' | 'text' | 'document';
export type ArtifactSurface = 'ios' | 'android' | 'desktop';
export type ArtifactTreatment = 'inline' | 'external';

export interface ArtifactCapabilities {
  format: ArtifactFormat;
  preview: ArtifactTreatment;
  viewer: ArtifactTreatment;
}

export function artifactFormat(mimeType: string): ArtifactFormat {
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  if (mime === 'text/html') return 'html';
  if (mime === 'image/svg+xml') return 'svg';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  if (mime === 'text/plain' || mime === 'application/json' || mime === 'text/csv') return 'text';
  return 'document';
}

/**
 * The complete preview/viewer support table. A file can always be opened via
 * its signed browser link; `external` means there is no renderer on that
 * surface and the app deliberately hands it off.
 *
 * Every format the app can paint now paints on every surface: markup and
 * Markdown through their renderers, rasters through the platform image view,
 * plain text through the mono reader, and PDF through the vendored pdf.js
 * document. `document` — ZIP, octet-stream, anything unrecognized — is what
 * remains external, and the signed browser link stays on every card besides.
 */
export function artifactCapabilities(
  mimeType: string,
  _surface: ArtifactSurface,
): ArtifactCapabilities {
  const format = artifactFormat(mimeType);
  if (format === 'document') return { format, preview: 'external', viewer: 'external' };
  return { format, preview: 'inline', viewer: 'inline' };
}

/**
 * The card's crop of a text artifact: enough lines to fill the preview box,
 * each clipped so one very long line cannot push the rest off the card. The
 * viewer shows the whole file; this is only what the transcript displays.
 */
export const ARTIFACT_TEXT_PREVIEW_LINES = 12;
export const ARTIFACT_TEXT_PREVIEW_COLUMNS = 120;

export function artifactTextPreview(
  text: string,
  lines: number = ARTIFACT_TEXT_PREVIEW_LINES,
): string {
  return text
    .split('\n')
    .slice(0, lines)
    .map((line) => (line.length > ARTIFACT_TEXT_PREVIEW_COLUMNS
      ? `${line.slice(0, ARTIFACT_TEXT_PREVIEW_COLUMNS)}…`
      : line))
    .join('\n');
}

/** Extract the server media id from the canonical stored URL `/v1/media/<id>`. */
export function mediaIdFromUrl(url: string): string | null {
  const match = /\/v1\/media\/([0-9a-fA-F-]{8,64})/.exec(url);
  return match ? (match[1] ?? null) : null;
}

/** Defence in depth behind the script-off WebView: no network, no frames, inline styles and data images only. */
export const ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export const ARTIFACT_MAX_PREVIEW_HEIGHT = 220;

/**
 * The browser-default canvas: an unstyled page reads black-on-white, never
 * black on the app's ink plate (the sandbox WebView is transparent). The
 * sheet is injected ahead of the document's own styles, so any authored
 * background or color overrides it.
 */
export const ARTIFACT_DEFAULT_CANVAS = '<style>html{background:#ffffff}body{color:#111111}</style>';

/**
 * SVG bytes are wrapped in a minimal HTML document so the same sandbox
 * renders them. The wrapper carries the browser-default canvas exactly like
 * the HTML branch does: an SVG's default paint is black, and on a transparent
 * page that black lands on the app's ink plate — invisible in Obsidian, so
 * the whole viewer reads as a blank page. White canvas, then the centered
 * fit; the sheet comes after the canvas, and an SVG's own painted background
 * covers both.
 */
export function wrapArtifactMarkup(documentText: string, format: 'html' | 'svg'): string {
  if (format === 'html') return injectDefaultCanvas(injectCspMeta(documentText));
  return [
    '<!doctype html><html><head>',
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`,
    ARTIFACT_DEFAULT_CANVAS,
    '<style>html,body{margin:0;padding:0;height:100%}body{display:flex;align-items:center;justify-content:center;background:#ffffff}svg{max-width:100%;max-height:100%}</style>',
    '</head><body>',
    documentText,
    '</body></html>',
  ].join('');
}

/**
 * Inject the CSP meta as the FIRST head element so it precedes any other meta
 * or style the document already carries. A document without a head still gets
 * one; a document that already declares a CSP meta is left alone (ours wins by
 * being first — browsers honour the first policy).
 */
export function injectCspMeta(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
  if (/<meta[^>]+http-equiv=["']?content-security-policy/i.test(html)) {
    // Prepend ours ahead of the existing one anyway: first policy wins.
    return html.replace(/<head([^>]*)>/i, (head) => `${head}${meta}`);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (head) => `${head}${meta}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, (head) => `${head}<head>${meta}</head>`);
  }
  return `${meta}${html}`;
}

/**
 * Place the default-canvas sheet right after the CSP meta (which the CSP step
 * guarantees exists as the first head element), so it precedes every authored
 * style: first policy wins for the meta, last rule wins for the canvas.
 */
export function injectDefaultCanvas(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
  return html.replace(meta, `${meta}${ARTIFACT_DEFAULT_CANVAS}`);
}

/**
 * The viewer's navigation guard: allow exactly the initial string load, deny
 * every later request. Android fires `onShouldStartLoadWithRequest` for the
 * initial `about:blank` too, so the guard is a one-shot gate over requests,
 * not a URL matcher — the first request through the gate is allowed whatever
 * its URL, and every request after it is denied.
 */
export function createInitialLoadGuard(): { allow(requestUrl: string): boolean } {
  let consumed = false;
  return {
    allow(_requestUrl: string): boolean {
      if (consumed) return false;
      consumed = true;
      return true;
    },
  };
}
