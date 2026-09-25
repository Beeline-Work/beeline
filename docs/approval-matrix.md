# Repository and personal-resource approvals

| Agent / original requester | Repository permissions | Personal resources |
| --- | --- | --- |
| Non-yolo / anyone | Ask in the Room; a Workspace owner or admin decides | Ask privately; only the resource owner decides |
| Yolo / owner | Skip permission prompts | Skip prompts for that owner's resources |
| Yolo / third party | Skip permission prompts | Ask the resource owner privately |

Approved resource access includes paid calls within the approved target, Room, and original requester scope. There is no separate generic budget approval. Historical budget grants remain readable; new requests are rejected. Existing credential-file and unread-script safeguards still apply to granted host commands, including script byte binding.

Repository grants use the `repository` kind. Host paths, devices, secrets, host commands and MCP routes are personal resources owned by the helper's owner. Repository cards live in the requesting Room or corner. Personal-resource cards and automatic approval receipts live in the owner's private system/connector DM; Workspace administrators cannot decide them or read their grant details through an agent profile.

`DaemonService` resolves the requester from the authenticated active command's `root_source_message_id`. Delegations, corner objectives and approval resumes retain that root. There is no latest-message lookup or owner fallback. An agent-originated root does not become an owner request. Live command grants are filtered to the current Room and original requester before execution, and old automatic grants stop applying when yolo is disabled or the Workspace is public.

All imported MCP routes, including declarations formerly marked local, and the built-in YouTube tool use a transport facade that checks every resource call, including harnesses that omit permission callbacks. Tool discovery is mounted without granting resource access, allowing owner-yolo use without a preliminary approval prompt. Mounting a Once route does not consume it; the server consumes it atomically at its first authorized call. Wallet tools use the same resource gate before reading wallet information or spending. Wallet signing delegation and sufficient funds remain required.

Every corner turn checks the live repository gate before running its prompt. The current corner harness also has host shell access, so it checks a separate host grant before starting or resuming the autonomous harness; repository permission never grants machine access. Under yolo, the owner bypasses this host prompt, while another requester needs private owner approval. This deliberately applies even to a repository task running in that host-capable harness. Approval does not replace the existing exact-head reviewer/CI/human-hold merge gate. Top-level Rooms retain their read-only filesystem boundary.

Coverage: server `integration.test.ts` (matrix, private decisions, target scope, delegation/resume, revoked and Once grants, command reuse), `wallet.integration.test.ts`; body `grant-runner.test.ts`, `host-mcp-route.test.ts`, Room/corner permission tests; mobile `RoomMessageVariants.test.tsx`.

Upgrade: existing shared personal-resource request cards and automatic receipts move to the resource owner's private system DM. Grants without matching original-command provenance, automatic third-party resource grants, grants approved by someone other than the resource owner, and historical active budget grants are revoked. Still-valid pending grants retain their ids and original command, and remain pending. The upgrade is idempotent and does not widen old approvals.

Resource ownership is the helper owner's host/tool inventory; wallet and Squire retain their existing owner-bound account resolution. The agent owner's approval is not permission to route another person's Workbench connection through that helper. Generic imported tools must be provisioned for that helper owner. Filesystem confinement is still the documented hygiene boundary, not a new security sandbox; the new host approval precedes use of that existing host-capable runtime. Credential-file and unread-script hard stops remain enforced by the granted-command runner, and payment delegation, funds, and merge/review rules remain independent.

Release server and its schema migration before updating helpers, because new helpers call new authorization operations. The PR becomes ready for review once the complete implementation and local acceptance evidence are available; merging still requires current-head CI and configured-reviewer approval. No claim of spending caps is made.

## Implementation and evidence checklist

Evidence recorded for implementation commit `f86fd5a3`; PR #1712 carries the same criteria-to-evidence mapping and the full validation limitations.

- [x] Authenticated original-requester provenance: `DaemonService.grantRequester` resolves the command root; integration delegation/resume and command-reuse tests passed.
- [x] Repository, host and resource matrix: four integration cases exercise owner/third-party requesters with yolo on/off, including direct API decision checks and private-card reads.
- [x] Execution boundaries: corner tests suppress autonomous prompts without repository or host authorization; actual stdio/HTTP transport tests change requester within the same running process; command-runner tests exercise live grants.
- [x] Scoped paid calls and independent payments: repeated authorized resource calls create no budget grant; wallet integration preserves delegation and funds checks.
- [x] Once, revocation and upgrade: grant tests cover consumption and revocation; the idempotent upgrade test privatizes old cards/receipts, revokes unproven/foreign approvals, and preserves valid pending grants.
- [x] Agent and phone guidance: generated skill guidance and grant-card authority tests passed; imported routes and YouTube use the resource facade.
- [x] Google credential handoff rechecks connector ownership against the current helper owner. A regression reproduced token disclosure from a stale ownership assignment before the query fix; the Google OAuth and Workbench suites pass with the check.
- [x] Local validation: 193 focused body tests, 17 focused server integration tests, 30 database/wallet tests, 17 grant-contract tests, and 83 mobile card tests passed. Server/body/dependency builds and mobile typechecking passed. The final agent-home fail-closed assertion was rechecked in its 42-test suite.
- [ ] Complete current-head CI. Do not reuse results from budget-only head `559c7aad`.
- [ ] Configured reviewer's exact-current-head approval. Mark the complete delivery ready for review; call `pr_checks_status` before any merge.

Validation limitations: the broader server integration/wallet run had nine failures and 159 passes. All nine failures reproduced in an isolated checkout of unchanged `559c7aad` (websocket invalidation timeout, concurrent retry response, seeded-soul settings, managed-identity response, invalid agent-name status, peer corner inbox, working receipt heartbeat, parent Room working receipt, and outside-turn event fixture). The no-mistakes pipeline could not initialize because its existing remote conflicts with setup; no pipeline success is claimed. A mobile clock test failed when its two-minute-old fixture crossed UTC midnight; the full 83-test file passed with `TZ=America/New_York`.
