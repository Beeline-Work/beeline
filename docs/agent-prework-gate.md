# Agent pre-work gate

## Decision

Require every agent to complete one server-recorded preflight before it can open a writable
corner. The preflight covers three questions:

1. Is this work already active or already delivered?
2. What existing behavior can this change regress, and how will the corner preserve it?
3. Does the work support the repository's stated product direction?

The gate runs in the read-only parent Room. A successful result is a short-lived receipt bound to
the agent, Room, originating command, and exact normalized objective. `createCorner` must reject a
repository-backed corner without that receipt. Chat-only corners use the same gate without the
GitHub search lane.

The model makes the semantic decision. The server gathers authoritative candidates, validates the
shape of the evidence, records the decision, and enforces that the process happened. A lexical
match alone never blocks work.

## Why this shape

Several established practices agree on checking direction before implementation:

- GitHub's issue-form example makes searching existing issues a required attestation, and GitHub
  gives duplicates an explicit relationship so related work remains discoverable instead of
  becoming parallel maintenance.
- Google's review guidance starts with whether a change makes sense at all and recommends raising
  major design problems before detailed review. Its broader checklist asks whether the change fits
  the system, avoids speculative complexity, and has tests that would fail for the regression.
- Kubernetes requires most non-trivial changes to use a common proposal record. Its template asks
  for motivation, goals, non-goals, user stories, risks, tests, and rollback or disablement before a
  proposal becomes implementable.

The useful common denominator is small: search first, state the user outcome, name what must not
break, and compare the change with an authoritative direction. Beeline should not copy the full
issue or enhancement processes into every task.

Sources:

