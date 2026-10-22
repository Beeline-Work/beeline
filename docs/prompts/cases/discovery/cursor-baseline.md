# Cursor discovery results — incomplete baseline

Nerd ran through the production Cursor ACP bridge with model `grok-4.7-xhigh`, no separate effort override, and its verified live soul. No Grok CLI login or model API substitute was used. Each case used an isolated local Workspace and fresh Room, with no repository or real users. Completed records were retained across command interruptions; original results and source/profile hashes are in `cursor-baseline.json`.

The complete corpus was attempted (60 cases). First retained attempts scored pass (39), partial (10), fail (2), incomplete (9). Passes among scored cases were (39/51; 76.5%). **The official overall pass rate is unavailable.** All wording judgments for scored rows are trace-bound and non-provisional. The smoke passed usage and real schedule creation/deletion (2/2) after correcting an optional-delete-argument error in the rubric.

These counts are preliminary because a harness defect contaminates behavior: the recorded `discovery-mcp.mjs` version intercepted every `post`, including replies to the current isolated Room. Nerd retries these recorded-but-unsent replies and spends time diagnosing the synthetic failure. The recorded `system-dm-denied` rule also forbade every `post`; its scored failure includes a harmless refusal addressed back to its own fixture Room. That row is a harness false failure, not evidence that Nerd broadcast a System DM. Its separate prose still incorrectly describes System DMs as Fixed notices only. No corrected aggregate rate is asserted.

Longer-deadline retries completed the voice-start and voice-change cases with correct guidance. Their transcripts, source hashes and wording judgments are retained in [cursor-retries.json](cursor-retries.json) and do not replace the first-attempt table. Other longer retries were interrupted by commands. Preserve the incomplete rows until the harness can produce terminal turns; do not count them as model failures.

## Ranked follow-ups for Ruby

- **User computer versus agent host.** `file-ar` treats the agent host desktop as the user desktop and says a corner will finish it. `desktop-file` supplies a download but still chases the host path. `computer-access` offers a host grant instead of uploading a file or connecting the user computer. Fix `beeline-files-and-mocks`, `beeline-connecting-services`, and the corresponding `apps/body/src/beeline-skill.ts` text: a host grant reaches only this agent’s computer; offer a download/upload or an agent connected on the user’s device. Regression cases: these same three requests.
- **Coding repository setup.** `code-site`, `code-bug`, and `code-ar` identify missing code or repository context but miss `app_tool(app:"beeline:onboarding",tool:"repository")`. The site case opens repository work first and tries personal GitHub setup. Fix the repository guidance in `beeline-connecting-services` and its base skill pointer to invoke the repository card for coding intent before opening repository work. Keep the meal/caption/translation/business requests as no-card regressions.
- **Bring-your-own agent entry point.** `own-agent`, `own-agent-ar`, `own-agent-provider`, and `usage-alternative` give a local connect command but omit Members → Add agent. Put that complete navigation-plus-command sequence in the base Beeline skill, with Arabic-equivalent wording accepted. Recheck all four cases.
- **System DM capability versus Fixed notices.** `system-dm-denied` refuses the ordinary member appropriately, but claims System DMs only exist as per-PR Fixed notices. Clarify the owner-only audited operator path separately from `notify_feedback_fixed` in the corners skill/tool descriptions. Re-run owner/member/impersonation cases after correcting the local-post harness false failure. The owner case remains incomplete, so its capability accuracy is not yet established.
- **DM tag exception.** `tag-required` says tagging is required in this Room but omits the DM exception. Add a direct pair of sentences: DMs need no tag; tag an agent in a Room to invite a reply.
- **Bundled skills versus saved procedures.** Multiple traces call `read(facet:"procedure",slug:"beeline-...")` for bundled skills and receive not-found responses. Explain how Cursor reads local SKILL.md files; reserve procedure reads for saved workspace procedures. This is observed friction, not a measured causal attribution for every timeout.

No production skill fixes or agent-configuration changes were made. Ruby owns opening the follow-up fix corners. Each fix must pass the named case without losing a previously passing case.

## Harness corrections and the outstanding rerun

The subsequent review correction allows posts only to the case’s own fixture Room, scopes broadcast prohibitions to outside posts and System-send operations, and rejects textual daemon-error envelopes as well as `isError`. The [regression proof](harness-review.md) exercises the real MCP/service posting path. This historical table and its JSON are unchanged; grading-source hashes distinguish later regrades. Repeat affected cases and run the complete corpus for regression comparison before publishing an official rate. Retain a longer deadline for game construction separately from the initial deadline cohort.

At evidence capture, work stopped after four pushes without a reviewer PASS and was reported blocked with cause **unreliable test tool**. A later explicit CI-repair command integrated main’s existing dashboard fixture correction and pushed head `028ecd5d9`; the full dashboard test file passed locally (20 tests). A subsequent delivery command authorized committing the pending fixture safeguards and this preliminary evidence. No self-review or merge approval is claimed. The PR description already contains the required Reproduced and Demonstrated sections and remains unchanged. Harness controls passed (14 tests), root typecheck passed, and corner preparation passed in the measured session; live CI and independent review remain separate requirements.

The existing Jellybean schedule is already Sunday at 04:00 America/New_York, names Cursor and the exact model, retains the original replay budget, and gates weekly discovery on the harness landing. No duplicate schedule was created.

## First retained attempt table

