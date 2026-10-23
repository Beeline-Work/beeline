# Approval card anatomy, revision 3

This is a design unification, not a defect report. Reproduction stand-in `APPROVAL-V3` uses the production card components and `sources/unistyles.ts` on a leased Android emulator with the installed development client (native runtime 39), serving this branch through Metro. Disposable fixtures stand in for live vault, checkout, host grant, connector and target-branch ceremonies; no production permission or purchase is exercised.

The asking agent picture comes from roster presentation while the card identity deliberately omits its avatar. Bone and Obsidian are selected through `setAppAppearance`, and the screenshot capture checks the canvas pixel against that theme. Each image is an unmodified Android screenshot.

To repeat, temporarily replace `index.ts` with `import './scripts/squire-approval-native-proof';`, start Metro, forward its port and the fixture avatar server, then open the development client. `scripts/approval-card-proof-assets.py` serves the saved asking-agent image locally. Use Bone / Obsidian and Next to traverse the fixtures. Restore the production entry before validation or committing.

The fixture buttons record “Action received”; Squire Review keeps its external URL and View request keeps its source navigation. Real server integration coverage exercises posting a Squire approval, settling its original System card, retaining the Room decision and resume, declining a target proposal, confirming a branch, and declining a connector with a resume. The theme tests cover every fixture plus tray action ordering with stable original action testIDs.

| Call site / state | Bone | Obsidian |
| --- | --- | --- |
| grant-legacy | [Android](bone/grant-legacy.png) | [Android](obsidian/grant-legacy.png) |
| grant-purpose | [Android](bone/grant-purpose.png) | [Android](obsidian/grant-purpose.png) |
| squire-key | [Android](bone/squire-key.png) | [Android](obsidian/squire-key.png) |
| squire-purchase | [Android](bone/squire-purchase.png) | [Android](obsidian/squire-purchase.png) |
| squire-login | [Android](bone/squire-login.png) | [Android](obsidian/squire-login.png) |
| squire-edit-key | [Android](bone/squire-edit-key.png) | [Android](obsidian/squire-edit-key.png) |
| squire-delete-key | [Android](bone/squire-delete-key.png) | [Android](obsidian/squire-delete-key.png) |
| squire-edit-card | [Android](bone/squire-edit-card.png) | [Android](obsidian/squire-edit-card.png) |
| squire-vouch | [Android](bone/squire-vouch.png) | [Android](obsidian/squire-vouch.png) |
| squire-passkey | [Android](bone/squire-passkey.png) | [Android](obsidian/squire-passkey.png) |
| spending | [Android](bone/spending.png) | [Android](obsidian/spending.png) |
| edit-corner | [Android](bone/edit-corner.png) | [Android](obsidian/edit-corner.png) |
| target-branch | [Android](bone/target-branch.png) | [Android](obsidian/target-branch.png) |
| connector-add | [Android](bone/connector-add.png) | [Android](obsidian/connector-add.png) |
| connector-switch | [Android](bone/connector-switch.png) | [Android](obsidian/connector-switch.png) |
| connector-reconnect | [Android](bone/connector-reconnect.png) | [Android](obsidian/connector-reconnect.png) |
| grant-allowed | [Android](bone/grant-allowed.png) | [Android](obsidian/grant-allowed.png) |
| grant-denied | [Android](bone/grant-denied.png) | [Android](obsidian/grant-denied.png) |
| squire-allowed | [Android](bone/squire-allowed.png) | [Android](obsidian/squire-allowed.png) |
| squire-denied | [Android](bone/squire-denied.png) | [Android](obsidian/squire-denied.png) |
| permission-allowed | [Android](bone/permission-allowed.png) | [Android](obsidian/permission-allowed.png) |
| target-denied | [Android](bone/target-denied.png) | [Android](obsidian/target-denied.png) |
| connector-allowed | [Android](bone/connector-allowed.png) | [Android](obsidian/connector-allowed.png) |
| connector-denied | [Android](bone/connector-denied.png) | [Android](obsidian/connector-denied.png) |
| tray | [Android](bone/tray.png) | [Android](obsidian/tray.png) |

[Android interaction receipts](interaction-receipts.json) confirm callback delivery for grant No, Squire View request, spending Allow once, target No and connector No; vault-reference expansion was also exercised. These fixture callbacks do not grant production permissions. The server integration tests establish the corresponding committed decision behavior.
