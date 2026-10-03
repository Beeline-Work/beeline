# Design inconsistencies: both-theme evidence (PR #2044)

Every `after-<theme>-<page>.png` is painted by `apps/mobile/scripts/design-proof.tsx` with the real components, in the theme the shimmed Unistyles hands them, and captured in headless Chrome at react-native-web. To reproduce:

```sh
cd apps/mobile
DESIGN_PROOF_OUT=../../docs/evidence/design-inconsistencies npx vitest run sources/test/design-proof.browser
```

The run fails if any page throws. `before-*.png` are the same board rendered from the base commit before the fix.

| Page | Surfaces | Classes |
| --- | --- | --- |
| `board` | TranscriptCard (theme brass, 16/13 sizes), WorkflowGlyph idle/live, unread Room row (`bgUnread`), italic emphasis by weight, `Typography.default()` face, `dialogDanger` text, the one `Button` (primary/secondary/brass), flat UpdateReadyPrompt, per-theme dialog shadow, "View corner" link, corner dropdown `#` mark | 1, 2, 3, 5, 6, 7 |
| `frames` | ArtifactCard, the connector card (`AppSignInCard`) and the notification card (`NotificationLifecycleCard`) on the TranscriptCard frame | 5 |
| `workflows`, `language`, `text-selection` | The three screens that now draw the shared `PageHeader` | 5 |
| `members` | The corner overflow sheet's Members row with its count, as the corner surface renders it (`HullActionSheetModal` + `HullActionSheetRow`) | 7 |
| `welcome-1` … `welcome-4` | Every Welcome scene, reached by pressing Next, with the shared 44-point `Button` | 1, 5 |

Not shown here:

- **Android elevation** (UpdateReadyPrompt, NewRoomDialog owner menu): no Android emulator is available on this machine, so there is no native capture. The `elevation` properties are deleted, and the design lint now fails on any non-zero `elevation` outside HullDialog/HullActionSheet.
- **The native command palette** now sits 30% of the window down, as web's `30vh`; web rendering is unchanged.
