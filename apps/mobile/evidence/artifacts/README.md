# Artifacts lane B — Android emulator evidence

Captured on `emulator-5554` (buzzy_api36, 1080x2400) running a debug dev-client
build of the real app (`npx expo run:android`) connected to Metro, with
`EXPO_PUBLIC_BUZZY_MONOLITH_URL` pointed at a throwaway local fixture HTTP
server that serves real HTML/SVG/Markdown/PDF/zip bytes at `/v1/media/<id>`
and a fake `/v1/auth/github/exchange` (no real backend/session — the artifacts
storage lane's server routes are not yet reachable from this sandbox, so this
follows the brief's "build against a fixture projection" instruction). The
screens themselves are the real, unmodified `ArtifactCard` / `ArtifactViewer`
production components — not an HTML mock.

- `preview-cards-html-svg.png` — the real on-device sandboxed render, snapshotted
  once and cached (script off, no status label, caption with author/size,
  `Open in browser` / `Open` footer) for an HTML artifact and an SVG artifact.
- `preview-cards-markdown-pdf-document.png` — the Markdown card rendered
  through the app's own `MonoMarkdown` renderer, the PDF card on Android
  (document-style row, both footer actions since Android hands PDFs to the
  system viewer), and the document-fallback card for an unrecognized mime
  (`application/zip`, browser-only footer action).
- `fullscreen-html.png` — the full-screen sandboxed viewer (mock 1c): title
  header with close affordance, the whole page rendered script-off.

Notes:
- The very first WebView render in a cold app process crashed once (a known
  Android WebView cold-start issue on this emulator, visible in logcat as
  `aw_browser_terminator: Renderer process crash detected`); a second app
  launch rendered and captured cleanly. Nothing in the shipped code retries a
  crashed WebView — this is a one-time cold-start artifact of the throwaway
  harness, not a defect in the feature.
- Full-screen capture used a direct-render harness button rather than the
  production `Modal.show` path: the modal backdrop never finished animating
  in when the screen was reached by deep-linking directly into an
  unauthenticated fixture session outside the app's normal navigation stack.
  The unit tests (`ArtifactCard.test.tsx`) already assert `Modal.show` is
  called with the right component/props; this is a harness limitation, not a
  reproduction inside the real app flow.
