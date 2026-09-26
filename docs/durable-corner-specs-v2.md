# Durable corner assignments

The original [v2 assignment](durable-corner-specs-v2-assignment.md) and
[fresh-context skill trials](durable-corner-specs-v2-evaluations.md) remain as design history.
This document describes the shipped contract and its acceptance proof.

## Current contract

Every new repository/code or research corner starts with a typed, human-authorized brief. A
revision contains:

- `intentVerbatim`: exact human message snapshots and their message IDs;
- `buildSpec`: the synthesized Markdown implementation specification;
- `criteria`: stable numbered IDs and their requirements;
- `references`: object/message/URL references with explicit authority labels; and
- `approvalBasis`: the exact initiating command or explicit answer that settled this material
  scope.

The server checks every human snapshot against the source Room, requires the approval-basis
message to remain in `intentVerbatim`, computes a deterministic revision hash, and commits the
brief, corner, and initial worker command together. It automatically adds ready artifacts posted
by the planner in that command turn to the manifest. The old `content` column is retained as a
legacy `buildSpec` projection for pre-migration rows; it is not accepted as the contract for a new
repository or research corner.

A no-code corner that a person upgrades into the code lane is the one repository corner nobody
typed a brief for, so the server composes its first revision inside that upgrade's own transaction
(`composeCornerUpgradeBrief`, `apps/server/src/corner-brief.ts`). The one explicit human ask that
triggered the upgrade is the whole `intentVerbatim` and the `approvalBasis`; everything said in the
corner before it is carried into `buildSpec` as context rather than authority, because a chat corner
holds superseded asks a worker could not rank. The row is authored by `@system`, never by the agent
whose work it authorizes, and a corner that already holds revisions keeps them.

Approval is proportional. An initiating command authorizes a revision only when it already settles
the exact material scope. Otherwise the planner asks the human one specific unresolved choice and
records the answer against that revision. Silence is never approval, and settled requests do not
receive a blanket proposal/go ceremony.

The release-managed `beeline-spec` skill has two paths. Small, settled fixes take the compact path.
Complex work performs current-state and scope analysis, user stories, architecture/data flow,
failure modes, an acceptance/test map, automatic mock attachment, implementation-task synthesis,
and a bounded default-on adversarial second read. Findings return to the planner; only a material
product choice goes to the human.

Workers fetch and verify the current brief and files on every turn. Verbatim intent plus the current
criteria are product authority; the short objective is navigation text only. Reviewers quote the
verbatim intent with source IDs, report evidence for every current criterion ID, and separate
product-completeness findings from engineering findings. Only a human-authorized revision may
remove a requirement.

Merge approval is exact-head and exact-revision only. There is no patch-ID carry-over: whitespace,
line-ending, rename/mode-only, binary, and all other head changes require review of the new head.
The existing composite `pr_checks_status` gate remains the sole merge authority; validation-stage
records are evidence, not authorization.

The phone Assignment disclosure shows provenance, approval basis, current criteria and references,
the current hash, and revision history. Brief enrichment still degrades independently of the core
Room read.

## Acceptance proof

Run the complete proof only with a disposable local proof database/workspace:

```sh
BEELINE_REAL_CURSOR_TOOL_PROOF=1 \
  BEELINE_REAL_CURSOR_MODEL=auto \
  npm run prove:corner-brief-acceptance
```

The command fails closed unless the live-harness opt-in is present. It combines these boundaries in
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
