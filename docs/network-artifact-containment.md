# Artifact containment and computer visibility

Ordinary HTML/SVG uses `wrapArtifactSandbox` in `apps/mobile/sources/buzz/artifact.ts` and the single native prop table in `artifact-webview.ts`. The trusted CSP precedes authored bytes. An inert `sandbox=""` child blocks automatic refresh in the browser engine; JavaScript navigation callbacks alone are insufficient because Android WebView can allow navigation after a stalled callback. Local PDF/pdf.js renderers retain their explicit separate paths. External Runnable and ComputerSession documents remain documented execution exceptions.

The local Chromium synthetic control requested its escaped refresh destination; the sandboxed candidate requested only its initial fixture document, retained text and authored CSS, and blocked the remote image. This establishes browser containment only. Physical runtime40/iOS/Tauri rendering, stalled-JS egress, PDF scrolling/Close and native resource budgets remain cohort gates.

`ComputerSession.tsx` uses the actual row viewport, committed Room focus and foreground owners. A visible full viewer suppresses duplicate card streams; hidden warm selection retains local selection only, with no full WebView or authorization read. Background/resume does not create another authorization opportunity. Existing Close/open controls and external browser semantics remain.

Executable regressions: `artifact.test.ts`, `artifact-pdf.test.ts`, `artifact-webview.test.ts`, `ArtifactViewer.test.tsx`, `ArtifactPdfView.test.tsx`, `DesktopArtifactPane.test.tsx`, `ComputerSession.test.tsx`, `DesktopRoomInspector.test.tsx` and `DesktopRoomInspector.resize-gesture.test.tsx` under the mobile sources. These do not by themselves close the full F01/F23 native/network workload proofs.
