# Durable specs from Room discussion to reviewed delivery

Revision: 2 — draft for product review; adds no-mistakes-style validation
Author: Emberus
Status: specification only; no implementation or skill installation performed.

## Intent and source of truth

A person should be able to develop a product plan in a Room, authorize work, and have an implementation agent and reviewer receive the same complete assignment even when each starts with a fresh context.

This specification implements the four components requested by lunchboxfortwo:

1. A skill for writing an appropriate specification.
2. Confirmation only when the request leaves material choices unresolved.
3. Delivery of the brief and relevant files when opening a corner.
4. Review against that specification, through the existing review procedure.

Settled user decisions:

- Obvious changes, such as a well-specified button fix, must not require reading and approving a formal spec.
- Complex work must preserve acceptance criteria, user stories, mocks, and required tests through the handoff.
- The reviewer must assess whether the requested product was built.

The mechanisms proposed below are implementation recommendations, not additional user decisions. Existing command authorization, resource permissions, human holds, and merge authority remain authoritative.

## Observed failure

The Resource Permission Policy corner received a short objective referring to an “agreed matrix” without receiving that matrix. Draft PR #1712 explicitly reported missing context and implemented only removal of budget prompts. The full matrix was subsequently sent through steering.

This is a concrete acceptance fixture: the new workflow must deliver the matrix before implementation begins and prevent a partial budget-removal change from passing review as the complete assignment.

Current inspected entry points:

- apps/body/src/read-only-mcp.ts: open_corner accepts name, objective, and lane, with no full brief.
- apps/server/src/daemon-service.ts: createCorner persists the objective and queues the opener.
- apps/body/src/monolith-corner-turn.ts: constructs the worker prompt from objective, corner conversation, and trigger.
- apps/body/src/beeline-skill.ts: owns bundled review procedure and Room workflow guidance.
- Firstmate bin/fm-brief.sh provides a useful precedent: separate human intent from agent-authored implementation spec.

These are starting points; implementation must follow current code rather than assume these files are unchanged.

## Scope and exclusions

Deliver all four components as one usable path: draft -> decide whether clarification is necessary -> dispatch exact brief and files -> implement -> review requirements and evidence.

Do not build a general task scheduler, agent hierarchy, multi-agent project dashboard, document editor, or new merge gate. Do not copy whole Room transcripts into every worker prompt. Do not import gstack or Firstmate wholesale. No mandatory mocks, exhaustive test lists, or large templates for trivial changes.

Keep short corner names and objectives for navigation. They are summaries, not substitutes for the brief.

## User stories

| ID  | Story                                                                                            | Successful outcome                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| U1  | As a user discussing a complex feature, I want settled decisions retained.                       | A new worker receives the agreed behaviors, exclusions, references, and proof requirements without reconstructing the conversation. |
| U2  | As a user requesting a precise small fix, I want action without paperwork.                       | The agent writes a compact brief and proceeds under existing authorization without asking me to approve the obvious.                |
| U3  | As a user whose request contains a meaningful ambiguity, I want one focused question.            | The answer resolves the affected requirement; already settled choices are not reopened.                                             |
| U4  | As a worker starting or restarting a corner, I need the assignment and its files.                | I receive the current assigned revision and usable attachments before doing dependent work.                                         |
| U5  | As a user correcting work in progress, I want the correction to reach implementation and review. | A new revision records the change and supersedes the old assignment explicitly.                                                     |
| U6  | As a reviewer, I need to distinguish working code from complete delivery.                        | My verdict identifies which criteria pass, fail, or remain unverified, with evidence.                                               |
| U7  | As a user checking progress, I want to inspect the assignment.                                   | The Room/corner exposes the brief revision and attached references in a readable form.                                              |

## Component 1: Specification-writing skill

Proposed skill name: beeline-spec.

Use it when preparing repository work for a corner or revising an existing assignment. It is not a prerequisite for ordinary conversation, explanations, or unrelated artifact delivery.

