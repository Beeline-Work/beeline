/**
 * The PDF render document: one page of generated HTML that draws a PDF with
 * the vendored pdf.js build, used by both hosts that can paint one —
 * `react-native-webview` on Android and a blob-URL iframe in the desktop work
 * pane. iOS keeps the platform's own PDF view; it already renders one.
 *
 * Why this document is not the script-off sandbox the HTML/SVG artifacts get:
 * a PDF is not markup, so nothing the artifact's author wrote ever becomes
 * script here. The page is entirely ours — the pinned pdf.js build plus the
 * file's bytes as a base64 STRING that pdf.js decodes as data — and pdf.js is
 * asked never to eval (`isEvalSupported: false`). The document keeps the rest
 * of the posture: no network (the policy below denies every source but the
 * blob module, and the one-shot navigation guard refuses every request after
 * the initial load), no message bridge back to the app, and no file access.
 *
 * A blob URL on web and a baseUrl on Android give the module renderer a
 * real origin. Its worker stays inside a local blob under the document CSP.
 */
export const ARTIFACT_PDF_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src blob:; worker-src blob:; base-uri 'none'; form-action 'none'; frame-src 'none'";

/**
 * The origin the Android WebView document is given. It is never fetched: the
 * document arrives as a string and the initial-load guard denies every request
 * after it. It exists only so the page is not an opaque origin.
 */
export const ARTIFACT_PDF_BASE_URL = 'https://artifact.usebeeline.app/';

/** The card crop renders page one only; the viewer renders the whole file. */
export type ArtifactPdfMode = 'preview' | 'viewer';

export const ARTIFACT_PDF_FAILURE_TEXT = 'This PDF could not be rendered here — use Open in browser.';

export interface PdfViewerDocumentOptions {
  /** The file's bytes, base64 encoded. */
  pdfBase64: string;
  /** `pdf.min.mjs` source text. */
  mainSource: string;
  /** `pdf.worker.min.mjs` source text. */
  workerSource: string;
  mode: ArtifactPdfMode;

}

/**
 * Inline a JavaScript string into a `<script>` body. `JSON.stringify` covers
 * quoting; `</` has to be broken up separately because an HTML parser ends the
 * script element at `</script>` even inside a string literal.
 */
function inlineScriptString(source: string): string {
  return JSON.stringify(source).replace(/<\//g, '<\\/');
}

export function pdfViewerDocument({
  pdfBase64,
  mainSource,
  workerSource,
  mode,
}: PdfViewerDocumentOptions): string {
  const preview = mode === 'preview';
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PDF_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>',
    // The fitted page: every canvas takes the full width of the host and keeps
    // its own aspect ratio, so a page is never cropped sideways or zoomed past
    // the frame. White canvas for the same reason the markup sandbox has one —
    // a PDF page is paper, not the app's ink plate.
    `html,body{margin:0;padding:0;background:#ffffff;${preview ? 'overflow:hidden;' : ''}}`,
    'canvas{display:block;width:100%;height:auto;margin:0 auto 8px}',
    '#fallback{display:none;margin:0;padding:16px;font:14px -apple-system,system-ui,sans-serif;color:#555555;text-align:center}',
    '</style></head><body>',
    '<div id="pages"></div><p id="fallback"></p>',
    '<script>',
    `var PDFJS_MAIN=${inlineScriptString(mainSource)};`,
    `var PDFJS_WORKER=${inlineScriptString(workerSource)};`,
    `var PDF_BASE64=${inlineScriptString(pdfBase64)};`,
    `var PAGE_LIMIT=${preview ? 1 : 0};`,
    `var FAILURE_TEXT=${inlineScriptString(ARTIFACT_PDF_FAILURE_TEXT)};`,
    PDF_RENDER_SCRIPT,
    '</script></body></html>',
  ].join('');
}

/**
 * The render half, kept as its own source constant so the document builder
 * above stays readable. It runs inside the generated page, never in the app.
 */
const PDF_RENDER_SCRIPT = `
(function () {
  var pages = document.getElementById('pages');
  var settled = false;
  function fail() {
    if (settled) return;
    settled = true;
    pages.innerHTML = '';
    var note = document.getElementById('fallback');
    note.textContent = FAILURE_TEXT;
    note.style.display = 'block';
  }
  function bytesFromBase64(encoded) {
    var raw = atob(encoded);
    var bytes = new Uint8Array(raw.length);
    for (var index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }
  function renderPage(pdfjs, pdf, number) {
    return pdf.getPage(number).then(function (page) {
      var unscaled = page.getViewport({ scale: 1 });
      var width = document.documentElement.clientWidth || unscaled.width;
      // Draw at the device's pixel density so the fitted page is
      // sharp, then let CSS scale the canvas back down to the frame width.
      var density = window.devicePixelRatio || 1;
      var viewport = page.getViewport({ scale: (width / unscaled.width) * density });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      pages.appendChild(canvas);
      return page.render({
        canvas: canvas,
        canvasContext: canvas.getContext('2d'),
        viewport: viewport,
      }).promise;
    });
  }
  try {
    var mainUrl = URL.createObjectURL(new Blob([PDFJS_MAIN], { type: 'text/javascript' }));
    var workerUrl = URL.createObjectURL(new Blob([PDFJS_WORKER], { type: 'text/javascript' }));
    import(mainUrl)
      .then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        return pdfjs.getDocument({ data: bytesFromBase64(PDF_BASE64), isEvalSupported: false }).promise.then(
          function (pdf) {
            var last = PAGE_LIMIT > 0 ? Math.min(pdf.numPages, PAGE_LIMIT) : pdf.numPages;
            var chain = Promise.resolve();
            for (var number = 1; number <= last; number += 1) {
              chain = chain.then(renderPage.bind(null, pdfjs, pdf, number));
            }
            return chain;
          },
        );
      })
      .then(function () {
        if (settled) return;
        settled = true;
      })
      .catch(function () {
        fail();
      });
  } catch (error) {
    fail();
  }
})();
`;

/**
 * The same document with the vendored renderer supplied. The import is lazy on
 * purpose: the pdf.js build is a megabyte of source text and no transcript
 * that lacks a PDF should pay to evaluate it.
 */
export async function loadPdfViewerDocument(options: {
  pdfBase64: string;
  mode: ArtifactPdfMode;
}): Promise<string> {
  const { PDFJS_MAIN_SOURCE, PDFJS_WORKER_SOURCE } = await import('@/vendor/pdfjs/pdfjs.gen');
  return pdfViewerDocument({
    pdfBase64: options.pdfBase64,
    mainSource: PDFJS_MAIN_SOURCE,
    workerSource: PDFJS_WORKER_SOURCE,
    mode: options.mode,
  });
}
