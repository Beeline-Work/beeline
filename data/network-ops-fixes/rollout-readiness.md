# Local proof versus rollout acceptance

Instructions 043/044 request separate pre-rollout proof and cohort-measured closure.
The [ledger](closure-ledger.md) now records both. Router activation stays off;
no production cohort or owner Workspace was used for this evidence.

## Concrete local failures

These five findings have executable local failures, not merely missing production
measurements. Their assertions remain strict.

| Finding | Remaining local work | Executable evidence |
| --- | --- | --- |
| F03 | Publish the committed membership's exact roster fact. | Group A closure suite: zero roster DTOs, expected one. |
| F04 | Restrict a changed Room to its own Needs-you cell. | Group A closure suite: one unaffected Room cell reread, expected zero. |
| F05 | Publish the saved-workflow start fact. | Group A closure suite: zero workflow-list facts, expected one. |
| F08 | Publish the committed connector's Workbench cell. | Group A closure suite: zero cells, expected one. |
| F09 | Deliver the portrait parent revision to both held consumers. | Group A closure suite: updates `[0,0]`, expected `[1,1]`. |

Group A reproduction and exact names: [proof report](group-a-proof-report.md),
`npm run prove:router-group-a-open-gates -w @beeline/server` with the isolated
PostgreSQL URL. Group C's final follow-up https://github.com/Beeline-Work/beeline/pull/3379 fixes
the earlier F13 statement/WAL/latency failures. On combined head `6eccacb48`,
the unchanged strict cost proof passes all five samples, including cold, with
statements 2/2 and WAL 0/0; all 18 legacy Room cases pass, with corner open 513 ms
against 650 ms. [Combined cost evidence](group-c-room-cost-integrated.json) and
[latency output](group-c-room-latency-integrated.txt) retain the observations.
Original failures remain alongside the fixed results. The separate final
READ COMMITTED authority fence is unchanged. Full production CPU/p95/native
paint and consumer/cohort acceptance are still separate obligations.

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
**F07, F10, F11, F13, F18, F21 and F23 are Proven pre-rollout for Group C
candidate paths**, per instruction 044. Native iOS captures are deferred to the
rollout gate list in its [report](group-c-followup-report.md); the provided Mac
needs adequate writable build capacity. Full consumer/platform/provider
acceptance remains explicit. A green selected path is not evidence that every existing adapter
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
  actual mobile recovery pass. The full local historical/current image smoke
  now also passes startup, migration, reads/writes, image swap/revert and graceful
  shutdown. The exact separate expansion image, deployed ledger-preserving
  floor and real Fly execution remain unproved. The actual canary shell now
  passes seven samples over 96.568 seconds with local adapters: an injected
  failure restores only the first image and fails the release. A full combined draft must
  not be described as a schema-only prerequisite release.
- The full native40/current Android/iOS/web/Tauri, old/new helper, mixed-server
  and every-family matrix remains incomplete. Historical native proofs are
  labeled; they are not store-binary or deployed-OTA claims.
- Equal-workload CPU/WAL, queue/parse/paint and physical SDK/native egress
  acceptance remain open beyond the local measurements already retained.

Thus the actionable split is **five reproduced local defects; twenty
findings with passing candidate-path evidence but incomplete whole-finding
acceptance; one existing closure**. The candidate implementations for Groups B and C are ready
for the remaining integration/cohort acceptance work. No additional whole
finding is marked Closed, and no production activation is authorized here.
