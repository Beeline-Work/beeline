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
 * pdf.js needs a real origin — inside an opaque one (a `sandbox` iframe, a
 * `srcdoc` frame) its module load and worker never settle, so the renderer
 * hangs on a blank page. Hence the blob URL on web and the `baseUrl` on
 * Android, and hence the main-thread "fake worker": it removes the blob
 * `Worker` construction, which is the step that hangs silently.
 */
export const ARTIFACT_PDF_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src blob:";

/**
 * The origin the Android WebView document is given. It is never fetched: the
 * document arrives as a string and the initial-load guard denies every request
 * after it. It exists only so the page is not an opaque origin.
 */
export const ARTIFACT_PDF_BASE_URL = 'https://artifact.usebeeline.app/';

/** The card crop renders page one only; the viewer renders the whole file. */
export type ArtifactPdfMode = 'preview' | 'viewer';

/** A PDF that never finishes rendering must say so rather than sit blank. */
export const ARTIFACT_PDF_RENDER_TIMEOUT_MS = 20_000;
export const ARTIFACT_PDF_FAILURE_TEXT = 'This PDF could not be rendered here — use Open in browser.';

/**
 * The document's one signal back to the app, and it is not a bridge: when the
 * page has finished painting (or given up) it navigates here, the navigation
 * guard refuses the request as it refuses every other, and the refusal is the
 * message. The card needs it because pdf.js paints well after the page's own
 * load event — snapshotting on load would cache a blank thumbnail.
 */
export const ARTIFACT_PDF_RENDERED_URL = 'beeline-artifact://pdf-rendered';

export interface PdfViewerDocumentOptions {
  /** The file's bytes, base64 encoded. */
  pdfBase64: string;
  /** `pdf.min.mjs` source text. */
  mainSource: string;
  /** `pdf.worker.min.mjs` source text. */
  workerSource: string;
  mode: ArtifactPdfMode;
  /**
   * Navigate to `ARTIFACT_PDF_RENDERED_URL` once the page has settled. Only
   * the Android card wants it — it is the cue to snapshot the thumbnail. The
   * desktop frame paints live and has no snapshot to take, so its document
   * leaves the signal out rather than aiming the browser at a scheme it has
   * no handler for.
   */
  signalRendered?: boolean;
}

/**
 * Wraps the one-shot navigation guard so the render document's completion
 * navigation calls `onRendered` on its way to being refused. The signal is a
 * denied request, never a granted one: the wrapped guard still answers `false`
 * for it, and every other request goes to the guard underneath untouched — so
 * the initial load is still the only navigation that ever passes.
 */
export function pdfRenderedSignalGuard(
  guard: { allow(requestUrl: string): boolean },
  onRendered: () => void,
): { allow(requestUrl: string): boolean } {
  return {
    allow(requestUrl: string): boolean {
      if (requestUrl.startsWith(ARTIFACT_PDF_RENDERED_URL)) {
        onRendered();
        return false;
      }
      return guard.allow(requestUrl);
    },
  };
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
  signalRendered = false,
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
    `var RENDER_TIMEOUT_MS=${ARTIFACT_PDF_RENDER_TIMEOUT_MS};`,
    `var RENDERED_URL=${signalRendered ? inlineScriptString(ARTIFACT_PDF_RENDERED_URL) : 'null'};`,
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
  // pdf.js reaches for a Worker first and, from a blob URL, that construction
  // can resolve to a worker that never answers — the promise then hangs with
  // no error. Taking Worker away puts it on its documented main-thread path.
  try { Object.defineProperty(window, 'Worker', { value: undefined, configurable: true }); } catch (error) {}
  var pages = document.getElementById('pages');
  var settled = false;
  var signalled = false;
  // The page's one cue back to the host, and it is not a bridge: a navigation
  // the guard refuses, whose refusal is the message. Sent only once the
  // browser has actually painted — the render promise resolves when the
  // bitmap is written, not when it is on screen, and the host snapshots what
  // is on screen. Two frames is what guarantees the paint has landed.
  function signal() {
    if (!RENDERED_URL || signalled) return;
    signalled = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        window.location.href = RENDERED_URL;
      });
    });
  }
  function fail() {
    if (settled) return;
    settled = true;
    pages.innerHTML = '';
    var note = document.getElementById('fallback');
    note.textContent = FAILURE_TEXT;
    note.style.display = 'block';
    signal();
  }
  var timer = setTimeout(fail, RENDER_TIMEOUT_MS);
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
      // Draw at the device's pixel density (capped) so the fitted page is
      // sharp, then let CSS scale the canvas back down to the frame width.
      var density = Math.min(window.devicePixelRatio || 1, 2);
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
        clearTimeout(timer);
        signal();
      })
      .catch(function () {
        clearTimeout(timer);
        fail();
      });
  } catch (error) {
    clearTimeout(timer);
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
  signalRendered?: boolean;
}): Promise<string> {
  const { PDFJS_MAIN_SOURCE, PDFJS_WORKER_SOURCE } = await import('@/vendor/pdfjs/pdfjs.gen');
  return pdfViewerDocument({
    pdfBase64: options.pdfBase64,
    mainSource: PDFJS_MAIN_SOURCE,
    workerSource: PDFJS_WORKER_SOURCE,
    mode: options.mode,
    signalRendered: options.signalRendered,
  });
}
