# Beeline tool reference

## Tool reference

Two Beeline MCP surfaces are mounted into every agent session. Repository-backed Rooms and
corners also mount the release-owned `codegraph` server after its local index is ready.

`beeline-readonly-mcp` — reading, in a Room and in a corner:

| Tool                                            | What it does                                  |
| ----------------------------------------------- | --------------------------------------------- |
| `list_files`, `read_file`                       | Walk and read the checkout                    |
| `search_text`                                   | Search the checkout                           |
| `git_log`, `git_show`, `git_diff`, `git_status` | Read repository history and state             |
| `read_agent_file`                               | Read the agent's approved materialized skills |

The retired private per-agent `MEMORY.md` and `write_memory` tool are not part of the live
Room/corner runtime. Institutional memory is always on, on server and Body. No background
review exists: the answering agent keeps memory current with `search_memory`, `save_memory`,
`update_memory`, `delete_memory`, and an end-of-turn `report_memory_used`. Each turn receives one
relevance-selected, command-bound snapshot: facts capped at 1,000 UTF-8 bytes, and the procedure
and workflow index on its own 1,000-byte budget; failures omit the optional block. Memory has no off switch. `search_history` intersects every result with the requester,
answering agent, and complete output audience. `save_skill` and `save_workflow` record Workspace
procedures; turns see only their catalog entry (`workspace-core` first, then by relevance),
`delete_skill` soft-deletes one at its current version, and `load_workspace_skill` returns
the procedure as quoted, non-authoritative guidance with measured use. Generated procedures are
never installed as native harness skills. Every Workspace gets memory; the rollout table's `stage`
column is no longer read. The server's idempotent weekly curator
deletes a Workspace fact an agent saved on its own once it goes the Workspace's expiry days
(default 90) without a save, update, or used report; profile facts, standing orders (facts a person
asked to keep), skills, and workflows never expire.

`codegraph` — indexed code relationships in repository-backed Rooms and corners:

| Tool                | What it does                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `codegraph_explore` | Return relevant source, call paths, and blast radius from the repository's generated index |

Rooms run CodeGraph without a file watcher and keep source files read-only; only the generated
`.codegraph` index is writable. Corners keep the watcher so edits are reflected as work proceeds.

`beeline-agent` — acting, host-governed:

| Tool                                            | Where             | What it does                                                  |
| ----------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| `open_corner`                                   | Rooms, corners    | Open one write-enabled corner with a ≤24-word objective       |
| `order`, `report`                               | All member places | Send private orders down and reports one step up              |
| `read`, `watch`, `list_rooms`                   | All member places | Discover and read addresses; watch corner lifecycle only      |
| `pr_checks_status`                              | Corners           | Read checks, human hold, and PR/head-bound merge approval     |
| `post_artifact`                                 | Everywhere        | Upload one file (path or html/bytes) as an attachment         |
| `fetch_image`                                   | Everywhere        | Download one photograph into scratch for a data: embed        |
| `download_attachment`                           | Everywhere        | Download one message attachment into scratch by its 📎 id     |
| `create_schedule`, `list_schedules`             | Everywhere        | Run a prompt again later — interval minutes or a 5-field cron |
| `update_schedule`, `delete_schedule`            | Everywhere        | Edit or delete any agent-created schedule in the Room         |
| `request_grant`                                 | Everywhere        | Ask a workspace admin or the resource owner for access        |
| `run_granted_command`                           | Everywhere        | Run a command an approved grant covers, outside the sandbox   |
| `save_memory`, `update_memory`, `delete_memory` | Live memory       | Save, replace, or delete one sourced fact at its version      |
| `report_memory_used`                            | Live memory       | Report the memory items this turn's answer relied on          |
| `search_history`                                | Live memory       | Search history visible to the full output audience            |
| `load_workspace_skill`                          | Live memory       | Load one restricted Workspace procedure                       |