The skill gathers relevant settled decisions and references, checks enough existing behavior to avoid inventing requirements, and writes a brief that another session can execute independently. It separates:

- Human intent and explicit decisions.
- Observed current behavior and evidence.
- Proposed implementation approach and stated assumptions.
- Material unresolved questions.

Every brief has an outcome, scope, and observable acceptance criteria. Include stories, design references, dependencies, migration considerations, failure behavior, and test scenarios only when relevant.

Acceptance criteria receive stable IDs. They describe behavior, not implementation-shaped assertions. A test plan specifies what must be demonstrated and at which boundary; it does not force a particular testing framework or unnecessary tests for harmless copy changes.

A file reference records its purpose and status, such as “approved visual authority,” “content-only mock,” or “unapproved exploration.” For example, a content mock must not silently replace the Settings page as styling authority.

## Component 2: Proportional confirmation

Writing a brief never itself grants execution permission. Existing authorization from the user remains sufficient within its scope.

The agent asks a focused question only when an unresolved choice could materially change behavior, scope, irreversible effects, or the user's intended result. Task size alone is not a reason to request confirmation. A complex plan whose decisions are already settled may be dispatched under the existing go-ahead.

For an obvious change, the compact brief can be internal to the handoff and available for inspection. Do not add a “please approve this spec” step.

When confirmation is needed, show the specific decision and relevant portion of the spec; offer a recommendation. Record the answer and update the affected criteria. Do not equate silence with consent.

Update Room instructions and skills that currently require a proposal/go exchange for every ask, so they consistently reflect this rule. Explicit user requirements to review before proceeding remain binding.

## Component 3: Durable delivery and revision

Proposed product contract:

- A brief has an ID, immutable revision, source Room, author, intent, requirements, and attachment manifest.
- Human decision references identify their source messages where available. Agent recommendations remain labelled.
- A corner assignment references a specific brief revision.
- Files use server-owned attachment identifiers with original filename, media type, content identity, purpose, and required/optional status. A session-local path alone is not a handoff.
- A validated authorization record or existing command provenance controls dispatch; text saying “approved” does not authorize anything.

Extend open_corner to supply a brief or durable brief reference alongside the existing short objective. Prefer a single dispatch operation that persists the exact assignment and queues work atomically. An implementation may upload files first, but must validate their availability and access before starting the worker.

Do not impose the objective's 24-word limit on the brief. Use existing payload limits where suitable and add documented explicit limits if needed; never silently truncate requirements. Optional large references can be retrieved as files while mandatory assignment content stays available.

The first worker turn receives the brief revision and attachments. Fresh sessions and restarts reconstruct the same current assignment independently of transcript windows. Missing required attachments pause dependent execution with a precise recovery explanation; independent work may continue.

Steering that changes requirements creates a new immutable revision with a concise change description and source. The worker receives that update through existing command routing. Implementer and reviewer use the same latest assigned revision. Old revisions remain inspectable.

If a requirement revision changes during review, a verdict against the older revision cannot authorize completion under the newer one. Integrate revision identity with the existing exact-head review gate; do not create a competing approval system. Preserve existing clean catch-up approval behavior only when both code identity and assigned requirements remain applicable.

Legacy corners remain readable and operable. Their objective/transcript can seed a clearly labelled legacy brief when necessary; never invent prior approval or retroactively require every closed corner to have a full spec.

## Component 4: Review against requirements

Modify the existing bundled review procedure rather than introduce an independent reviewer.

The reviewer receives the assigned brief, applicable mocks/files, implementation diff, and evidence. Review has two obligations:

1. Product completeness: every applicable acceptance criterion is met.
2. Engineering correctness: code, security/authorization, regressions, and maintainability are acceptable.

For each criterion, record met / unmet / unverified / explicitly out of scope, with a concrete evidence reference. “Out of scope” requires a user-authorized scope revision; the implementer cannot erase a difficult requirement by narrowing the PR description.

