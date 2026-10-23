# Approval card anatomy and language, revision 4

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
| grant-allowed (Once) | [Android](bone/grant-allowed.png) | [Android](obsidian/grant-allowed.png) |
| grant-always | [Android](bone/grant-always.png) | [Android](obsidian/grant-always.png) |
| grant-denied | [Android](bone/grant-denied.png) | [Android](obsidian/grant-denied.png) |
| squire-allowed | [Android](bone/squire-allowed.png) | [Android](obsidian/squire-allowed.png) |
| squire-denied | [Android](bone/squire-denied.png) | [Android](obsidian/squire-denied.png) |
| squire-expired | [Android](bone/squire-expired.png) | [Android](obsidian/squire-expired.png) |
| permission-allowed | [Android](bone/permission-allowed.png) | [Android](obsidian/permission-allowed.png) |
| target-denied | [Android](bone/target-denied.png) | [Android](obsidian/target-denied.png) |
| connector-allowed | [Android](bone/connector-allowed.png) | [Android](obsidian/connector-allowed.png) |
| connector-denied | [Android](bone/connector-denied.png) | [Android](obsidian/connector-denied.png) |
| tray (command and reason) | [Android](bone/tray.png) | [Android](obsidian/tray.png) |
| tray-write | [Android](bone/tray-write.png) | [Android](obsidian/tray-write.png) |
| tray-connector | [Android](bone/tray-connector.png) | [Android](obsidian/tray-connector.png) |
| tray-squire | [Android](bone/tray-squire.png) | [Android](obsidian/tray-squire.png) |
| tray-legacy (old server payload) | [Android](bone/tray-legacy.png) | [Android](obsidian/tray-legacy.png) |

[Android interaction receipts](interaction-receipts.json) confirm callback delivery for grant No, Squire View request, spending Allow once, target No and connector No; vault-reference expansion was also exercised. These fixture callbacks do not grant production permissions. The server integration tests establish the corresponding committed decision behavior.

[Previous-client compatibility receipt](old-client-compatibility.json): the unmodified tray renderer from the previous PR head renders the new server copy and labels, and No still dispatches deny at its original action index. Only its relative import paths were adapted for the temporary test location.

## Decision attribution and language (revision 4)

Squire's provider notifier (`apps/mcp/src/approval-decided-notifier.ts`, `ApprovalDecidedNotifier.run`) emits only `approval_id` and `status`. The helper matches this authenticated notification to a pending request and relays that decision; neither the provider payload nor the shared decision contract contains a verified human. Squire receipts therefore use “The request to <action> was allowed / was denied / expired”, and the original card uses neutral “Allowed / Denied” without naming an assumed owner. The stored original card supplies the action; legacy helpers use the shared action fallback. Raw vault references stay in folded details.

Grants, target proposals and connector decisions retain their authenticated phone decision-maker. Their cards say “by you” only when that identity matches the current viewer, otherwise “by @handle”. Expiry remains distinct from denial. No decision event is suppressed or relocated, and paused-turn resume and deduplication retain their existing wire contracts. Named decision-makers on non-Squire cards are disposable fixtures for verified-human rendering. Squire settled fixtures deliberately omit a person and demonstrate neutral wording.

## Review regressions

The tray now renders the exact subject separately from the reason. New server payloads put the subject in `item.text` and the reason in `approval.detail`, so the previous client keeps both. The current client reads `approval.subject` even when an older server put the reason in `item.text`. Android cases cover command, edit permission, connector and Squire rows, plus that old payload. The previous-client receipt now asserts the command itself as well as its reason.

Settled grants retain `Allowed by you · time` and show `Scope: Once` or `Scope: Always` beside it. This keeps the existing host-purpose assertions unchanged and preserves the same facts without adding another row. Android capture checks both scope and verified attribution in the native accessibility tree.

[Original approved mock](approved-mock-v2.html), recovered from the revision-three manifest path, is byte-for-byte SHA-256 `b6600fcf2a52071b3248b273d265e73ea2b93d6ccbefc7928ec70723ce67b0c8`. Its tray illustration originally showed the reason alone; the later authorized wording story and reviewer instructions require the action to remain visible too.

## Previous app: denied connector offers

[Historical parser receipt](old-client-connector-denied.json) runs the production API guards from client head `7539857263f95edf7b5db4ba34d95db2313571bc`. Its [connector reader](https://github.com/Beeline-Work/beeline/blob/7539857263f95edf7b5db4ba34d95db2313571bc/packages/api-contract/src/phone-guards.ts#L609) returns null for the unknown `denied` status. The [message reader](https://github.com/Beeline-Work/beeline/blob/7539857263f95edf7b5db4ba34d95db2313571bc/packages/api-contract/src/phone-guards.ts#L1122) omits that nullable connector card and preserves the message and request text, rather than rejecting the whole message. Thus an older build has readable request text without an active connector approval card; it does not know the new Denied presentation. The proof also accepts a pending card first, so the denied result is specific to its unfamiliar status.
