# Agent request triage

## Decision

Run one lightweight triage skill before an agent proposes or opens a corner:

1. **Is it clear?** Rewrite the request as a concrete outcome with acceptance criteria and
   material exclusions. Ask a focused question when ambiguity could change the outcome.
2. **Is work warranted?** Reproduce a reported bug or establish the unmet need, then search current
   code, history, issues, and pull requests for work that resolves or supersedes it.
3. **Is it desirable?** Compare the request with repository-owned goals, invariants, architecture,
   user benefit, maintenance cost, and the smallest coherent solution.

Clarity can require a question before work is proposed. The other two legs emit evidence-backed
warnings but do not block the implementer. The configured reviewer independently repeats the
warranted-work and desirability checks against the completed change, verifies that the diff matches
the clarified request, and checks tests and regression exposure before approving the exact head.

Once a corner is open for a bug, the same skill's execution contract binds the implementer to that
isolated ask: reproduce it first under an identifier, change only what removes that reproduction,
and prove the same identifier now passes. The reviewer checks that named proof, not merely that
some test exists. Failed triage reproduction remains a warning; failed implementer reproduction
stops the fix.

This split keeps pre-work useful without creating a new approval queue. Triage improves the request
and exposes concerns while the reviewer remains the hard quality gate.

## Evidence behind the design

Several established practices support this shape:

- GitHub recommends giving coding agents clear, bounded tasks with explicit acceptance criteria.
- GitHub Next's issue-triage workflow searches related work but distinguishes duplicates from
  related issues, missing information, and cases needing maintainer judgment.
- Google's review guidance asks whether a change belongs in the codebase, benefits users, avoids
  speculative functionality, and improves overall code health.
- GitHub warns that agent review can miss defects or invent findings, so findings need independent
  verification.
- GitHub binds review approval to a revision; new commits require the updated head to be reviewed.

Sources:

- [GitHub coding-agent best practices](https://docs.github.com/en/copilot/using-github-copilot/using-copilot-coding-agent-to-work-on-tasks/best-practices-for-using-copilot-to-work-on-tasks)
- [GitHub Next issue-triage workflow](https://github.com/githubnext/agentics/blob/main/workflows/issue-triage.md)
- [Google: what to look for in a change review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- [GitHub responsible use for agents](https://docs.github.com/en/copilot/responsible-use/agents)
- [GitHub code review](https://docs.github.com/en/copilot/concepts/agents/code-review)

No published skill covers the complete flow. GitHub Next's issue-triage and contribution-checker
workflows provide useful rubrics, but the former stops before implementation and the latter starts
after a pull request exists. Beeline therefore needs a small repository-aware skill of its own.

## Triage behavior

The triage skill runs in the read-only parent Room, before either the ordinary `Proposed corner:`
line or a direct `open_corner` call.

### Clear request

Emit the existing proposal line without extra ceremony:

```text
Proposed corner: <name> — <objective>
```

### Unclear request

Ask one focused question when different answers would materially change the objective or acceptance
criteria. Do not guess at scope.

### Warranted-work or desirability concern

Keep the concern visible beside the proposal without blocking it:

```text
Proposed corner: <name> — <objective>
Triage warning — warranted: <evidence-backed reason>
Triage warning — desirable: <evidence-backed reason>
```

Emit only applicable warnings. A failed reproduction is a warning, not proof that the report is
false. A similar title is a search candidate, not proof of duplication. Missing evidence alone is
not a warning when the repository offers no practical way to obtain it. When a bug reproduction
succeeds, emit `Reproduction <id>: <user path> → <observable wrong result>` beside the proposal so
the implementer can cite it.

## Bugfix execution

The same `beeline-triage` skill carries the implementer contract. No new server gate, receipt, or
tooling. Once the corner is open for a reported bug:

1. **Reproduce first.** Before any change, reproduce the bug as triage isolated it. Record the
   exact user path and the observable wrong result under `Reproduction <id>`, reusing triage's
   identifier when it recorded one. If reproduction fails, stop and report what was tried; do not
   fix a bug the agent has not seen.
2. **Narrow fix.** Change only what removes that recorded reproduction. Nearby improvements are out
   of scope.
3. **Proof matching triage.** Re-run the same reproduction and show it now passing, cited by the
   same identifier, plus the regression that would fail if the bug returned.

## Desirability rubric

Use objective repository evidence where possible:

- The request serves a concrete user outcome.
- It is compatible with documented product direction and invariants.
- It follows established architecture unless the request authorizes changing it.
- It is the smallest coherent solution and adds no unapproved scope.
- Its maintenance and compatibility costs are proportionate to the benefit.

Do not invent product strategy. Conflicting or absent evidence produces a warning during triage.
At review, a confirmed conflict or unsupported product judgment blocks approval; a merely plausible
concern remains non-blocking and is reported as such.

## Review behavior

The existing `beeline-review` skill remains bound to the configured reviewer and exact green head.
Before judging implementation details, the reviewer must independently establish:

- the bug or unmet need still exists on the target branch;
- no current or recently merged work resolves or supersedes it;
- the change has concrete user benefit and fits repository direction;
- the diff implements the clarified request and no unapproved additions;
- tests exercise the user outcome and credible regression paths;
- for a bug, the proof names the recorded `Reproduction <id>`, re-runs that path, and shows the
  wrong result is gone — some other test existing is not that proof.

Confirmed duplicate or obsolete work, a confirmed product conflict, unapproved scope, missing
demonstration, a proof that does not name the triage reproduction, or insufficient regression
proof fails review. The author still owns merging after approval; the reviewer never merges.

## Placement

- `apps/body/src/beeline-skill.ts` owns the release-versioned `beeline-triage` skill (triage plus
  bugfix execution), the mandatory pre-corner instruction, and the expanded `beeline-review` rubric.
- `apps/body/src/agent-home.ts` provisions `beeline-triage` to every agent home and keeps
  `beeline-review` exclusive to configured reviewers.
- The existing Room prompt invokes triage before proposal or opening. The existing green-check
  transition invokes review against the exact pull-request head.

The server needs no receipt or new blocking operation. The behavior is procedural before work and
enforced through the existing reviewer approval gate after implementation.

## Acceptance tests

- Every implementer home contains `beeline-triage`; non-reviewers still lack `beeline-review`.
- Every Room prompt explicitly requires triage before `Proposed corner:` or `open_corner`.
- Ambiguity that can alter the outcome asks a question instead of silently choosing scope.
- Failed reproduction, plausible duplicate work, or desirability conflict warns without blocking.
- A successful triage reproduction emits `Reproduction <id>` for the implementer to reuse.
- The implementer reproduces before any change, stops if they cannot, and bounds the diff to that
  reproduction.
- The proof re-runs the same identifier and names it; the reviewer fails a proof that only shows
  some other test.
- The reviewer independently records warranted-work and desirability evidence.
- The reviewer still demonstrates the user outcome, runs affected tests, checks regressions, and
  binds approval to the exact head.

## Non-goals

- Automatically deciding roadmap priority or product taste.
- Treating keyword similarity as proof of duplication.
- Claiming that green CI alone proves an absence of regressions.
- Adding a server receipt, mobile approval queue, or separate pre-work reviewer.
- Allowing triage warnings to approve or reject work.
- Blocking the implementer on a failed triage reproduction; only the implementer's own unseen
  reproduction stops the fix.