Green CI is evidence, not proof of full scope. A missing criterion or required unverified behavior prevents approval. Extra requirements invented by the reviewer are suggestions unless they are necessary for correctness or an existing invariant.

Use the existing reviewer verdict and handback mechanism. Do not invent a new numeric score or a new FAIL database state. A spec mismatch is explained through the existing refusal path.

## Acceptance criteria and verification

| ID  | Acceptance criterion                                                                | Required demonstration                                                                                                         |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A1  | A fresh worker can identify all settled requirements without the parent transcript. | Integration fixture with a long Room discussion, corrections, and a fresh worker prompt; required decisions all present.       |
| A2  | A precise button fix requires no additional spec-confirmation exchange.             | Behavioral skill trial: exact visible label request with settled location and scope; compact brief, zero redundant questions.  |
| A3  | A material unresolved choice triggers a targeted question before dependent work.    | Behavioral trial with ambiguous “ban”: clarify removal versus prevention of rejoining; no invented decision.                   |
| A4  | Dispatch cannot wake a worker with a missing or different brief.                    | Integration test for successful dispatch, persistence failure, invalid required attachment, and idempotent retry.              |
| A5  | Relevant mock/file bytes reach a different session or helper.                       | Deliver an attachment from server storage after source scratch deletion; verify content identity and purpose.                  |
| A6  | Restarts and transcript truncation preserve the assigned spec.                      | Fresh-session prompt construction after a long conversation includes current revision and required references.                 |
| A7  | A correction changes the assignment explicitly for worker and reviewer.             | Revision update test; old revision retained, new one delivered; concurrent stale review cannot satisfy current assignment.     |
| A8  | Requirement completeness is part of review.                                         | Permissions fixture: budget-only diff fails full-matrix review despite passing its narrow tests.                               |
| A9  | Reviewer checks evidence appropriate to each requirement.                           | A visual requirement without required screenshot proof is unverified; authorization criteria require server-boundary evidence. |
| A10 | Existing access and command authorities remain intact.                              | Unauthorized brief/attachment reads and mutations are refused; dispatch still requires authorized command context.             |
| A11 | The human can inspect the dispatched brief and references.                          | App-level verification of brief access from the corner/Room handoff, including revision and attachment titles.                 |
| A12 | Existing corners and merge rules continue working.                                  | Focused regression coverage for legacy corner startup, reviewer dispatch, exact-head approval, and clean catch-up behavior.    |

Tests should target behavior and actual boundaries. Avoid tests that merely check whether a prompt contains a heading. Behavioral skill evaluations should judge decision preservation and appropriate questions, not exact wording.

## Smallest coherent delivery plan

1. Define the durable brief, revision, attachment, and assignment contract with boundary tests.
2. Wire dispatch and session restoration before encouraging agents to depend on the skill.
3. Add the concise writing skill and align Room/triage guidance with proportional confirmation.
4. Update reviewer delivery and review procedure; verify revision-aware gate behavior.
5. Run the real handoff fixtures and app proof, then report criterion-by-criterion delivery.

A single lead owns the contract. If delegating, writing/review guidance and app presentation can proceed separately after agreeing that contract. Storage, command creation, and revision validation need coordinated ownership.

## Trial performed while drafting this document

This was a manual authoring and scenario walkthrough, not an installed-skill or runtime test.

Trial 1 — this feature:

- Turned the user's four components into U1–U7 and A1–A12.
- Preserved “confirmation only when needed”; rejected a blanket full-spec approval gate.
- Identified that skill instructions cannot guarantee atomic handoff or restart recovery; those require product changes.
- No additional question was needed to produce this draft. Storage and transport choices are marked as proposals.

Trial 2 — minimal button request:
Input: “Change the message action label from Remove to Delete; leave the confirmation and accessibility wording unchanged.”
Compact brief:
Outcome: show Delete in that action row.
Scope: visible row label only.
Acceptance B1: the specified row displays Delete.
Acceptance B2: confirmation and accessibility wording are preserved.
Proof: inspect the changed row and relevant existing UI checks; do not add unrelated tests.
Confirmation: none; the request specifies behavior and exclusions.
This is an illustrative drafting trial, not a performed code change.

