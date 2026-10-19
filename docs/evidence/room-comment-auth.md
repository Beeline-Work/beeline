# Reproduction room-comment-auth

Repository-bound parent Rooms fetch an exact-repository App token for checkout
but previously omitted it from their harness and inspection MCP environment.
The brief records an unauthenticated `gh` and a 403 when the agent instead used
the `buzzrouter-public-discovery` personal access token. The already-posted
guidance on issue #2594 belongs to the human; this work does not duplicate it.

## Boundary reproduction and demonstration

Run from the repository root:

```sh
npm exec -w @beeline/body -- vitest run src/monolith-room-turn.retention.test.ts -t 'authorizes an external issue comment' --silent
```

The test drives the real Room turn loop through two commands. Each harness
callback launches a Node subprocess with the actual session environment and
POSTs a comment to `/repos/owner/widgets/issues/1/comments` on a local HTTP
server. That server accepts only the current synthetic repository token,
returning 201 for it and 403 otherwise. The ACP client and GitHub server are
fixtures; this is not a deployed harness or a live GitHub comment.

With the original `monolith-room-turn.ts` from this branch's initial HEAD,
both requests arrived with `Bearer undefined` and returned 403. With the fix,
the first request uses the initial token and the next uses the rotated token;
both return 201. Rotation starts a fresh harness despite the unchanged commit.
The token is absent from emitted prompts and turn traces. Separate regressions
cover explicit personal session credential precedence, passing the selected
credential to the inspection MCP, preserving its read-only root, and carrying
the bound Room token even for an empty repository.

## Corrected personal connection scope

Brief revision 2 applies lunchboxfortwo's correction from message
`08797ef8cf09567fc6c2c993461ef3fcebc137092e0c396dba6e0727cb0c8118`:
implement personal-connection precedence, otherwise connected-repository App
access, with no additional permission-denial guard or confirmation flow.

The first patch preserved an explicitly configured session token but did not
route native `gh` through a connected Squire account. The revised launcher reads
the owner's server-indexed connection selection on each invocation. Existing
connection audit rows distinguish an owner selecting GitHub from an agent
discovering a vault key. Selecting an already-discovered connection from
Connectors records that choice in the existing audit ledger; no UI was added.

For an owner-selected Squire GitHub connection, native `gh` uses its supported
HTTP Unix socket transport to forward requests through the current task's
Squire relay and `use_credential`. The personal token stays in Squire. With no
selected personal connection, native `gh` keeps the repository App environment.
For managed OAuth and registry MCP, the launcher translates the narrow
issue-comment API operation to the connected provider tool through the existing
sealed broker, preserving turn, grant and owner authorization. Refusals do not
fall back to the repository App. The socket
path is exercised on Linux; Windows transport behavior is not demonstrated.
There is no new permission prompt, denial rule, or App connector control.

`room-github-auth.test.ts` runs real native `gh api` to post an issue comment
through the sealed personal-route fixture, returning comment id 42. It also
checks the default App route when the key was only discovered. The server
integration test executes discovery, owner selection, disconnect, retained-key
rediscovery and reselection, verifying that historical selection does not
restore personal precedence after disconnect. These are executable
route proofs, not live GitHub comments.

The owner-completed sign-in regression reproduced a connected managed OAuth
account with `selectedByOwner:false` after an agent initiated connection.
Verified phone completion now records the owner's selection in the current
route ledger transaction. An unverified completion leaves selection false.
For Registry MCP, the authenticated owner opening the pending sign-in card
records selection for that exact active app and connector; the public OAuth
callback is not treated as authenticated owner selection. Focused integration
tests execute both phone paths and retained-key disconnect/rediscovery. These
provider fixtures do not establish live personal-account coverage. The native
proof below predates this server provenance fix and does not prove it deployed.

GitHub's [configuration reference](https://cli.github.com/manual/gh_config)
documents the HTTP Unix socket transport; native `gh` keeps argument parsing,
pagination, JSON filtering and GraphQL handling.

## Live evidence and proof limits

