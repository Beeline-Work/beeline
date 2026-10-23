# Action outcome audit

Reproduction R-DISCOVERY-PRELIMINARY-PASS: a completed trace containing only `connect(mode:status)` passed `mail-read`; one containing only `app_tool(app:beeline:workflow)` passed `workflow`. Neither proves its recorded expected outcome. These were scorer defects, not successful model actions.

The regression tests now run those same traces and reject PASS. A connected Gmail path requires status followed by successful Gmail search-schema discovery. A disconnected path requires status plus evidence of disconnection and an explicit Gmail setup request whose continuation names the invoice search. An unexecuted setup call proves intent only, as authorized for external account actions. Sending or drafting mail is forbidden. Workflow discovery requires a later successful `save` with a defined research/review contract; merely listing tools, calling an unrelated operation, an empty contract, or a failed save does not pass.

## Audit of every action family

| Cases | Required proof after audit |
| --- | --- |
| connect-mail / connect-calendar / connect-notion | Same ensure call contains the requested service, reason and continuation; separate unrelated calls cannot satisfy its arguments. |
| available-apps | Successful connector status read is the requested action. |
| mail-read | Connected search-schema or explicitly disconnected setup branch, in order; no send/draft. |
| open-work | Fixture parent Room, concise hyphenated name, nonempty brief.spec, repositoryWork false. |
| review-state | Successful checks read plus reviewer-wake answer in the observed reply. |
| text-file / html-mock / game-phone / game-ar / agent-file | Successful artifact operation with path, title and exact MIME; local service reads the file. A timed-out artifact turn is not delivered proof. This routing rubric does not certify game quality. |
| earlier-file | Exact attachment IDs plus reporting the known fixture row. Native shell reads are not in the MCP trace, so fixture-content reporting is the explicit narrow stand-in for content access; path discovery alone fails. |
| reminder | One same named create call, one run, New York zone, review-demo prompt and exact tomorrow-at-nine cron derived from the turn date. New observations retain startedAt; grading older runs uses retained manifest time. |
| schedule-cleanup | Ordered create/delete, delete matches the schedule ID returned by create, and persisted zero remaining schedules. |
| schedule-list | Successful own-schedule list is the requested action. |
| weekly | Same create call contains the requested exact weekly cron and time zone. |
| workflow | Schema discovery followed by a successful defined-contract save. |
| workflow-read | Exact pinned run read; choosing an outcome before that read fails. No outcome choice is required when the user has not supplied one. |
| code-site / code-bug / code-ar | Successful repository onboarding operation, not merely schema discovery. |
| usage / usage-ar / usage-spend / usage-reset | Successful usage read plus fixture plan, utilization and reset wording in the observed reply. English and Arabic reset wording are accepted. |
| members-read | Successful roster read plus fixture names and exact handles in the reply. |

## Retained regrade and gaps

`action-rule-regrade.json` records the offline regrade of every retained Cursor cohort, including smoke and retries. Original execution source hashes remain separate from current grading hashes. Historical cohort files remain unchanged. No model was rerun for this rubric repair.

The corrected full cohort remains pass (44), partial (11), fail (4), scored (59), timed out (1); scored pass rate (74.6%). Gmail actually requested setup with the invoice continuation. Workflow actually saved its contract. Therefore their retained PASS verdicts survive the stricter rules, despite the negative controls exposing the old false-PASS possibility. The current table is `cursor-corrected.md`; the ranked gaps remain unchanged. No Gmail/workflow skill gap is inferred from these two traces.

The older incomplete baseline remains pass (39) among scored (51). It has timed-out turns (10), including a required action proved before a deadline; scored and timed-out counts therefore overlap in that historical cohort. Its blanket-post defect still disqualifies it as a clean baseline. The current cohort has no scored/deadline overlap.

Demonstration uses the exact retained tool-operation path and synthetic preliminary-only traces, the narrowest service-independent reproduction for a scorer defect. Local service coverage continues proving file delivery, schedule cleanup, local replies and outside-send blocking. No production users, account connections or broadcasts were exercised.
