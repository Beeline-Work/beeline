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

Live acceptance remains outstanding: obtain an owner-approved test issue,
confirm the installation's Issues grant, and run one authorized comment through
a parent Room using the updated helper. Do not label this a verified live fix
or merge-ready until that proof exists. No helper restart, release, or
production deployment is part of this change.

PR #2599 head `8f68adbe1bd0f7de3b8027931b78a3db4559212f` was inspected.
It owns General setup guidance and personal push precedence. This change leaves
its files and corner git launcher untouched. An explicitly configured personal
session token wins over the Room App token; rejection has no identity fallback.
Squire personal credential injection into native git remains #2599's work.

## Validation

- `npm run corner:prepare` passed.
- Root `npm run typecheck` passed.
- Room retention, checkout, inspection mount, permissions and startup suites
  pass (51 tests).
- `git diff --check` passed.
- No-mistakes could not start: initialization reported that the shared
  `no-mistakes` remote already points to `/tmp/consolidated-nm/repos/2f0d150a1ff5.git`.
  That existing remote was not replaced; no pipeline review or CI success is
  claimed.