- [GitHub issue forms](https://docs.github.com/en/enterprise-cloud@latest/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)
- [GitHub duplicate relationships](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/marking-issues-or-pull-requests-as-a-duplicate)
- [Google: navigating a change review](https://google.github.io/eng-practices/review/reviewer/navigate.html)
- [Google: what to look for in a change review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- [Kubernetes enhancement process](https://github.com/kubernetes/enhancements/blob/master/keps/README.md)
- [Kubernetes enhancement template](https://github.com/kubernetes/enhancements/blob/master/keps/NNNN-kep-template/README.md)

## Current gap

Beeline already has two good boundaries:

- `using-beeline` requires a named, fixed objective and normally asks a person to confirm it.
- `CORNER_AUTHOR_CONTRACT` requires reproduction, a regression test, and a built demonstration
  after the corner opens.

Neither boundary checks whether another corner, issue, pull request, commit, or existing feature
already satisfies the ask. Vision and regression reasoning happen only if the harness remembers to
do them. The server currently proves only that the opening command is authorized and idempotent for
the same request. Two different requests can still commission the same work.

The confirmation ceremony is also prompt-enforced. `createCorner` cannot tell whether an agent
inspected the project before calling it. Adding more prose to the prompt would improve behavior but
would not make the gate agent-wide.

## User-visible flow

### Clear work

1. A person asks for a change.
2. The agent inspects relevant code and project guidance, then calls `preflight_corner`.
3. The tool returns `clear` with a receipt and a compact evidence summary.
4. If ordinary confirmation is required, the agent posts the existing `Proposed corner:` line. On
   confirmation it calls `open_corner` with the receipt. An explicitly scoped corner command may
   proceed immediately.

The normal case adds no extra chat turn.

### Existing work

If the evidence shows an exact active corner or open pull request, the agent does not propose a new
corner. It links the existing work and either answers from it or asks whether the person wants that
work steered. The gate records `parked_duplicate` and issues no receipt.

If a merged change already provides the requested outcome, the agent reports the evidence and
parks. A person can restate a different unmet outcome, which creates a new objective and preflight.

### Ambiguous or conflicting work

If overlap is plausible, regression exposure is high but underspecified, or product guidance
conflicts, the tool returns `needs_confirmation`. The agent asks one concrete question containing
the relevant evidence. A person's informed answer is a new command; the agent records it in a new
preflight. There is no generic “override” checkbox and no reusable bypass.

## Tool contract

Add `preflight_corner` next to `open_corner` on top-level Room surfaces.

```ts
type PreflightCornerInput = TurnOutputAuthority &
  RoomInput & {
    requestId: string;
    name: string;
    objective: string;
    workKind: 'defect' | 'feature' | 'maintenance';
    userStory: string; // "a person who does X sees Y"
    duplicateAssessment?: readonly {
      candidateId: string;
      verdict: 'duplicate' | 'overlap' | 'unrelated';
      reason: string;
    }[];
    repositoryFindings?: readonly {
      kind: 'commit' | 'code' | 'test';
      reference: string;
      conclusion: string;
    }[];
    regression: {
      affectedPaths: readonly string[];
      behaviorToPreserve: string;
      reproductionOrBaseline: string;
      plannedProof: string;
      rollback?: string;
    };
    vision: {
      references: readonly { path: string; section?: string }[];
      alignment: string;
      nonGoals: readonly string[];
    };
    risk: {
      level: 'low' | 'medium' | 'high';
      reasons: readonly string[];
    };
  };

type PreflightCornerResult = {
  preflightId: string;
  verdict: 'clear' | 'needs_confirmation' | 'parked_duplicate';
  candidates: readonly WorkCandidate[];
  risk: 'low' | 'medium' | 'high';
  reasons: readonly string[];
  expiresAt?: number;
};
```

The first call omits `duplicateAssessment`. The server returns candidates and no usable receipt.
The agent classifies every returned candidate, adds relevant checkout findings, and submits the
completed evidence on the second call. This keeps remote candidate discovery authoritative without
asking the server to make semantic claims.

`open_corner` gains required `preflightId`. `CreateCornerInput` carries it through to the server.
The server consumes it in the same transaction that creates the Room and writes the receipt ID to
`corner_facts`. Retries for the same originating request remain idempotent.

## Evidence collection

Candidate discovery should be bounded and deterministic:

- Active and archived sibling corners: query `rooms` and `corner_facts` in the parent Room.
- GitHub issues and pull requests, open and closed: search the bound repository through its existing
  installation credential. Return number, type, state, title, URL, and update time.
- Recent repository history: the agent uses the existing read-only checkout and reports matching
  commits or paths. The server does not need access to the operator's filesystem.
- Current implementation: the agent cites files, tests, or symbols found with the existing
  read-only repository tools.

Search terms are derived from the normalized objective and user story, with an optional bounded
list supplied by the agent. Cap each source, rank exact identifiers and phrase overlap first, and
always label results as candidates. If GitHub is unavailable, return `needs_confirmation` with a
specific degraded-source reason; do not claim the search is clear.

For the first release, project-direction references are repository files the agent actually read.
Use this discovery order when present: `AGENTS.md`, `spec.md`, `VISION.md`, `ROADMAP.md`,
`CONTRIBUTING.md`, and `README.md`. References are evidence, not authority granted by a filename;
the agent must quote the section's meaning in its alignment statement. A later repository setting
may name canonical files, but the gate must not hard-code Beeline's document names as a universal
product model.

## Risk classification

Risk controls the required detail, not whether useful work is allowed.

- `low`: local presentation, copy, or isolated behavior with a narrow existing test seam.
- `medium`: shared contract, multi-component behavior, persistence read path, or default behavior.
- `high`: authorization, secrets, destructive writes, schema migrations, release paths,
  concurrency, cross-tenant data, public API compatibility, or no safe rollback.

Medium and high risk require a concrete baseline and integration-level proof. High risk also
requires rollback or an explanation of why rollback is impossible, plus informed human
confirmation if the original request did not already acknowledge that consequence. These are
structural checks over the agent's evidence; the server should not infer risk from filenames alone.

The stored regression record is injected into the corner prompt beside the immutable objective.
That lets the corner author and reviewer verify the same promised preservation work instead of
reconstructing it after implementation.

## Storage and enforcement

Add `corner_preflights`:

```text
id, workspace_id, room_id, agent_id,
root_command_id, source_message_id,
name, objective, objective_hash, work_kind, user_story,
candidates, duplicate_assessment, repository_findings,
regression, vision, risk, verdict, reasons,
created_at, expires_at, consumed_at
```

Important invariants:

- A receipt is valid only for its Room, agent, live root command, normalized name and objective.
- A changed objective requires a new preflight. Hash the normalized values, not raw whitespace.
- Only `clear` can be consumed.
- A receipt expires after 15 minutes or when a candidate active corner/PR changes state. Start with
  time expiry; webhook invalidation can be added without changing the contract.
- Consumption and corner creation are atomic. A consumed receipt points to exactly one corner.
- A server that does not advertise the operation cannot accept the new `createCorner` shape. Keep
  mixed versions fail-closed, as agent commands do.
- Scratch-backed chat-only work records local duplicate, regression, and alignment evidence but
  does not fail because no repository or GitHub source exists.

The receipt is an audit fact, not a transcript card. People should see only a useful exception:
existing work, a conflict, degraded discovery, or a consequential risk that needs a decision.

## Placement in the existing system

- `packages/api-contract/src/daemon-operations.ts`: add the operation, result types, and
  `preflightId` on `CreateCornerInput`.
- `apps/body/src/read-only-mcp.ts`: expose `preflight_corner`; retain the existing proposal and
  confirmation wording; require the receipt in `open_corner`.
- `apps/body/src/beeline-skill.ts`: describe the three checks and exception behavior in the shared
  Room guidance. Do not duplicate the full policy in each harness prompt.
- `apps/server/src/daemon-service.ts`: authorize, store, validate, consume, and project the
  preflight onto the created corner.
- `apps/server/src/github-operations.ts` and `apps/auth/src/github.ts`: add bounded repository issue
  and pull-request search through the existing installation-scoped client.
- `apps/body/src/monolith-corner-turn.ts`: include the user story and regression promise in the
  immutable corner context.

Do not put this in PR checks. By then duplicate implementation and product-direction waste has
already happened. Do not make it a mobile approval queue; ordinary clear work should stay silent,
and ambiguity should remain a normal Room conversation.

## Rollout

1. Ship contract, storage, candidate search, and a non-enforcing tool. Record verdicts and tune
   candidate limits against real tasks.
2. Update all supported harness guidance and require a clear receipt in the Body tool.
3. Once the minimum helper release is deployed, require and consume the receipt in the server.
4. Add webhook invalidation for active-candidate changes if the 15-minute bound proves stale in
   practice.

Measure duplicate parks, informed-confirmation rate, degraded searches, receipt latency, and the
share of opened corners whose promised regression proof appears in the pull request. Do not use
corner count reduction as a success metric by itself; agents could reduce it by refusing useful
work.

## Acceptance tests

- An active sibling corner classified as an exact duplicate returns `parked_duplicate`; no receipt
  can open another corner.
- A matching candidate classified `unrelated` with a reason can clear; lexical overlap alone never
  blocks.
- A merged PR classified as already producing the same user outcome parks with its URL.
- A changed objective, Room, agent, or root command cannot reuse a receipt.
- Two concurrent `createCorner` calls with one receipt create one corner.
- GitHub failure produces `needs_confirmation`, not an empty clear result.
- Medium/high-risk evidence without a baseline or integration proof is rejected structurally.
- High-risk irreversible work requires an informed follow-up command.
- Vision conflict or missing guidance for a product change asks one concrete question.
- A defect that restores an explicit invariant can clear without a product-design discussion.
- The corner prompt contains the stored user story and regression promise after restart.
- Repo-less work can clear without fabricated GitHub or repository evidence.
- Older helpers cannot bypass a server that has enabled enforcement.

## Non-goals

- Automatically deciding roadmap priority or product taste.
- Treating embedding or keyword similarity as proof of duplication.
- Replacing issue trackers, design documents, code review, checks, or the human hold.
- Requiring a long proposal for every small fix.
- Letting one approval bypass future objectives.
- Posting routine gate machinery into the Room transcript.
