# Beeline pre-launch authorization and data-handling review

Reviewed 2026-10-13. Starting source: `0c25de34924295cd220dfcbdb846fc83e8853fc4`.

One credential-output bug is fixed on this branch. Three authorization/lifetime changes are proposed only. No new validation, authorization gate, sandbox restriction, polling, or production write was added. Review and proofs ran in the disposable task worktree; no live helper, real agent, Workspace, or emulator was driven.

## Ranked findings

| Rank | Severity | Confidence | Finding | Disposition |
|---|---|---|---|---|
| 1 | High | 10/10 behavior; impact bounded by Room membership | Retirement leaves unused ordinary daemon exchanges redeemable | Proposed only |
| 2 | Medium | 10/10, synthetic reproduction | Tool labels and raw turn-error stacks bypass credential redaction; bare Beeline tokens are not recognized | Fixed in this PR |
| 3 | Medium | 10/10 behavior; revocation policy needs approval | Pairing codes issued by a removed person remain claimable | Proposed only |
| 4 | Medium | 9/10 source trace; legacy permission path | Original permission requester can decide after losing membership | Proposed only |

No evidence of real credential misuse or real log exposure was obtained. These severity labels describe consequences of the observed code behavior, not an incident declaration. Verification was performed by this worker without delegation.

### 1. Retirement does not invalidate unused ordinary daemon exchanges

**Evidence:** `apps/server/src/agent-retirement.ts:77` removes memberships and `:82` revokes existing daemon tokens. It does not delete pending `daemon_token_exchanges`. `TokenAuth.exchangeDaemonToken` (`apps/server/src/auth.ts:302`) reads the exchange row, expiry and consumed flag; its current-membership/hidden-identity check at `:324` is inside `if (legacy)`. Ordinary exchanges reach the new token insert at `:351` without it.

**Isolated observation:** `node --import tsx data/beeline-audit-security/retirement-check.mts` migrates an in-memory PGlite database, creates synthetic membership and an exchange, calls the real retirement function, then checks the exchange's outcome. Result: retired membership absent, identity hidden, pending ordinary exchange still issues a token, and that token authenticates. No token values are printed and no HTTP or real account is used.

**Impact:** a removed agent can regain a valid daemon credential during the unused exchange's 15-minute lifetime. This does not restore its Room memberships: `DaemonService.access` still rejects Room-scoped calls. Agent-scoped bootstrap/configuration/connector assignments must nevertheless no longer treat a retired agent as authenticated. This is current exchange lifecycle behavior, unrelated to any historical credential.

**Smallest proposed fix:** invalidate unused exchanges in the same retirement transaction that revokes daemon tokens, and serialize ordinary exchange issuance with retirement using one common per-agent lock/locked row. Without serialization, deleting pending rows alone leaves an in-flight exchange race. Reuse the same lifecycle primitive for rollback and Workspace deletion. Add retirement-before-exchange and exchange-before-retirement tests. This adds revocation enforcement and requires explicit approval; no implementation tonight.

### 2. Credential values escape through journal labels and error stacks

**Evidence:** before this change, `toolCallFailureLine` (`apps/body/src/tool-call-failure.ts:67`) scrubbed the reason but concatenated the raw title or fallback ID. Both Room and corner loops send it to `console.warn`. Room command and corner command error handlers sent the original Error object directly to `console.error`, even though the phone receipt used a distilled redacted sentence. The existing corner failure fixture already put a synthetic GitHub token in a backstop error and printed that token in its journal. `redactToolDetail` (`apps/body/src/turn-failure-reason.ts:17`) recognized GitHub/provider tokens but missed the server's own `bat`, `brt`, `bdt`, and `bde` opaque credentials (`apps/server/src/auth.ts:44,264,341,436,447`).

**Before/after proof:** five new tool-failure cases failed before the fix: credential-bearing title/fallback ID, and four bare Beeline token families. They now pass. The existing real corner-loop fixture also asserts that its journal preserves the stack location while omitting its synthetic token. No real secrets were used.

**Fix:** use the existing shared redactor for failure labels, the Room open-corner diagnostic title, and full Room/corner turn-error stack strings. Extend that same redactor for the four current Beeline token formats. Preserve stack locations and refusal text. This removes duplicated output behavior and fixes secret disclosure without changing operation authority, command state, routing, grants, or sandbox mounts.

**Deliberately left alone:** generic free-form output cannot be guaranteed secret-free by a finite token regex. This change does not claim to sanitize every journal producer, every arbitrary provider credential, or arbitrary user-authored prose. No log/history scrub, token rotation, credential-store change, or new logging policy is included.

**Delivery:** PR URL is recorded below after PR creation.

### 3. Pairing authorization outlives the person who issued it

