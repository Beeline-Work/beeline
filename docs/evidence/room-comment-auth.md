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
Other personal transports retain their existing connected tools; the launcher
directs the caller there rather than substituting a Squire account. The socket
path is exercised on Linux; Windows transport behavior is not demonstrated.
There is no new permission prompt, denial rule, or App connector control.

`room-github-auth.test.ts` runs real native `gh api` to post an issue comment
through the sealed personal-route fixture, returning comment id 42. It also
checks the default App route when the key was only discovered. The server
integration test executes agent discovery followed by the owner's Connectors
action and verifies the resulting connection selection. These are executable
route proofs, not live GitHub comments.

GitHub's [configuration reference](https://cli.github.com/manual/gh_config)
documents the HTTP Unix socket transport; native `gh` keeps argument parsing,
pagination, JSON filtering and GraphQL handling.

## Live evidence and remaining proof

On 2026-10-19, `connect ensure github` selected Squire API. Vault metadata
listed only `buzzrouter-public-discovery`. Its sealed GET `/user/installations`
returned 403, `Resource not accessible by personal access token`. No write was
attempted with that identity. The corner's existing App-authenticated `gh api
installation/repositories` listed `Beeline-Work/beeline`; this proves repository
selection, not the installation's Issues permission level.

The brief's public App lookup reports `issues:write`. Installation 155845498's
live grant remains unverified: the earlier browser attempt reached GitHub sudo
confirmation. No App or installation permissions were changed. Checking the
grant requires the owner's authenticated installation settings; do not infer
the installation grant from the App's public configuration.

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
separately by the executable regressions above. The production parent-Room turn
remains untested until an updated helper is available. No helper restart,
release, production deployment, or permission expansion was performed.

PR #2599 head `8f68adbe1bd0f7de3b8027931b78a3db4559212f` was inspected.
It owns General setup guidance and personal push precedence. This change leaves
its guidance and corner git launcher untouched. Room personal-account command
routing is implemented here; native personal git push remains outside this fix.
Squire personal credential injection into native git remains #2599's work.

## Validation

- `npm run corner:prepare` passed.
- Root `npm run typecheck` passed.
- Room authentication, retention, checkout, inspection mount, permissions and
  startup suites pass (53 tests).
- The complete app-connections integration suite passes (74 tests), including
  owner connection selection, ownership, grants and route authorization.
- `git diff --check` passed.
- No-mistakes could not start: initialization reported that the shared
  `no-mistakes` remote already points to `/tmp/consolidated-nm/repos/2f0d150a1ff5.git`.
  That existing remote was not replaced; no pipeline review or CI success is
  claimed.
