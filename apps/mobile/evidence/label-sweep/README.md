# Label sweep proof

Reproductions 1–3 from brief revision 1. The screenshots render real React Native
components in Chrome at 390 CSS pixels, before (`ccff4a670`) and after the label
sweep. Each PNG is full size. Bone and Obsidian each have before/after captures
for model labels, the browser header, close, destinations, rows, symbols and sign-in.

The model fixture uses the helper's captured default/Opus catalog and the shared
model-name resolver. It renders LedgerBylineView and SettingsRow; the picker value
comes from modelPickerChoiceLabel. The integration test separately exercises the
server roster projection, including catalogs without descriptions or options.

The other captures render ComputerSessionViewer, TranscriptCard, ArtifactCard,
SquireApprovalCard, SlashVerbPicker, StarPromptCard and ConnectorOfferCard. Native
APIs and server requests are stubbed, so the viewer frame and artifact preview are
unavailable; the actual header/footer/card controls remain real. The browser
viewer screenshot is a stand-in for the native Android path. No Android device
was attached; no branch APK was present.

To repeat, extract the baseline's `apps/mobile` into a scratch directory, link its
node_modules to the installed mobile dependencies, and copy
`scripts/label-sweep-components-proof.tsx` there. Then, from apps/mobile:

```sh
LABEL_BASELINE_MOBILE=/absolute/baseline/apps/mobile \
LABEL_PROOF_DIR="$PWD/evidence/label-sweep" \
npx vitest run sources/test/label-sweep-proof.browser.test.ts --maxWorkers=1 --minWorkers=1
```

The label audit scanner leaves only the guard's named status-mark allowlist and
vendored PDF worker source. The TypeScript guard checks every audited close uses
CloseButton and rejects typed marks outside the allowlist. All audited production
spots are in the original label-sweep commit; the repair adds tolerance for stored
catalogs missing options and updates only the approved model-notice lock entry.