Trial 3 — known incomplete handoff:
Compared the permissions conversation with the inspected #1712 draft, whose body said the matrix was absent and whose diff only removed budget prompts.
The expected review outcome is incomplete delivery against the matrix, not approval based on the budget tests.
The missing matrix was already delivered by steering in the preceding Room turn. No claim is made here that the subsequent implementation has passed.

What changed because of the trial:

- Keep a compact path, not a mandatory long template.
- Label the authority and approval status of mocks.
- Include the exact revision in review, not merely in worker startup.
- Separate engineering suggestions from settled user decisions.
- Require evidence of requirements, not evidence of whatever the PR happened to implement.

## Skill recommendation after the trial

Build one focused writing skill, beeline-spec, and extend the existing review skill/procedure.

Suggested package:

- SKILL.md: when to use it, scaling brief depth, source decisions, clarification rule, dispatch readiness, and revision handling.
- references/brief-template.md: optional expanded structure for complex work.
- references/examples.md: one compact button brief and one complex example demonstrating decisions, criteria, references, and proof.
- A small behavioral evaluation set: obvious fix, already-approved complex plan, ambiguous requirement, content-only mock versus styling authority, and incomplete implementation.

Do not put database transactions, attachment transfer, polling loops, or merge authority into skill prose as if instructions enforce them. The skill uses the product's verified transport and existing review machinery.

Before shipping the skill, run independent fresh-context evaluations and one real Room-to-corner-to-review exercise. This draft establishes the candidate behavior; those evaluations have not yet run.

## Revision 2: Review modeled on no-mistakes

Requested by lunchboxfortwo after revision 1. This section extends Component 4 and the delivery acceptance criteria. It specifies native Beeline behavior patterned on the inspected no-mistakes skill; it does not claim that the no-mistakes executable ran or passed.

### Pipeline and ownership

Use one visible validation record for a brief revision and code head. Mirror the sequence intent -> base synchronization -> review -> tests -> documentation -> lint/type checks -> publication -> CI -> final Beeline authorization.

| Stage                | Responsibility                                                                                                     | Evidence                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Intent               | Coordinator prepares; worker and reviewer consume.                                                                 | Complete brief revision, explicit user decisions, exclusions, and attachment manifest; not a diff summary.                 |
| Base synchronization | Author or the single active pipeline executor.                                                                     | Branch/base state and resolution of conflicts under existing branch rules.                                                 |
| Independent review   | Configured reviewer.                                                                                               | Acceptance-criterion coverage plus correctness findings, each with location, severity, evidence, and proposed disposition. |
| Tests                | Author/executor runs; reviewer assesses coverage and results and performs targeted independent checks when needed. | Executed behavior tests, regression proof where feasible, and required visual or integration evidence.                     |
| Documentation        | Author updates relevant docs; reviewer verifies.                                                                   | Behavior/API/workflow documentation changes, or a specific reason none are needed.                                         |
| Lint/type checks     | Author/executor runs.                                                                                              | Applicable project check results bound to the delivered code version.                                                      |
| Publication          | Author or authorized executor publishes branch and PR.                                                             | Actual PR/head reference; never a reviewer-owned merge.                                                                    |
| CI                   | GitHub remains authoritative.                                                                                      | Current-head check rollup through existing Beeline gate.                                                                   |
| Final authorization  | Reviewer records verdict; author checks composite merge gate.                                                      | Current requirements satisfied, applicable evidence, exact-head/revision authority, existing yolo and human-hold rules.    |

The stages describe obligations, not a second scheduler or rigid new reviewer activation order. The existing reviewer can still wake after CI is green and examine the collected record. Relevant docs/tests/lint may already have run before that wake. Reuse applicable evidence instead of mechanically rerunning the whole suite.

### Findings and repair loop

Each finding has a stable ID, affected criterion (when applicable), location, severity, explanation, evidence, and disposition:

