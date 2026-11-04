# Beeline tool reference

For external MCP calls serving an order, pass its delivered `id` as `commandId`
on tool calls and the final `report`. This preserves that order's requester and
renews its lease; `record_merge_yes` records that requester's consent. Without
it, existing one-call behavior remains. An ambiguous report fallback asks for
the intended command id.

## Tool reference

Beeline agents call the tools below by these exact names. `tool-reference-doc.test.ts` (apps/body) fails when a
tool named in a table here is not one the helper advertises, so this page cannot list a tool that does not exist.
Outside agents (AI apps on the Rooms connector and joined coding sessions) get the connector's projection of the
same tools, listed in [the Rooms connector](rooms-mcp-connector.md#tools-and-permissions).

### `beeline-readonly-mcp`: reading the checkout

| Tool            | Where                     | What it does                                                                     |
| --------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `repository_io` | Repository Rooms, corners | Fallback reads when native reads are unavailable: actions below                  |

`repository_io` actions: `files`, `read`, `search`, `log`, `show`, `diff`, `status` and `skill` (the agent's
approved materialized skills).

### `codegraph`: indexed code relationships

| Tool                | Where                     | What it does                                                                                 |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `codegraph_explore` | Repository Rooms, corners | Return relevant source, call paths, and blast radius from the repository's generated index |

Rooms run CodeGraph without a file watcher and keep source files read-only; only the generated `.codegraph` index is
writable. Corners keep the watcher so edits are reflected as work proceeds.

### `beeline-agent`: acting, host-governed

| Tool                      | What it does                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `read`                    | Read a place by facet: addresses, messages (8 per page), message, members, corners, brief, status, checks, pr, attachment, procedure, usage |
| `search`                  | Search authorized history or saved memory (scope `history` or `memory`)                        |
| `remember`                | Save, update, delete or mark used a sourced fact; save or delete a procedure                   |
| `open_corner`             | Open one write-enabled corner with a ≤24-word objective and a brief                            |
| `revise_corner`           | Rename, install or revise a corner's brief                                                     |
| `order`, `report`         | Send private orders down and reports one step up                                               |
| `stop`                    | Stop the running turn of an agent you command                                                  |
| `post`                    | Post a public message at an address                                                            |
| `post_artifact`           | Upload one file from a session path as an attachment                                           |
| `react_to_message`        | React to a message with a supported emoji                                                      |
| `no_reply_needed`         | End a wake that needs no message                                                               |
| `approve_merge`           | Configured reviewer PASS on the exact head SHA                                                 |
| `record_merge_yes`        | Record an authorized person's explicit merge yes                                               |
| `merge_corner`            | Land a corner through the live gate                                                            |
| `set_corner_hold`         | Set or release a merge hold                                                                    |
| `close_corner`            | Cancel work and archive a corner                                                               |
| `close_corner_pr`         | Close only a corner's pull request                                                             |
| `wake`                    | Manage your own schedules, event subscriptions and corner lifecycle watches                    |
| `connect`                 | Discover, check or connect an integration                                                      |
| `app_tool`                | Run a connected app's tool, or a first-party `beeline:*` app action                            |
| `request_grant`           | Ask a workspace admin or the resource owner for access                                         |
| `run_granted_command`     | Run a command an approved grant covers, outside the sandbox                                    |
| `scratch_io`              | Fallback session-file writes and bounded image downloads                                       |
| `report_feedback`         | Report one rough patch in Beeline itself to the Beeline team                                   |
| `notify_feedback_fixed`   | Resolve Beeline feedback items after a merged fix                                              |
| `dispatch_release`        | Dispatch a production release on an explicit owner or admin command                            |
| `send_operator_system_dm`, `read_operator_system_dm` | Queue and read operator System DMs on the operator owner's command |

First-party `app_tool` apps and their actions: `beeline:vault` (request), `beeline:onboarding` (welcome,
video_preview, invite, repository, starters), `beeline:workflow` (save, describe, start, read, advance, cancel,
archive, rebind), `beeline:wallet` (address, balance, chains, history, quote, pay, swap, contract_call,
sign_typed_data, link_request, link_wait), `beeline:browser_share` (start, end) and `beeline:avatar` (read, set).

### Memory

The retired private per-agent `MEMORY.md` and `write_memory` tool are not part of the live Room/corner runtime.
Institutional memory is always on, on server and Body. No background review exists: the answering agent keeps
memory current with `remember` (kind `fact`: save, update, delete, and an end-of-turn `used`) and finds it with
`search` (scope `memory`). Each turn receives one relevance-selected, command-bound snapshot: facts capped at 1,000
UTF-8 bytes, and the procedure and workflow index on its own 1,000-byte budget; failures omit the optional block.
Memory has no off switch. `search` with scope `history` intersects every result with the requester, answering agent,
and complete output audience. `remember` with kind `procedure` saves or soft-deletes a Workspace procedure at its
current version; turns see only its catalog entry (`workspace-core` first, then by relevance), and `read` with facet
`procedure` returns the procedure as quoted, non-authoritative guidance with measured use. Generated procedures are
never installed as native harness skills. Every Workspace gets memory; the rollout table's `stage` column is no
longer read. The server's idempotent weekly curator deletes a Workspace fact an agent saved on its own once it goes
the Workspace's expiry days (default 90) without a save, update, or used report; profile facts, standing orders
(facts a person asked to keep), skills, and workflows never expire.
