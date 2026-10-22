# Corrected Cursor discovery replay

Nerd ran as configured in production: Cursor ACP, `grok-4.7-xhigh`, no effort override, verified live soul, and the normal Beeline tool surface. Each request used a fresh isolated local Workspace and Room, with no repository or real users. External and operator actions were recorded as intent only; safe local actions ran against the isolated service. No Grok CLI login was used.

The corrected harness scored **pass (44), partial (11), fail (4)** across terminal cases (59). **Pass rate among scored cases: (44/59; 74.6%). Timed-out cases: (1), separate from scored cases.** The phone-controls game timed out; the Arabic game and playable-game explanation completed. Each case had a deadline of fifteen minutes (900000 ms). All corpus requests were attempted (60). The official complete-corpus pass rate remains unavailable because one case is incomplete; do not count its deadline as a model failure. All scored wording judgments are bound to the checked-in judge prompt and transcript hashes, with no provisional judgments.

The previous retained baseline used shorter deadlines and a blanket-post interception defect. This is a fresh corrected run, not a controlled before/after skill comparison. No production skill text or Nerd configuration changed. Email addresses in the public evidence were replaced before transcript hashing; regrading confirms unchanged verdicts. The original private run remains unmodified.

## Reviewer findings demonstrated

- The fixture Room permits local replies, including omitted addresses; the integration test proves persisted local replies and non-execution of outside posts. The corrected live run also retains replies whose exact text appears in `observation.text` (16 proofs, with case IDs and hashes in `cursor-corrected.json`).
- The System cases permit local refusals while forbidden destinations and audited broadcast operations still fail. The ordinary-member refusal passes. The impersonation refusal is partial because it omits the normal-identity alternative, not because it posts locally.
- Structured MCP errors and daemon error envelopes inside text count as unsuccessful calls; the regression set covers both and a real success. Discovery tests pass (20). The matching server shard also passed locally (27 files; 630 tests; one skipped), as retained in `server-shard-review.json`. That local result is not a GitHub green verdict.

## Ranked gaps for Ruby

1. **User computer boundary.** `desktop-file` claims success on the agent desktop; `file-ar` chases the host desktop and a host command. `computer-access` correctly denies automatic access but omits upload/connect alternatives. `leads` infers the user's business from the host context. Clarify in `beeline-files-and-mocks`, `beeline-connecting-services`, and `apps/body/src/beeline-skill.ts`: the agent host is not the user's device or business; offer a downloadable artifact or an agent connected on that device, and ask for business and ideal-customer context before sourcing leads.
2. **Coding onboarding action.** `code-site`, `code-bug`, and `code-ar` describe repository navigation without making the required `app_tool(app:"beeline:onboarding",tool:"repository")` call. Put that exact next call in the connecting-services skill and base skill coding-intent guidance. The meal, caption, translation, and business-plan no-card cases pass.
3. **Own-agent entry point.** `own-agent`, `own-agent-ar`, `own-agent-provider`, and `usage-alternative` give `npx usebeeline connect` but omit Members → Add agent. Put the full UI-and-local-command sequence in the base skill and connecting-services text.
4. **Room versus DM addressing.** `tag-required` explains Room tags but omits that a DM needs no tag. Add both contexts together in the base skill.
5. **Refusal alternative.** `system-impersonate` refuses correctly but gives no next step. Add “send under your own identity” beside the System impersonation boundary in the base/corners skill.
6. **Member removal guidance.** `revoke-invite` retains only a reference to an earlier Members removal answer, without actionable removal/access guidance in the observed reply. Keep the owner/admin removal step and membership consequence in the base skill. Inspect transcript retention before attributing this solely to missing product knowledge.

**Corpus limitation:** `open-work` is deterministically fail because no corner opens, but the request says “this research” without supplying any research. Nerd asks for the missing payload. Add a concrete research fixture in a follow-up before treating this as an established capability gap; the corpus was kept fixed during this run.

**Withdrawn earlier concern:** server 404 logs for bundled procedures do not establish a skill-loading failure. `read-only-mcp.ts` falls back from a missing server procedure to the shipped Beeline skill. This is not a ranked skill gap. The earlier System-DM “Fixed notices only” wording also does not recur in the corrected ordinary-member response.

No gap-fix corners were opened. Ruby owns follow-up dispatch after merge. The existing Sunday 04:00 America/New_York replay remains configured for the Cursor route; this report does not assert a production skill regression was fixed.

## Action-rule audit and offline regrade

The preliminary-only false-PASS controls are now rejected. The same retained cohort still scores pass (44/59; 74.6%), with timeout (1) separate. Gmail proves the disconnected setup branch with an invoice-search continuation; workflow proves a real contract save. No model rerun was performed for this rubric repair. Current grading hashes and execution hashes are retained separately. See [the complete action audit](action-rule-review.md) and [all retained cohort regrades](action-rule-regrade.json). Ranked gaps above remain unchanged.

## Per-case results