- Mechanical or correctness fix within settled intent: return to the author/executor to repair without another human approval request.
- Informational: record; do not block delivery.
- Product decision: ask the human only when genuinely unresolved or when a change to deliberate intent is needed. Existing decisions must be applied, not repeatedly reopened.

The reviewer identifies issues and verifies their resolution. The author owns repairs and delivery. After a repair, rerun affected checks and invalidate dependent evidence. A changed requirement invalidates the relevant prior requirement verdict even if code is unchanged. Approval is exact-head-only: every new PR head requires a fresh reviewer verdict, including a base catch-up. Do not weaken Beeline's final merge gate.

If the actual no-mistakes tool is used by an author, it remains the sole owner of its active run and fixes. Do not start nested pipelines from a review phase or edit around its branch custody. This native review design does not require that CLI to be installed.

### Evidence and completion

Expose each applicable stage as pending, running, passed, failed, skipped, or not applicable, with a reason for skipped/not-applicable stages. These are validation-record states, not new corner reviewer verdict states.

A required skipped, failed, or unverified stage cannot become an unconditional reviewer PASS. An empty CI response is not passing CI. Tests checking for strings in implementation source do not establish behavior; emitted public artifacts may be tested as contracts, while agent interpretation is evaluated separately.

Only report "no-mistakes passed" when an actual run supports that claim. Native execution should be described as Beeline validation modeled on no-mistakes, listing missing evidence honestly. Passing validation does not itself prove merge or deployment.

### Added acceptance criteria

| ID  | Acceptance criterion                                                                                 | Required demonstration                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A13 | Validation uses the complete brief and its assigned revision.                                        | A deliberate, unusual user choice is retained during review rather than flagged because only the diff was supplied.                                          |
| A14 | Review covers intent, correctness, tests, docs, lint/type checks, publication, and CI as applicable. | End-to-end record shows evidence or explicit non-applicability for every stage; no false all-clear when a required stage is skipped.                         |
| A15 | Findings produce a bounded, observable repair handoff.                                               | Reviewer refuses an incomplete head, author fixes it, affected checks rerun, and reviewer assesses the updated head/revision using existing handback limits. |
| A16 | Review avoids redundant human decisions.                                                             | Mechanical defect returns to author; unresolved product tradeoff reaches human; already-settled tradeoff is not asked again.                                 |
| A17 | Pipeline execution preserves responsibility and gate authority.                                      | Reviewer never pushes or merges as part of review; author still needs the existing composite gate; no nested actual no-mistakes run.                         |
| A18 | Reported validation matches actual evidence.                                                         | Missing CI, skipped required checks, stale head/revision, and unavailable tooling cannot produce a claimed complete validation.                              |

### Updated skill recommendation

Keep beeline-spec as the writing skill. Extend the existing review procedure with a concise staged checklist, findings/repair protocol, and criterion-to-evidence reporting. Put detailed stage guidance in an optional supporting reference. Product code owns durable evidence, assignment revision binding, and existing gate integration.

This addition has been compared with the locally installed no-mistakes skill. No pipeline was executed during this specification revision.

## Rollout clarification from lunchboxfortwo (verbatim)

Rollout clarification from lunchboxfortwo: 'So to be clear, every agent I talk to in beeline is going to be doing this same thing?' Treat the approved workflow as shared Beeline behavior for all supported agent harnesses, not a private Emberus/BBC skill or opt-in slash command. Ship the spec skill and proportional-confirmation instructions through the common release-managed agent-home/instruction distribution; apply durable brief handoff to every supported agent opening repository work and the spec-based staged procedure to every configured corner reviewer. Preserve ordinary conversation without spec overhead and compact briefs without redundant approval for obvious fixes. Verify existing agents receive updated shared guidance on their normal refresh/restart path and newly paired agents receive it too; identify any harness limitations explicitly. Include evidence across supported harness delivery paths. Do not claim existing running sessions already have the new behavior before rollout.
