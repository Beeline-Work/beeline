# Durable corner assignments

The original [v2 assignment](durable-corner-specs-v2-assignment.md) and
[fresh-context skill trials](durable-corner-specs-v2-evaluations.md) remain as design history.
This document describes the shipped contract and its acceptance proof.

## Current contract

Every new repository/code corner starts with a human-approved brief. A revision contains:

- `spec`: agent-written Markdown, at most 16000 characters. Intent quotes, the checklist,
  non-goals and references are headings inside it;
- `files`: the attachment manifest; and
- `approval`: one human Room message id. The server resolves that message's exact text and author
  (`resolveCornerBriefApproval`) and rejects an unknown or non-human message.

The server commits the brief, corner, and initial worker command together and automatically adds
ready artifacts posted by the planner in that command turn to the manifest. Revisions written before
the trimmed brief keep their typed columns; on read they fold into one spec (`## Intent`,
`## Checklist`, `## Non-goals`, `## References`, then the old build spec). Existing rows are never
rewritten.

A no-code corner upgraded into the code lane gets a placeholder revision 1 inside that upgrade's own
transaction (`composeCornerUpgradeBrief`, `apps/server/src/corner-brief.ts`): the spec opens with
`## Request` quoting the triggering human message, carries the earlier discussion as context, and is
approved by that message. The row is authored by `@system`, never by the agent whose work it
authorizes, and a corner that already holds revisions keeps them. The restarted code session reads
the code, writes the real spec with `revise_corner_brief`, and asks the corner's opener to approve
it. That approval is best effort and never enforced; no-code work never waits for it.

Approval is proportional. An initiating command authorizes a revision only when it already settles
the exact material scope. Otherwise the planner asks the human one specific unresolved choice and
records the answer against that revision. Silence is never approval, and settled requests do not
receive a blanket proposal/go ceremony.

The release-managed `beeline-spec` skill has two paths. Small, settled fixes take the compact path.
Complex work performs current-state and scope analysis, user stories, architecture/data flow,
failure modes, an acceptance/test map, automatic mock attachment, implementation-task synthesis,
and a bounded default-on adversarial second read. Findings return to the planner; only a material
product choice goes to the human.

Workers fetch and verify the current brief and files on every turn. The spec's checklist is the
scope and the approval quote wins any conflict; the short objective is navigation text only.
Reviewers cite checklist lines for every finding and separate product-completeness findings from
engineering findings. Only a human-authorized revision may
remove a requirement.

Merge approval is exact-head and exact-revision only. There is no patch-ID carry-over: whitespace,
line-ending, rename/mode-only, binary, and all other head changes require review of the new head.
The existing composite `pr_checks_status` gate remains the sole merge authority; validation-stage
records are evidence, not authorization.

On the phone and in the desktop work pane, a Brief link on the objective line opens the latest
revision full-screen in the in-app artifact viewer as Markdown: spec, approval quote, then files.
There is no revision history in the viewer. Brief enrichment still degrades independently of the core
Room read.

## Acceptance proof

Run the complete proof only with a disposable local proof database/workspace:

```sh
BEELINE_REAL_CURSOR_TOOL_PROOF=1 \
  BEELINE_REAL_CURSOR_MODEL=auto \
  npm run prove:corner-brief-acceptance
```

The command fails closed for its live-harness boundary: without the opt-in that boundary is skipped with a printed notice and the deterministic server/body/mobile boundaries still run, so a normal review worktree can run the proof; the complete proof (real native Cursor session included) requires the env vars above. The mobile boundary is likewise skipped with a notice when the worktree has no isolated `apps/mobile` install (`npm run mobile:install`); the phone tests run where mobile is installed. The command builds the full workspace export closure itself (the same dependency chain BODY SUITE uses) before any deterministic boundary, so a bare `npm ci` worktree needs no hand bootstrap, and the server/body boundaries run with generous explicit test timeouts so a cold or shared machine does not blow the vitest default. It combines these boundaries in
one fixture:

1. Server HTTP/database tests preserve a long corrected discussion, bind an actual posted object to
   the draft, enforce typed creation/revision, and reject missing or forged human authorization.
2. A real native-discovery Cursor session posts an HTML visual mock, opens the corner, is stopped,
   and is replaced by a fresh worker. That worker restores the brief, downloads the server-owned
   mock after restart, completes a turn, receives a genuine midstream human correction, and writes
   a new human-authorized revision.
3. The fallback/read-only-MCP tests provision and expose the same managed skill tree for Goose and
   custom/reference commands and verify its mounted read-only path.
4. The reviewer lifecycle fixture deliberately presents a partial first implementation, records a
   refusal with stable finding ID `PROD-AC-2-1`, repairs it, dispatches a rereview, and approves only
   the repaired exact head and current revision. The author gate then clears.
5. Focused phone tests verify provenance, approval basis, and revision-history disclosure.

The complete native live test passed on 2026-09-25 in a disposable proof workspace. The run observed
the real `post_artifact`, `createCorner`, media download, restart restoration, and
`reviseCornerBrief` calls. The Cursor account's Composer quota was exhausted, so the successful run
used its live `auto` model; this is a model-selection limitation, not a native-discovery or workflow
simulation. Goose/custom native skill discovery remains unverified: those harnesses are covered
through their supported read-only-MCP fallback path.

The broader server integration file still has nine unrelated baseline failures recorded before this
work. All focused acceptance cases, body contract tests, API/auth builds, affected typechecks, and
the live proof above pass; focused evidence must not be represented as a green full server suite.
