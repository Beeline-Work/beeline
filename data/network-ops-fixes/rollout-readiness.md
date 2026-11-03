# Local proof versus rollout acceptance

Instruction043 requests separate pre-rollout proof and cohort-measured closure.
The [ledger](closure-ledger.md) now records both. Router activation stays off;
no production cohort or owner Workspace was used for this evidence.

## Concrete local failures

These six findings have executable local failures, not merely missing production
measurements. Their assertions remain strict.

| Finding | Remaining local work | Executable evidence |
| --- | --- | --- |
| F03 | Publish the committed membership's exact roster fact. | Group A closure suite: zero roster DTOs, expected one. |
| F04 | Restrict a changed Room to its own Needs-you cell. | Group A closure suite: one unaffected Room cell reread, expected zero. |
| F05 | Publish the saved-workflow start fact. | Group A closure suite: zero workflow-list facts, expected one. |
| F08 | Publish the committed connector's Workbench cell. | Group A closure suite: zero cells, expected one. |
| F09 | Deliver the portrait parent revision to both held consumers. | Group A closure suite: updates `[0,0]`, expected `[1,1]`. |
| F13 | Remove the initial full Room statement regression. | Strict Group C cost mode: eight candidate statements versus two legacy; raw CPU/WAL/bytes samples remain in `group-c-room-cost.json`. |

Group A reproduction and exact names: [proof report](group-a-proof-report.md),
`npm run prove:router-group-a-open-gates -w @beeline/server` with the isolated
PostgreSQL URL. Group C: `BEELINE_GROUP_C_COST_PROOF=1` on
`scripts/prove-router-group-c-room-payload.mjs`. The dedicated closure commands
are additional evidence, not replacements for normal regression/CI gates.

## Passing candidate paths

**F01, F12, F14, F15, F16, F17, F19 and F22 are Proven pre-rollout for the
specified Group B candidate P12 paths.** The final follow-up
https://github.com/Beeline-Work/beeline/pull/3377 at `43c54acd9` is integrated.
Its [report](group-b-proof-report.md) names each executable test and remaining
gate. The actual shared repair composition proves idle-day SQL/provider zero,
family-specific source admission and leader recovery; PostgreSQL microsecond
cuts preserve obligations that become due during a scan. The 61-mechanism and
18-repair inventory has no unclassified entry. No known failing local
candidate-path test remains in this group.

**F02, F06, F20, F24 and F25** have passing scoped Group A candidate workloads.
**F07, F10, F11, F18, F21 and F23** have passing scoped Group C candidate
workloads. Those reports still reserve full consumer/platform/provider
coverage. A green selected path is not evidence that every existing adapter
has moved. F26 retains its previously accepted completion-capture closure.

## What is still broader than rollout measurement

The evidence does **not** yet justify calling every remaining obligation
rollout-only. The final Group B report explicitly retains legacy full-draft,
freshness and polling adapters, complete source/provider ownership composition
and the installed-helper compatibility floor. Group C retains vendor/SDK and
native integration coverage. Some of these can be tested locally or on isolated
devices before a production cohort is selected; they do not require turning
on the production router first.

Cross-cutting T7 work remains:

- [Router-only removal](router-only-removal.md): the latest retained extraction
  still has 158 legacy router boundary keys and 72 phone keys. Five architecture
  baseline increases have individual dispositions in that document and the PR
  body; they are not scanner exemptions or closed findings.
- [Compatibility and rollback](t7-compatibility.md): historical source and
  actual mobile recovery pass, but the exact separate expansion image,
  ledger-preserving image floor, full startup and isolated image auto-revert
  sequence are not yet proved. A full combined draft must not be described as
  a schema-only prerequisite release.
- The full native40/current Android/iOS/web/Tauri, old/new helper, mixed-server
  and every-family matrix remains incomplete. Historical native proofs are
  labeled; they are not store-binary or deployed-OTA claims.
- Equal-workload CPU/WAL, queue/parse/paint and physical SDK/native egress
  acceptance remain open beyond the local measurements already retained.

Thus the actionable split is **six reproduced local defects; nineteen
findings with passing candidate-path evidence but incomplete whole-finding
acceptance; one existing closure**. Group B's local P12 implementation is ready
for the remaining integration/cohort acceptance work. No additional whole
finding is marked Closed, and no production activation is authorized here.
