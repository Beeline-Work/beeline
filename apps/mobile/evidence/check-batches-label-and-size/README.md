# Folded GitHub card Android evidence

Captured on 2026-09-13 from the installed Beeline Expo Android application on
`emulator-5556` (1080x2400). The app was authenticated as `local:captain`
against an isolated local Beeline server and PostgreSQL database. The corner
transcript was read through the real phone Room API; no fixture renderer or
standalone mock was presented as the app.

- `android-pr-folded-merge-inline.png` — a collapsed PR batch is one line and
  keeps the newest merged PR title inline.
- `android-pr-expanded.png` — the same PR batch expanded to all PR rows.
- `android-check-folded-failure-and-live-batch.png` — one-line green checks,
  an inline failed check, and one head-keyed live batch spanning two webhook
  bursts.
- `android-check-expanded.png` — an all-green check batch expanded to its
  individual check rows.
- `android-tool-notes-folded.png` — two adjacent counted notes separated only
  by thinking/summary activity rendered as one `3 TOOL CALLS` note.

The approved static design comparison remains in
`docs/evidence/card-fold-mock/mock.html`; it is evidence of the design decision,
not an application capture.
