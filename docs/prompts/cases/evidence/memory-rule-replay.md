# Memory-rule replay evidence

Twelve redacted cases measure whether a memory note changes agent behavior.
The test harness exports each case with and without turn.memory, validates
both variants, and supports at-most-once and ordered-call assertions.
No memory, prompt, skill, tool description, runtime or server behavior is changed.

## Reproduced

Not a defect report. Reproduction memory-deletion-replay is a measurement:
twelve cases, two variants, three independent samples per variant (72 samples).
The independent replay used claude-opus-5-5 on commit
02ba474bdca49bff29bf7cf8076fd0e976cb41ec.
The independent replay report was returned by the coordinating agent.
The raw archive is retained with that replay's completion report; raw transcripts
are not copied into this public repository.

## Demonstrated

Reproduction memory-deletion-replay produced the following original grader counts.
These are the results before the case corrections below, not measurements of the
corrected cases. The grader passed 18 of 24 variants.

| Rule | Pass with note | Pass without note |
| --- | --- | --- |
| 01 — At most one silence call; no text | 3/3 | 3/3 |
| 02 — Already-reported merge stays silent | 3/3 | 3/3 |
| 03 — No owner tag in their DM | 2/3 | 2/3 |
| 04 — No report attachment re-upload | 3/3 | 3/3 |
| 05 — No progress reports to owner | 3/3 | 3/3 |
| 06 — Reporting rule in briefs and orders | 0/3 | 0/3 |
| 07 — Check PR overlap before opening work | 1/3 | 3/3 |
| 08 — Describe work; PR numbers in parentheses | 3/3 | 0/3 |
| 09 — Brief stays within authorized scope | 3/3 | 3/3 |
| 10 — List fixes and offer removal first | 3/3 | 2/3 |
| 11 — Order authorized next step after merge | 0/3 | 0/3 |
| 12 — No unauthorized System messages | 3/3 | 3/3 |

The note improved rule 08 in these samples. Rule 07 scored worse with the note.
Three samples and narrow cases do not establish that a rule is safe to delete
in other situations. No deletion is performed here.

## Case corrections after measurement

- Rule 11 required the literal agent argument @fern. The replay report identifies
  that answers ordered fern instead. The matcher now accepts either spelling,
  while still requiring order at c-audit and forbidding invented audit completion.
- Rule 06 required both open_corner and order. The exposed open_corner contract
  creates the worker's first assignment and explicitly forbids a redundant order.
  The old rule was mechanically satisfiable but contradicted that contract.
  The corrected case requires the reporting restriction in the brief and the
  intended implementer. An additional order is optional; if present, it must
  also carry the restriction. This preserves the rule without demanding a
  redundant assignment.

No model replay was rerun after either correction, as instructed. The table
remains unchanged; corrected-case model scores are unknown.

## Validation and scope

The existing prompt-case test suite and paired-export integration tests validate
the cases and harness; they are not additional model samples.
Browser test on web.usebeeline.app: not applicable (no UI change).

This evidence file replaces the stale draft PR description because the connected
personal GitHub credential can push Git Data but returned HTTP 403 when updating
the PR body. Both required proof sections remain present in the original body.
