---
name: beeline-spec
description: Prepare or revise a durable corner assignment from Room decisions before repository work. Do not use for ordinary conversation or unrelated artifact delivery.
---

<!-- beeline-release: source -->

# Durable corner brief

Create an assignment a fresh session can execute without the parent transcript. The typed outer contract is mandatory for repository and research work:

- `intentVerbatim[]`: exact human words plus each Room message ID. Copy snapshots exactly; never substitute a summary.
- `buildSpec`: agent-authored Markdown implementation guidance.
- `criteria[]`: observable acceptance criteria with stable numbered IDs such as AC-1. Retain IDs across revisions; do not renumber unaffected criteria.
- `nonGoals[]`: explicit exclusions.
- `references[]`: each reference or mock with a label, description, optional object ID, and authority label. An optional or agent-generated mock is not styling authority unless a human made it so.
- `approvalBasis`: either the initiating human command when it already settled the exact material scope, or the exact later human answer that settled a specific unresolved choice or requested brief slice.

Do not infer approval from silence, assent to different prose, or the mere existence of a plan. Keep agent recommendations labelled as recommendations. Do not promote a plausible UX detail, algorithm, failure message, or extra test into a requirement merely because it sounds helpful.

## Compact path for a settled small fix

Use this when the requested behavior, touched surface, exclusions, and proof are already obvious. Inspect the narrow current behavior, write the exact intent snapshot, a short build spec, stable observable criteria, non-goals, references, and the initiating-command approval basis. Dispatch without a proposal/go ceremony. “Change the message action label from Remove to Delete; leave confirmation and accessibility wording unchanged” needs the visible-label criterion and both exclusions, not another confirmation question.

## Complex-work planning loop

Use this default-on loop when work crosses components, changes architecture or authorization, needs a visual choice, has multiple user stories, or still contains a material unknown.

### 1. Scope and current state

- Collect every relevant human message, including corrections; later corrections supersede only what they explicitly change. Preserve their exact text and IDs in `intentVerbatim`.
- Inspect current code, data contracts, tests, recent related work, repository invariants, and existing behavior. State what exists, what is missing, and what is deliberately out of scope.
- Separate facts, human decisions, agent recommendations, and unresolved choices.

### 2. User stories and product boundary

- Write the actor/action/observable-result stories.
- Map each story to one or more stable criterion IDs and explicit non-goals.
- If one unresolved choice would materially change behavior, scope, irreversible effects, or the intended result, present only that choice or the affected brief slice to the human. Record the exact answer message in `approvalBasis`. Never treat no answer as approval.

### 3. Architecture and data flow

- Trace inputs, authorities, state transitions, persistence, outputs, and trust boundaries.
- Name the existing components to reuse and the smallest coherent changes.
- Describe migration and compatibility behavior only where the human intent or existing data requires it.

### 4. Failure modes and test map

- Enumerate missing/stale data, retries, concurrency, partial failure, authorization failure, rollback, and boundary-specific hazards that apply.
- Build an acceptance map from every criterion ID to its proof boundary: unit, integration, device/browser, server authorization, migration, or live harness. No criterion may be left without planned evidence.

### 5. Mocks and references

- When a visual or interaction decision needs eyes, create and post one self-contained mock using the using-beeline mock procedure.
- A mock/file posted with `post_artifact` in this planning turn is added automatically to the brief attachment manifest; do not manually copy its object ID. Still add a typed reference explaining its authority. Existing human-posted files must be named explicitly in attachments.

### 6. Implementation tasks

- Synthesize ordered, independently verifiable tasks. For each task name the affected boundary, criterion IDs, expected files/components, failure handling, and proof.
- Keep the build spec actionable, not a transcript summary.

### 7. Bounded adversarial second read (default on)

- Spend one pass, bounded to the drafted scope, trying to disprove completeness: find a missing story, authority mismatch, unhandled failure, criterion without proof, mock ambiguity, accidental scope expansion, or task-order hazard.
- Return findings to the planning agent and repair the draft. Escalate only a genuinely material product choice to the human; engineering choices and mechanical gaps are resolved in the plan.
- End after one adversarial pass unless its repair exposes one new material product choice. Do not recursively review the review.

## Dispatch and revision

Existing authorization permits dispatch when the initiating command already settles the exact material scope. Drafting a brief does not create approval. Honor an explicit request to review first. When a later answer is needed, bind that exact message snapshot as `explicit-human-answer`; the server records it against the exact revision hash.

Pass the typed contract as `open_corner.brief`. Read the current revision before revising and use `revise_corner_brief` with the complete replacement plus a concise change description. Preserve unaffected intent, criteria IDs, and authority labels. The latest revision governs implementation and review; chat prose alone never changes scope.