**Evidence:** `PhoneService.createPairing` (`apps/server/src/phone-service.ts:7035`) checks current Workspace membership when minting the code. `claimAgentConnectPairing` (`:3765`, lookup at `:3799`) checks code existence, expiry and claim state, then uses its stored `created_by` as the new agent's owner and inserts Workspace membership. It does not re-check the issuer's current membership. `removeWorkspaceMember` (`:6835`) removes membership but leaves those codes. The older `claimAgentPairing` (`:3577`) has the same expiry-only issuer lifetime.

**Isolated observation:** the same PGlite lifecycle fixture creates a code as a synthetic member, removes that member through the real phone operation, and performs the connect claim. Result: `pendingPairingClaimStatus: claimed` and new agent Workspace membership present.

**Impact:** an unused code remains a Workspace admission capability for up to 15 minutes after its issuer loses access. Bearer codes are intentionally transferable; this finding concerns issuer revocation, not their transferability. Whether removal should revoke already-issued capabilities is a product/security decision.

**Smallest proposed fix:** require a live issuer Workspace membership under the same membership lock when claiming either code variant; optionally delete unclaimed codes on leave/removal for simpler cleanup. Test removal winning the claim race. This tightens admission and requires approval; left unchanged tonight.

### 4. Legacy permission decisions do not require current requester membership

**Evidence:** `PhoneService.decidePermission` (`apps/server/src/phone-service.ts:6007`) finds the pending card by permission/Room and validates its request, agent and repository. At `:6028`, only someone other than `principal_id` must pass `requireRoomWorkspaceManager`. The original requester instead passes on identity equality, without `hasRoomAccess` or current Workspace/Room membership. Its update at `:6060` changes the permission status and writes a card into that Room. The generic spectator guard tests current spectator rows; a removed member has no such current row.

**Impact:** a still-signed-in former requester can settle a pending legacy permission card after leaving/being removed. This is a permission-record write, not proof that a current agent can act without its own Room/command authority. Modern Agent Grants are separate and were not changed. This path is compatibility code; its end-to-end use by current helpers was not established.

**Smallest proposed fix:** require live Room and Workspace membership for the original requester under the decision transaction, with manager fallback retaining existing policy. Alternatively retire this decision endpoint when compatible clients no longer need it. Both change accepted authority and require approval; left unchanged.

## Production read-only evidence

One aggregate query at **2026-10-13T04:20:37.517Z**, inside `BEGIN READ ONLY`, with a 10-second statement timeout and `ROLLBACK`. No identities, keys, message contents, or connection string were returned. Query source: `prod-counts.mjs` (requires the explicitly authorized connection-string file as an argument).

| Aggregate | Count |
|---|---:|
| Unconsumed/unexpired exchanges for hidden identities | 0 |
| Unrevoked/unexpired daemon tokens for hidden identities | 0 |
| Pending permission rows without current requester Room membership | 0 |
| Live agent Room memberships without live Workspace membership | 0 |

These are a point-in-time snapshot, not a history scan. Pairing-code exposure and prior journal contents were not queried. No production mutation or repeated polling was performed.

## Authorization and data-handling coverage

The mechanical dispatch inventory covers **123 phone operation labels and 155 daemon labels** in [phone-operations.md](phone-operations.md) and [daemon-operations.md](daemon-operations.md). Regenerate with `node data/beeline-audit-security/inventory.mjs`. It records dispatch calls and recursively reachable same-class guard names. A reachable guard is a source pointer, not a guarantee it dominates every branch; inline SQL and external helpers need separate policy review. These inventories replaced the relaunch's earlier inventories, which also included non-operation card switches.