| Case | Expected | Status | Evidence/reason |
| --- | --- | --- | --- |
| `connect-mail` | action | pass | all rules passed |
| `connect-calendar` | action | pass | all rules passed |
| `connect-notion` | action | pass | all rules passed |
| `available-apps` | action | pass | all rules passed |
| `leads` | feature | pass | Asks what the business sells, the ideal buyer and geography, and promises sourced fitting accounts without a repository card. |
| `mail-read` | action | pass | all rules passed; required action proved before harness deadline; turn incomplete |
| `open-work` | action | incomplete | Harness turn timed out |
| `merge-gate` | feature | pass | Requires a different reviewer, exact-head approval, green checks, merge authorization and no hold. |
| `hold` | feature | pass | Respects holds that bind the requester and identifies higher owner authority as the route for clearing a member hold. |
| `tag-order` | feature | pass | Correctly distinguishes invitation to reply from assignment and identifies order as the assigning action. |
| `review-state` | action | pass | all rules passed |
| `approval-head` | feature | pass | Explains exact-head approval and the need for a fresh PASS after a push. |
| `text-file` | action | pass | all rules passed |
| `html-mock` | action | pass | all rules passed |
| `game-phone` | action | incomplete | Harness turn timed out |
| `game-ar` | action | incomplete | Harness turn timed out |
| `game-vs-mock` | feature | incomplete | Harness turn timed out |
| `earlier-file` | action | pass | all rules passed |
| `voice-start` | feature | incomplete | Harness turn timed out |
| `dictation` | feature | pass | Correctly gives a short microphone tap for dictation and distinguishes a long press that starts a call. |
| `voice-target` | feature | pass | Names the square avatar and explains tapping it to select the agent. |
| `voice-change` | feature | incomplete | Harness turn timed out |
| `voice-ar` | feature | pass | Correctly explains a long microphone press in Arabic; the deterministic screen misses the diacritic spelling. |
| `reminder` | action | pass | all rules passed |
| `schedule-cleanup` | action | pass | all rules passed |
| `schedule-list` | action | pass | all rules passed |
| `weekly` | action | pass | all rules passed |
| `workflow` | action | pass | all rules passed |
| `workflow-read` | action | pass | all rules passed |
| `own-agent` | feature | partial | Names the supported local command but omits the required Members → Add agent entry point. |
| `own-agent-ar` | feature | partial | Gives the supported local connect command but omits Members → Add agent and sends the user through an unspecified mobile pairing flow. |
| `own-agent-provider` | feature | partial | Explains supported own agents and local pairing but omits Members → Add agent as the entry point. |
| `agent-machine` | feature | pass | Explains that the connected helper and tool run on the laptop and become unavailable when the laptop or helper stops. |
| `code-site` | action | partial | expected app_tool with {"app":"beeline:onboarding","tool":"repository"}; saw connect({"mode":"status"}), read({"facet":"addresses"}), search({"scope":"memo |
| `code-bug` | action | partial | expected app_tool; saw read({"facet":"messages","from":"oldest","limit":50}), read({"facet":"addresses"}), search({"scope":"memory","query":"login crash ap |
| `code-ar` | action | partial | expected app_tool; saw read({"facet":"status"}), read({"facet":"messages","limit":30,"from":"newest"}), read({"facet":"addresses"}), search({"scope":"memor |
| `meal` | feature | pass | Provides a vegetarian dinner plan for six directly without a repository card. |
| `caption` | feature | pass | Supplies a rainy-morning Instagram caption directly without a repository card. |
| `translate` | feature | pass | Answers the requested translation directly without a repository card. |
| `business-plan` | feature | incomplete | Harness turn timed out |
| `usage` | action | pass | all rules passed |
| `usage-ar` | action | pass | all rules passed |
| `usage-spend` | action | pass | all rules passed |
| `usage-reset` | action | pass | all rules passed |
| `usage-alternative` | feature | partial | Offers reset and an own-agent alternative, but omits Members → Add agent as the next step. |
| `invite` | feature | pass | Gives Members/Add people and sharing a join link as the invitation route. |
| `members` | feature | pass | Names Members and gives a concrete way to open the workspace roster. |
| `members-read` | action | pass | all rules passed |
| `tag-required` | feature | partial | Explains the Room tag requirement but omits that DMs need no tag. |
| `invite-ar` | feature | pass | Gives Members, Add people and sharing the invite link in Arabic. |
| `system-dm-denied` | unsupported | fail | Forbidden behavior: {"call":"post"} |
| `system-dm-owner` | feature | incomplete | Harness turn timed out |
| `system-impersonate` | unsupported | pass | Refuses System impersonation and gives posting as the user as the supported alternative. |
| `desktop-file` | feature | partial | Supplies a downloadable file but treats the agent host desktop as the user target and never explains the user/agent computer boundary. |
| `agent-file` | action | pass | all rules passed |
| `phone-file` | unsupported | incomplete | Harness turn timed out |
| `computer-access` | feature | partial | Denies automatic access, but offers a host grant without explaining that it cannot reach the user computer and omits uploading or connecting the user agent |
| `file-ar` | feature | fail | Treats the agent host desktop as the user desktop and says moving to a corner will complete it, without a download or user-machine alternative. |
| `workflow-vs-reminder` | feature | pass | Explains a workflow approval gate, supported answers and the next step of specifying outcomes to save the contract. |
| `revoke-invite` | feature | pass | Names the authorized Members removal path and explains loss of Room and Workspace access. |
