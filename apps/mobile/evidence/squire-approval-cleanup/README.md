# Squire approval card cleanup

Reproduction: `R-SQUIRE-CARD`. Scope follows brief revision 2: logo and footer only.

| Before | After |
| --- | --- |
| [Android before](android-before.png) | [Android after](android-after.png) |

The same native fetch_credential approval card originally showed the requesting agent’s face and a wrapped “approval stays with Trusty Squire” footer. It now shows the existing `/v1/connectors/logo/trusty-squire.svg` logo and only Review and View request in the footer. Requester attribution remains in the subline. The actions retain their native touch height.

A fresh production approval requires a new vault/passkey ceremony. These captures use the production `SquireApprovalCard` on a leased Android emulator with the same disposable approval data before and after the change; they do not exercise a live vault ceremony. The logo loaded from the production connector URL. No server change or deployment was needed.

To repeat, temporarily select `apps/mobile/scripts/squire-approval-native-proof.tsx` as the native app entry, start Metro with the installed development client, and open it on the leased emulator. Restore the normal app entry before running the mobile suite.

Regression tests in `RoomMessageVariants.test.tsx` assert the Squire logo source, retained requester attribution and actions, absent footer text for Squire and Link, and Link’s unchanged identity. The existing Review/source-link behavior test is unchanged. Only Android was used for manual UI verification; browser tests remain part of the required mobile suite.