| Boundary | Evidence and review result |
|---|---|
| Phone authentication | `server.ts:1420,2138,2444`: authenticate access bearer before phone routes and dispatch; service gets the authenticated viewer, not a caller-supplied identity |
| Phone role/owner policy | `phone-service.ts:4040,8463,8476,8502,8510,9591`: spectator write restriction, agent configuration owner-only, removal owner/admin, live Room/Workspace reads, repository binding manager policy |
| Room/Workspace lifecycle | Removal and leaving update all Workspace membership rows; deletion owner-only and transactional. Targeted integration tests cover outsider/cross-Workspace writes, Room membership, and deletion cascades |
| Daemon operation identity | `daemon-service.ts:385`: refuses candidate agent mismatch; selects target corner rather than unrelated `roomId` for reach operations |
| Daemon Room/reach authority | `daemon-service.ts:7570,7641`: current Room membership or current parent-Room/corner membership, checked against the target |
| Daemon turn authority | `daemon-service.ts:434,598`; `agent-command.ts:1060`: turn writes bind room, agent, request, generation, command state; cancelled turns fail |
| Institutional memory/workflows | Active-command requirement in `daemon-service.ts:832-1009`; scope derives from authorized command. Reads do not trust a free-form Workspace ID |
| Connection/payment resources | Registry OAuth begin/claim binds connector to its helper (`registry-mcp-oauth.ts:23,95`). Link spending retrieval binds both owner and agent (`link-agent-wallet.ts:208`). Resource facade re-reads command context and asks the server for each consuming call (`resource-mcp-facade.ts:504`) |
| GitHub tokens | `github-operations.ts:569`: active installation/repository, repository-id-scoped App token. Daemon dispatch checks Room membership; phone room-token read uses `canReadRoom` |
| Session handling | `auth.ts:184-253`: durable refresh is deliberate, access expires, logout revokes presenting device family, legacy sealed successors are token-keyed; `phone-github-ticket.ts:18`: one-use ticket. Daemon auth cache is bounded to 10 seconds, so token revocation alone is not immediate everywhere; no cache change proposed |
| Browser OAuth | `server-oidc-identity-routes.ts:165,315,385`: hashed state/browser session, PKCE, OIDC nonce and callback bindings. Native/browser return origins are constrained. Review identity has locked operations |
| Viewer browser session | `computer-session.ts:35,57,66`: viewer-bound HMAC and expiry plus current human Room/Workspace membership and agent access policy. The path ID alone is not sufficient viewing authority |
| Webhook authenticity | GitHub raw-body HMAC (`server.ts:336,1939`); Composio secret verification before delivery (`:1923`); Linear/Stripe raw-body signatures and freshness (`provider-webhooks.ts:180`); CDP signs required event headers and body with freshness (`wallet-webhooks.ts:57`). Subscription/wallet writes follow verification |
| Webhook idempotency | GitHub delivery records; provider per-subscription message IDs; wallet owner/chain/transaction notice identity. Payload is untrusted content; provider signatures authenticate origin, not agent instructions |
| Agent working-folder secrets | `runtime.ts:132` private runtime file; `agent-home.ts:113,1747` deliberate harness credential links and atomic private config writes. Registry provider tokens remain helper-owned. A readable current-agent runtime credential is still agent-wide, not a per-turn capability; no change to that standing trust model |
| bwrap mounts | `bwrap-sandbox.ts:505,628`: ordered masks, selected private home/assets rebound, read-only Room root, writable corner root, current worktree/git-common writable. Shared caches and own harness login are intentional. Tested pure mount plans and required masks |
| Sandbox limits | `bwrap-sandbox.ts` explicitly declares hygiene, not a privilege perimeter. Same-user sockets, network, deliberate granted host MCP, unknown ambient secret paths, macOS and fail-open configurations retain operator-account authority. No new confinement policy proposed or shipped |
| Imported MCP | `mcp-route-class.ts:47` treats process/config/credential declarations as host resources; only inert public HTTPS declarations pass as local. `host-mcp-route.ts` rewrites granted routes; `resource-mcp-facade.ts` gates resource use with current command context |

This is source tracing plus targeted tests, not a complete adversarial request matrix for every input branch. WebSocket authentication and subscription paths were read, but an independent reconnect/revocation matrix was not run. Live bwrap escape experiments, provider API calls, dependency/CVE research, and git-history secret archaeology were excluded from this task's proofs. No claim that public source itself changes the authorization model is made.

## Why public source makes these checks worth repeating

Operation names, request fields, permission fallbacks, mount plans and token formats are now discoverable. UI visibility is therefore especially poor evidence of server authorization. Re-check identifier substitution against actual Room/corner/Workspace scope; test removal between issuance and consumption, and between card creation and decision; and use synthetic token values in output tests. Keep provider authenticity on raw signed bytes and preserve helper-owned credential storage. The proposed fixes above close state-lifetime mismatches using existing transaction boundaries rather than new workflows.

The explicitly accepted shared-link/readiness behavior and previously declined historical remediation were excluded. No live host hardening or new public endpoint restriction is requested by this report.

## Validation and delivery

- Before fix: five synthetic tool-failure redaction cases failed.
- After fix: eight Body files, **229 tests passed**, including real Room/corner loops, bwrap mount plans, imported MCP classification and host/resource facade behavior.
- Five server auth/OAuth/webhook files: **39 tests passed**.
- Authorization integration selection: **8 tests passed**, covering Room membership, cross-Workspace configuration/removal, corner non-members, owner-only configuration, deletion, grant requester binding, and both existing yolo hard stops.
- Root `npm run typecheck`: passed (workspace packages, mobile and scripts).
- `git diff --check`: passed.
- PGlite lifecycle fixture: both pending-exchange and removed-issuer observations reproduced; no network.
- CI: must be green on the final pushed head before the worker reports done. Canonical PR URL is appended below once GitHub creates it.

The review uses the CSO checklist, adapted to the task's defensive-only scope and no-delegation requirement. It is an AI-assisted code review, not a substitute for an independent professional security audit.
