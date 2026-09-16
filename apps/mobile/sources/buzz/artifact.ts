/**
 * One artifact kind keyed by mime (plan: artifacts on object storage, T4).
 * The mime type alone selects preview, viewer, and open treatment — the same
 * decision the server lane applies at post time. Pure so the per-format
 * branches are testable without a renderer.
 */
export type ArtifactFormat = 'html' | 'svg' | 'pdf' | 'markdown' | 'document';

export function artifactFormat(mimeType: string): ArtifactFormat {
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  if (mime === 'text/html') return 'html';
  if (mime === 'image/svg+xml') return 'svg';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  return 'document';
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
