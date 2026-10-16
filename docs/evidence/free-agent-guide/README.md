# Free-agent warning and connection guide

Feature proof FREE-GUIDE-1; not a defect report.

The built server's model HTTP endpoint was exercised on localhost with an isolated
PGlite database and synthetic upstream. At 80% settled usage, the owner's
`PhoneService.readRoom` showed the warning, another member's read returned no
Room, a repeated request created no duplicate, and only the requested model call
reached the upstream. Regression coverage lives in `free-agent-model-proxy.test.ts`
and `free-agent-warning.test.ts`.

![Beebee's warning rendered by the app's LedgerEntry component](allowance-warning.png)

This screenshot is a local web component build, using the app's real `LedgerEntry`
and markdown renderer with the warning text emitted by that built-server proof.
The existing `runBrowserProof` harness supplies native adapters and isolated
headless Chrome. Assertions passed for warning text, UTC reset and Members link.
It is a renderer stand-in, not a screenshot of a deployed server or the full Expo app.

On production, the existing owner's browser session reached Workspace menu →
Members at `/beeline/members?communityId=18e555f7-e191-452b-9b0f-b825f58ee4ba` and
showed the Add agents control. No pairing code was generated. The specifically
requested reviewer-bypass sign-in is deferred until after deployment. Ruby accepted
the local screenshot, owner-session Members check and FREE-GUIDE-2 as pre-merge
proof (corner decision cdc383c8b896ed9f73100eecce3fd2a160a65dd339e862e6ea052d6de83f29e0).
Ruby owns the production browser check after release and enablement.

Server coverage: all 167 test files exercised in memory-bounded batches; 2,683
tests passed and seven existing tests skipped. The 239-case integration file was
split into name-filtered batches whose passing counts sum to all 239 cases.
The 69 affected free-agent, model-proxy, warning and message-producer guard tests
passed, including removal, nonblocking Fly cleanup, retry, provisioning races,
authority, token refusal and the exact server hello.
Repository typecheck and server build passed.

## Revision 3: model and name

FREE-GUIDE-2 exercises the rebuilt server's `createWorkspace` →
`readWorkspaceMembers` path with an isolated PGlite database and provisioning
stubbed. The returned roster shows `Beebee` / `@beebee`; the stored selected model
is `beeline/deepseek/deepseek-v4.1-flash`, and instructions say `You are Beebee`.
Default/override and handle-collision cases are covered by the passing server suite.

The optional live Docker/OpenCode turn was not run: Docker and a free-agent image
are present, but no isolated proof server/database or model key is configured in
this session. No production settings or existing agents were changed.

## Revision 4: removal and first hello

Feature proof FREE-REMOVE-1; not a defect report. Re-run after the server build:
`node --import tsx docs/evidence/free-agent-guide/removal-proof.mjs`.
The built server was exercised
with an isolated PGlite database and a synthetic Fly Machines adapter. Production
cannot run this head before deployment; the adapter deliberately fails deletion
so the removal and retry path can be demonstrated without a live Machine.

Steps: create Workspace → owner reads Members (Beebee present) → bootstrap →
Members `removeAgent` while Fly deletion fails → owner reads Members (Beebee
absent) → retry the old bootstrap and model token → restore Fly → leader sweep →
mention Beebee, request a wake/provision and run the operator add path.

Passing result: removal committed despite the Fly failure; model and bootstrap
hashes were cleared; bootstrap was refused; model HTTP returned 401 with zero
upstream calls; the leader retried deletion; subsequent mention, wake, sweep and
operator add made no Machine. A separate regression holds provisioning in flight,
removes Beebee, and confirms the newly returned Machine is deleted without
restoring its bootstrap. The server-posted hello ends with the pinned sentence:
“If you don't want me here, open Members and remove me from the Workspace.”

Targeted free-agent, model-proxy and existing removal regressions passed, including
Workspace owner/admin removal and removal from another joined Workspace. Repository typecheck and
server build passed. The complete server suite passed in bounded batches, as summarized above.

## Revision 5: exact server hello

The server posts `FREE_AGENT_HELLO` (owner approval 3126e930) as Beebee in the
creation transaction, replacing
the model hello turn. Tests pin the complete approved text, owner handle and
collision-suffixed agent handle. The existing push loop delivers the owner's
mention; creation and a sweep leave zero commands, model usage or Machine calls.
The operator add path posts the same hello once across retries.

The runnable built-service proof above now also checks the owner's Room read
for the exact hello and confirms no Machine boot. It then sends an actual owner
request before exercising bootstrap, removal, refusal and deletion retry.
