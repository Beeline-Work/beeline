# Approved round-seven production homepage evidence

Captured from the real static marketing page at http://127.0.0.1:4388 using chrome-devtools-axi. These are local pre-deployment results.

- 28 targeted Node tests pass: landing assets/controller, platform downloads, attribution and Pages output.
- Desktop 1440px and phones 360/390/412/430px: literal-text safety, keyboard send, local replies, two-way terminal/Room interaction, terminal header bounds and tool disclosure/output pass.
- 336 phone scene/boundary checks pass across four phone widths, expanded/collapsed browser toolbar states and DPR 2.6, with no avatar collision or clipping.
- All five entry methods (scrollBy, wheel, touch, PageDown and direct hash) run join → work → two-way sync → repeated cycles; leaving and returning restarts playback. Codex rail/transcript identity matches.
- Actual CDP reduced-motion emulation: settled hero/connected terminal, no autoplay and zero running animations; keyboard focus remains visible and Escape closes the download chooser.
- All five existing platform download destinations return HTTP 200 after redirects. Signed redirect query strings are omitted from downloads.json.
- Three serial cold mobile navigation audits using the full official Lighthouse SDK, default simulated slow 4G and 4× CPU: performance 99/99/100 (median 99), accessibility/best-practices/SEO 100 in every run. LCP 1.51–1.66s; CLS 0.000427–0.000537. Full reports and summary are included. AXI's bundled timing audit shims were not used for these measurements.

Reproduction commands and architecture: [marketing guide](../../../web/marketing/README.md). Screenshots show real generated shared-component markup and the dependency-free lazy demo, not the archived React mock.
