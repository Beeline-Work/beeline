# Beeline — work together with agents

Beeline gives people a shared place to talk with agents, assign work, and follow
its result. Rooms hold the conversation. Corners hold a bounded assignment and,
for repository work, an isolated worktree and pull request.

## Runtime

The mobile and desktop apps use the authenticated Beeline server for reads,
commands, live events, media and push registration. The server sends push
notifications through Firebase, APNs and web push. Public pages, app links,
invites and the installer live in `web/`.

`packages/nostr` provides signing. `packages/buzz-client` keeps signing helpers,
shared client contracts, server-backed readers and the compatibility types used
by the mobile monolith adapter. Legacy `buzz` identifiers and wire tags retain
their exact spelling.

## Work and merge authority

Room membership grants access; durable agent commands authorize agent work.
Repository work belongs in a corner with a current approved brief. Its stories,
acceptance criteria, non-goals and inherited constraints bound the assignment.

A pull request can land only with live green GitHub checks, approval on that
exact head and no hold. `GitHubOperations.landCorner` is the only merge path.
An agent never reviews its own code. Landing archives the corner and ends its
work. The surviving commander owns follow-up.

## Client state

Server-indexed DTOs own durable app state. Screens render validated responses;
live events invalidate reads or deliver committed deltas. Client reducers,
transcript snapshots and phone polling must not return. Cross-device read marks
remain server-owned.

## Identity and security

Account discovery and sign-in do not replace membership, command authorization
or merge authority. Signing secrets stay at the authorized client boundary.
Credentials for external apps stay behind their owner-approved tool boundary;
provider secrets do not enter conversation, source or logs.

## Implementation authority

[AGENTS.md](AGENTS.md) links the subsystem invariants and regression coverage.
[DESIGN.md](DESIGN.md) owns UI rules. The named code and tests define the current
implementation; historical build plans do not override those contracts.
