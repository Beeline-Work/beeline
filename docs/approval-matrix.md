# Corner work and personal-resource approvals

| Agent / original requester | Room and corner lifecycle, isolated checkout and corner shell | Personal resources |
| --- | --- | --- |
| Non-yolo / anyone | No permission prompt | Ask privately; only the resource owner decides |
| Yolo / owner | No permission prompt | Skip prompts for that owner's resources |
| Yolo / third party | No permission prompt | Ask the resource owner privately |

Approved resource access includes paid calls within the approved target, Room, and original requester scope. There is no separate generic budget approval. Historical budget and repository grants remain readable; new requests for either kind are rejected. Existing credential-file and unread-script safeguards still apply to granted host commands, including script byte binding.

The isolated checkout and shell of a corner belong to that corner. Host paths outside it, devices, secrets, host commands and MCP routes are personal resources owned by the helper's owner. Personal-resource cards and automatic approval receipts live in the owner's private system/connector DM; Workspace administrators cannot decide them or read their grant details through an agent profile.

`DaemonService` resolves the requester from the authenticated active command's `root_source_message_id`. Delegations, corner objectives and approval resumes retain that root. There is no latest-message lookup or owner fallback. An agent-originated root does not become an owner request. Live command grants are filtered to the current Room and original requester before execution, and old automatic grants stop applying when yolo is disabled or the Workspace is public.

All imported MCP routes, including declarations formerly marked local, and the built-in YouTube tool use a transport facade that authorizes every message, including discovery and harnesses that omit permission callbacks. Unauthorized discovery starts no personal-resource process and reaches no HTTP upstream. Discovery does not consume a Once grant; the server consumes it atomically at the first authorized resource call, and only that call's correlated response can reach the agent. An app connected through `connect_app` answers to one `app:<key>` target on every route — its Registry MCP server and any Trusty Squire call that names it — and wallet tools use the same original-requester resource gate before discovery, execution, wallet reads, or spending. Wallet signing delegation and sufficient funds remain required.

Opening a Room or corner, starting or closing a corner turn, and using Beeline's own Room and corner tools require no grant. `MonolithCornerTurnLoop` admits a corner turn without repository or host pre-turn checks. Older helpers still call `authorizeRepositoryCall` and `authorizeHostCall`; the server keeps them as allow-only routes under active turn authority, without creating grants or cards. A personal-resource call still meets its own scoped gate when made. Approval does not replace the exact-head reviewer/CI/human-hold merge gate. Top-level Rooms retain their read-only filesystem boundary.

Coverage: server `integration.test.ts` (matrix, private decisions, target scope, delegation/resume, revoked and Once grants, command reuse), `wallet.integration.test.ts`; body `grant-runner.test.ts`, `host-mcp-route.test.ts`, `monolith-corner-turn.test.ts`, Room/corner permission tests; mobile `RoomMessageVariants.test.tsx`.

Upgrade: existing shared personal-resource request cards and automatic receipts move to the resource owner's private system DM. Grants without matching original-command provenance, automatic third-party resource grants, grants approved by someone other than the resource owner, and historical active budget grants are revoked. The corrective upgrade records every new revocation plus already-revoked rows whose former state is recoverable without guessing. It wakes valid paused roots, cancels mismatched active turns, records unrecoverable cases, and privately notifies current resource owners. Still-valid pending grants retain their ids and original command. The upgrade is idempotent and does not widen old approvals.

Resource ownership is the helper owner's host/tool inventory; wallet and Squire retain their existing owner-bound account resolution. The agent owner's approval is not permission to route another person's Workbench connection through that helper. Generic imported tools must be provisioned for that helper owner. Filesystem confinement is still the documented hygiene boundary, not a new security sandbox; personal-resource calls still require their own approval where applicable. Credential-file and unread-script hard stops remain enforced by the granted-command runner, and payment delegation, funds, and merge/review rules remain independent.

The allow-only compatibility routes let old and new helpers run through either deploy order. No claim of spending caps is made.

## Post-merge evidence

The original implementation shipped in [PR 1712](https://github.com/Beeline-Work/beeline/pull/1712), merge commit `dd387f2aa`. Post-merge review found gaps in Composio requester provenance, facade authorization, migration recovery, and generated approval copy; the follow-up regressions below preserve those findings as executable evidence.

- The Composio connector these findings covered is retired. `app-connections.integration.test.ts` now proves one requester-scoped `app:<key>` decision covers every route of an app, a refusal never moves the app to another route, and disconnect revokes that app's standing approvals.
- `resource-mcp-facade.test.ts` proves unauthorized discovery starts no stdio child or HTTP request, discovery preserves a Once grant, and unsolicited child output is not forwarded.
- The server upgrade integration test simulates the already-run production migration, checks the immutable revocation ledger, resumed and unrecoverable turn dispositions, owner notices, and idempotency.
- `agent-grant-tools.test.ts` and the server integration suite verify that `request_grant` copy comes from the server-returned destination and authority for private `@system`, Wallet, and Trusty Squire cards.
- The personal-resource matrix, command-runner, wallet, corner, and Google ownership regressions from the merged change remain the supporting coverage for the broader policy boundary.
