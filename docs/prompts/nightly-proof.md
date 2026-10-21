# Nightly replay verification, 2026-10-21

Not a defect report. The immediate run used the scheduled controller on squire,
with the production default `deepseek/deepseek-v4.1-flash` through vault
`use_credential`. No key left the vault and no simulated tool was executed.
The timer is scheduled; this verification was invoked manually, not by a 04:00 tick.

| Measure | Baseline | Removed paragraph |
| --- | ---: | ---: |
| Eligible cases completed | 67 | 67 |
| Passed | 43 (64.18%) | 41 (61.19%) |
| Median billed tokens per turn | 7,740 | 7,749 |
| Browser-session cases excluded | 3 | 3 |

Experiment `identity:b10ed6cb1f17` removed this paragraph in a temporary source
copy: “Keep facts exact regardless of voice. Use plain language in commits, pull
requests, and code comments.” Ten previously passing cases regressed. The
experiment was **rejected**: lower pass rate and higher tokens. Production
prompt text remains unchanged. The same first-pass/2-of-3 rule applied to both
arms. Total usage for both arms: **2,403,475 tokens, $0.211119**; within the
six-million-token/$3 cap. The measured assembler source is unchanged from commit
`8e4b9a144`; the controller includes this PR's vault/cohort updates. The final
skipped-section protection policy selects the same paragraph, verified after the run.

The three `skipped:squire` cases are `squire-busy-request-capability`,
`squire-drive-starts-drive`, and `squire-long-history-host-recovery`. They are
outside both denominators and protect their prompt section from future removal.
The shipped-status text case remains eligible despite listing a browser tool.

[History](nightly-history.jsonl) records per-case medians/results for both arms,
usage/cost, skipped reasons and the rejected experiment. Full synthetic
transcripts and provider usage are retained in the result artifact posted in the
corner. [Night zero](night-zero.json) preserves the earlier 40 passed of 59
completed, all 11 incomplete IDs and their individual reasons; it is not an
experiment arm for the revised cohort.

Beeline schedule `e4ef62d4-6277-46cf-aa2c-fdc00912fdd7` is installed for Jellybean
on squire in this corner: `0 4 * * *`, `America/New_York`. Its instructions and the
saved `prompt-nightly-replay` procedure use the sealed exchange with fresh run
directories and cumulative history. GitHub Actions scheduling and the secret-
dependent transport were removed. The 403 secret permission is no longer needed.
**Archive/landing cancels this corner's schedule: the commander must migrate it
and preserve history in a surviving Room before landing.**

Results are indexed on [Prompt nightly results](https://github.com/Beeline-Work/beeline/issues/2710).
The saved morning-card procedure reads its newest result comment and linked
artifacts. Saved triage/workspace-walk procedures require failing cases before
prompt fixes.

Local build, root typecheck, 70-case structural validation, 13 case-rule tests,
eight nightly-control tests, workflow path validation and actionlint pass.
A separate evidence check verified identical eligible arms, three exclusions,
final-policy block selection, exact token/cost accounting and cap compliance.
CI and independent review remain part of the normal PR gate.