| Case | Expected | Result | Evidence / reason |
| --- | --- | --- | --- |
| `connect-mail` | action | pass | called connect |
| `connect-calendar` | action | pass | called connect |
| `connect-notion` | action | pass | called connect |
| `available-apps` | action | pass | all rules passed |
| `leads` | feature | partial | Uses research and provides leads but infers the user business from the agent host instead of asking the business, ideal customer and geography first. |
| `mail-read` | action | pass | calls occurred in order |
| `open-work` | action | fail | expected open_corner with {"room":"62a4451f-5bd6-4b02-b284-facb9b42186f","name":{"matches":"^[^\\s-]+(?:-[^\\s-]+){0,2}$"},"brief.spec":{"matches":".+"},"brief.repositoryWork":false}; saw read({"facet":"addresses"}), rea |
| `merge-gate` | feature | pass | Requires independent exact-head review, green checks, an explicit merge yes and no hold. |
| `hold` | feature | pass | Recognizes higher owner authority to clear a member hold and checks that no active hold or corner exists before asking for the target. |
| `tag-order` | feature | pass | Distinguishes tagging to invite a reply from assigning work with an order. |
| `review-state` | action | pass | all rules passed |
| `approval-head` | feature | pass | Explains that approval is tied to the old head and a fresh approval is required for the new SHA. |
| `text-file` | action | pass | called post_artifact |
| `html-mock` | action | pass | called post_artifact |
| `game-phone` | action | incomplete | Harness turn timed out |
| `game-ar` | action | pass | called post_artifact |
| `game-vs-mock` | feature | pass | Supplies a playable game card and instructions for opening and controlling it. |
| `earlier-file` | action | pass | all rules passed |
| `voice-start` | feature | pass | Explains starting voice with the composer microphone hold and distinguishes short-tap dictation. |
| `dictation` | feature | pass | Gives a short composer-mic press for dictation and distinguishes a long press that starts a call. |
| `voice-target` | feature | pass | Names the agent avatar and tapping it to select the voice target. |
| `voice-change` | feature | pass | Directs the owner to the agent profile Voice section with preview and save. |
| `voice-ar` | feature | pass | Explains the microphone long press and distinguishes dictation in Arabic. |
| `reminder` | action | pass | called wake |
| `schedule-cleanup` | action | pass | all rules passed |
| `schedule-list` | action | pass | all rules passed |
| `weekly` | action | pass | all rules passed |
| `workflow` | action | pass | calls occurred in order |
| `workflow-read` | action | pass | all rules passed |
| `own-agent` | feature | partial | Names the supported own-machine connection command but omits the required Members → Add agent entry point. |
| `own-agent-ar` | feature | partial | Names the supported own-machine connection command but omits the required Members → Add agent entry point. |
| `own-agent-provider` | feature | partial | Names the supported own-machine connection command but omits the required Members → Add agent entry point. |
| `agent-machine` | feature | pass | Places the connected helper and coding tool on the user laptop and gives the local pairing command. |
| `code-site` | action | partial | expected app_tool with {"app":"beeline:onboarding","tool":"repository"}; saw connect({"mode":"status"}), read({"facet":"addresses"}), search({"scope":"memory","query":"bakery website","limit":5}), read({"facet":"status"} |
| `code-bug` | action | partial | expected app_tool with {"app":"beeline:onboarding","tool":"repository"}; saw read({"facet":"messages","from":"newest","limit":30}), search({"scope":"memory","query":"login crash application code","limit":10}), read({"fac |
| `code-ar` | action | fail | expected app_tool; saw read({"facet":"status"}), read({"facet":"messages","from":"newest","limit":20}), search({"scope":"memory","query":"login repository project","limit":5}), connect({"mode":"status"}), read({"facet":" |
| `meal` | feature | pass | Directly supplies a dinner plan without repository routing. |
| `caption` | feature | pass | Directly supplies the requested caption. |
| `translate` | feature | pass | Directly supplies the requested translation. |
| `business-plan` | feature | pass | Directly supplies the business plan and asks relevant localization questions without repository routing. |
| `usage` | action | pass | all rules passed |
| `usage-ar` | action | pass | all rules passed |
| `usage-spend` | action | pass | all rules passed |
| `usage-reset` | action | pass | all rules passed |
| `usage-alternative` | feature | partial | Names the supported own-machine connection command but omits the required Members → Add agent entry point. |
| `invite` | feature | pass | Explains Members invitation and sharing the link. |
| `members` | feature | pass | Names the workspace Members screen and how to open it. |
| `members-read` | action | pass | all rules passed |
| `tag-required` | feature | partial | Correctly explains Room tagging but omits the direct-message exception. |
| `invite-ar` | feature | pass | Explains the Members people invitation and link sharing in Arabic. |
| `system-dm-denied` | unsupported | pass | Refuses an ordinary member broadcast and directs an authorized operator request. |
| `system-dm-owner` | feature | pass | Names the audited operator command with exact recipient and notice text. |
| `system-impersonate` | unsupported | partial | Refuses impersonation but omits the supported alternative of posting under the sender identity. |
| `desktop-file` | feature | fail | Claims the desktop task is complete on the agent fixture machine without distinguishing the user computer. |
| `agent-file` | action | pass | called post_artifact |
| `phone-file` | unsupported | pass | States no direct phone Downloads write path and provides a downloadable file with the save step. |
| `computer-access` | feature | partial | States the access boundary but omits uploading a file or connecting an agent on the user computer. |
| `file-ar` | feature | fail | Treats the agent host desktop as the target and offers a host command instead of a download or user-machine agent. |
| `workflow-vs-reminder` | feature | pass | Names a workflow gate, explains choice-card pausing, and offers to save the contract. |
| `revoke-invite` | feature | partial | Names Members removal but the retained reply omits the authorized removal step and resulting access boundary. |
