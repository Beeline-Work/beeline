---
name: beeline-triage
description: Clarify and assess a user request before opening a Beeline corner, then bind a bugfix to its recorded reproduction. Use before open_corner and while implementing a bug in a corner.
---

<!-- beeline-release: source -->

# Beeline request triage

Run these checks before opening a corner.

## 1. Is it clear?

- Rewrite the request as a concrete outcome and acceptance criteria.
- State material exclusions needed to prevent unrequested work.
- Keep the corner objective complete and within 24 words.
- If an ambiguity could materially change the outcome, ask one focused question before opening the corner.

## 2. Is work warranted?

- For a bug, try to reproduce the exact user-visible behavior and record the evidence.
- For another request, identify the unmet user need and the current behavior that does not meet it.
- Search current code, history, issues, and open or recently merged pull requests for released or unreleased work that resolves or supersedes the request.
- Treat similar titles as candidates. Confirm behavior and scope before calling work duplicate.
- If the need cannot be established, reproduction fails, or other work may obviate it, warn; do not block.

## 3. Is it desirable?

- Compare the request with repository-owned goals, invariants, architecture, and established product behavior.
- Look for concrete user benefit, the smallest coherent solution, and ongoing maintenance cost.
- Do not invent product strategy. If the evidence is absent or conflicting, warn; do not block.

## Output

When dispatching work, pass the complete brief to open_corner under existing authorization. Ask a focused question first only for a material unresolved choice. Add applicable warnings to the brief:

`Triage warning — warranted: <evidence-backed reason>`
`Triage warning — desirable: <evidence-backed reason>`

When a bug reproduction succeeds, also emit:

`Reproduction <id>: <user path> → <observable wrong result>`

Do not emit a warning merely because evidence is incomplete when the repository offers no practical way to obtain it. Never describe a warning as approval or rejection. Warnings inform the user and implementer; they do not block work.

## Bugfix execution

Once a corner is open for a reported bug, follow these steps in order. They are instruction, not a server gate. They do not condition the fix on reproduction. Warranted-work and desirability warnings still do not block.

### 1. Attempt to reproduce

- Attempt to reproduce the bug as triage isolated it, using every tool the host offers: emulator, Playwright, browser, test runner.
- Record what was tried and what was observed.
- If a reproduction is obtained, record the exact user path and the observable wrong result under `Reproduction <id>`. Reuse the identifier triage emitted when it recorded one.
- If reproduction fails, warn and continue exactly as triage already does. Never stop. Never condition the fix on reproduction.

### 2. Narrow fix

- Narrow the fix to the reported behavior.
- When a reproduction exists, change only what removes that recorded reproduction.
- Nearby improvements stay out of scope.

### 3. Proof matching triage

- When a reproduction exists, re-run it, cite the same identifier, and show it now passing, plus the regression that would fail if the bug returned.
- When none was obtained, state that plainly and show the regression instead.
- Name the identifier in the pull request when one exists so the reviewer can check that proof, not merely that some test exists.
