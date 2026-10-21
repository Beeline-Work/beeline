# Nightly replay verification, 2026-10-21

Not a defect report. Verification is incomplete; this is not evidence of a
working unattended schedule or a completed removal experiment.

Ran the actual nightly controller locally through its sealed Squire file
transport, starting at 03:37:46 UTC, using the production default
`deepseek/deepseek-v4.1-flash`. Model tools were simulated, never executed.
The baseline completed 59 of 70 cases: 40 passed and 19 failed under the
existing first-pass/2-of-3 sampling rule. The overall pass rate is unavailable.
The sampled median was 7,846 billed tokens per simulated turn; recorded usage
was 1,099,040 tokens and $0.093418. These partial results must not be compared
with a complete candidate suite.

Squire refused two replay payloads with an ownership error about browser
sessions. Its prescribed `operate_start` did not resolve the refusal. The
controller received an explicit transport error, exited 1, retained results
and history, and suppressed the removal proposal. No removal was tested.

The owner's personal GitHub connection also returned HTTP 403 when listing
repository Actions secrets (`secrets=read`). Rechecking the connection returned
ready without repairing that permission. This prevents verifying or configuring
`OPENROUTER_API_KEY` for unattended execution. Do not use another identity to
work around that denial.

Next: repair that connection's Actions-secret permission, configure the
repository secret through a sealed route, and dispatch the nightly workflow on
this branch. It uses direct HTTP transport rather than simulated browser session
references passing through Squire. Require a complete baseline, one complete
removal experiment, published digest line, and green CI before calling the
assignment done. The actual 04:00 scheduled invocation additionally requires
the workflow on the default branch.

Local validation passed: corner preparation/build, root typecheck, 70-case
structural validation, 13 case-rule tests, seven nightly-control tests,
workflow path validation, and actionlint.

The saved morning-card procedure now reads the nightly issue; saved triage and
workspace-walk procedures require a failing case before a prompt fix.
