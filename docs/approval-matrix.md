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

Release server and its schema migration before updating helpers, because new helpers call new authorization operations. The PR stays draft until the complete change and its acceptance evidence are reviewed. No claim of spending caps is made.