On 2026-10-19, `connect ensure github` selected Squire API. Vault metadata
listed only `buzzrouter-public-discovery`. Its sealed GET `/user/installations`
returned 403, `Resource not accessible by personal access token`. No write was
attempted with that identity. The corner's existing App-authenticated `gh api
installation/repositories` listed `Beeline-Work/beeline`; this proves repository
selection, not the installation's Issues permission level.

The brief's public App lookup reports `issues:write`. Installation 155845498's
direct grant lookup remains unverified: an earlier browser attempt reached
GitHub sudo confirmation, and the test-phase API lookup returned 404. Public
App configuration reports Issues write; the successful App comment below
proves effective write access to the approved target, not an independent
installation permission inventory. No permissions were changed or expanded;
no further sudo attempt is required for this proof.

One live authorized comment was then posted on this fix's own draft PR, leaving
#2594 untouched: [comment 6272750153](https://github.com/Beeline-Work/beeline/pull/2609#issuecomment-6272750153),
author `beeline-app[bot]`. The isolated driver imported the built
`installRoomGitHubLauncher`, supplied a local `readAgentWorkbench` response with
`selectedByOwner:false`, and delegated native `gh` to this corner's existing
repository-scoped App launcher. It executed `gh api --method POST
repos/Beeline-Work/beeline/issues/2609/comments` with one distinct verification
message. GitHub returned that comment's id, URL and author. No provider token
was extracted into the driver or shown to the agent.

This proves a successful authorized issue-comment API write through the updated
launcher against live GitHub. Connection selection was a fixture, and the
existing corner launcher supplied App authentication. It does not prove that
the deployed parent Room uses this branch, nor isolate the installation's
Issues permission from its Pull requests permission (the target is a PR).
The real Room turn boundary and personal-connection selection are exercised
separately by the executable regressions above. The deployed production parent-Room turn remains untested. The later isolated
native proof below exercises the real Room runtime without updating that helper. No helper restart,
release, production deployment, or permission expansion was performed.

PR #2599 head `8f68adbe1bd0f7de3b8027931b78a3db4559212f` was inspected.
It owns General setup guidance and personal push precedence. This change leaves
its guidance and corner git launcher untouched. Room personal-account command
routing is implemented here; native personal git push remains outside this fix.
Squire personal credential injection into native git remains #2599's work.

## Parent-Room-equivalent native proof

The supplied `/tmp/jellybean-2609-final-proof-output.log` records a completed
proof against pipeline head `79f72e332063c30dc36bba5c9175c5b8bdb7b5b8`.
The supplied `proof-2609` driver, helper and ACP harness were inspected read-only;
its `final-source` copies of `monolith-room-turn.ts` and `room-github-auth.ts`
were verified byte-for-byte against the proof head during the test phase. The
bundle README still names an earlier source head; the final run and matching source are the evidence for this head.
The live write was not repeated during this test phase.

A disposable Docker container provided its own PID 1 systemd, proof user,
HOME, XDG directories and private user bus. `isolatedNativeProof` passed.
Transient native services ran real `RoomRuntimeCoordinator` checkout,
`MonolithRoomTurnLoop`, an actual `AcpClient` child, native `gh` and bubblewrap.
The original Room loop from `9dce27227` returned `REFUSED gh: HTTP 403` with no
live write. The patched loop returned `READONLY_PASS PASS`, updating existing
comment 6272750153 as `beeline-app[bot]`. The final result was
`{"proof":"room-comment-auth","passed":true,"writes":1}`. Both services exited
successfully. Exactly one PATCH updated the existing approved PR #2609 comment;
no new issue or duplicate comment was created. The harness checked that writing
the Room checkout failed with EROFS or EACCES before attempting the comment.

This is parent-Room-equivalent live-service proof, not deployed behavior.
Repository contents, server DTOs, command delivery and the token issuer were
fixtures; a deterministic ACP child executed the operation without a model.
An ephemeral scoped capability forwarded only the authenticated PATCH to the
existing host repository App launcher; no provider token was extracted. No
production helper, deployment, merge, permission expansion or extra approval
flow was involved.

Verdict: the reported Room authentication failure is reproduced before and
resolved after the patch in the isolated native proof. Personal Squire,
managed OAuth and registry MCP routes, disconnect/rediscovery selection and
existing authorization refusals are covered by executable regressions as the
authorized stand-in for unprovisioned live personal accounts. They are not
claimed as live provider coverage. A separate installation permission inventory
and deployed production behavior remain unverified; neither is represented as
a passing live scenario.

## Focused test-phase validation

The isolated no-mistakes setup is now repaired: this assigned test phase runs
inside its active worktree at the proof head above with dependencies
available. The later owner-sign-in provenance fix is covered by the focused
integration regressions described above, rather than that earlier native run.
The earlier shared-remote initialization conflict is historical,
not a current blocker. This phase did not initialize or control another run;
review, lint, push, PR and CI phases remain the outer executor's responsibility.

The native-gh authentication suite passes (10 tests), including generated
launcher execution for all three personal transports and refusal behavior.
The focused lifecycle and Room turn checks initially failed to collect because
workspace dependency build outputs had been removed. Restoring those outputs
with `npm exec -- turbo run build --filter=@beeline/server^... --filter=@beeline/body^...`
repairs that setup issue; it requires no product change.

After restoring prerequisites, the focused server lifecycle regression passes
(1 test) and the Room comment/token-rotation and explicit-personal-credential
regressions pass (2 tests). Together with the native-gh suite, all 13 selected
tests pass. No full suite, linter or static-analysis check was run in this
phase. Generated workspace build outputs and task logs were removed afterward;
prepared dependencies were retained.

## Standard native issue-comment follow-up

Reproduction **room-comment-auth**: reviewer substituted `gh issue comment 1
--repo owner/widgets --body 'Room authentication verification'` for `gh api`
in the selected managed OAuth and Registry MCP fixtures. Both commands returned
HTTP 502 at `/graphql` before posting: the adapter accepted only the REST comment
endpoint. The same native command was reproduced locally before this fix.

The adapter now translates native gh's `IssueByNumber` lookup through the
selected provider's issue-read tool and `CommentCreate` through its comment tool.
A process-local opaque subject binds the mutation to the successful lookup;
provider authorization still runs on each operation, and refusal never falls
back to the App. Registry text and structured issue-read results are covered.
Native argument parsing remains with gh. Translation covers the observed gh
lookup and creation query shapes; edit/delete, attachments and general GraphQL
are outside this adapter's supported operations.

The same standard command now exits successfully and prints the fixture comment
URL for both transports. Regressions also exercise lookup and comment-write
refusals without fallback. These are real native CLI commands against local
provider-boundary fixtures, not live personal-account writes; no new live
comment was created for this follow-up. The earlier isolated App proof remains
bound to its recorded head.
