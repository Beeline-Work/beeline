# When Beeline asks a person to act

Agents own execution and recovery. Beeline pulls a person into that work only
when an agent explicitly asks for a decision or approval, or when the intended
agent cannot be reached or started after normal delivery retries.

CI failures, a fix turn ending without a push, stalled checks and an unconfirmed
merge return to the corner's implementer with the facts. CI has no human
escalation cap. Missing reviewer configuration also returns to the implementer,
which can arrange review or explicitly ask a person for a merge decision.

The server's attention producers and delivery paths were audited against this
rule:

| Path | Behavior |
| --- | --- |
| `agent-command.ts`: `noteBlockedCornerChecks` | Requeues completed fixes on the current red head; waits for fresh pending CI; sends stale runs to the implementer |
| `github-operations.ts`: `refreshCheckRollup` | Wakes on the first failure and once when the run finishes; tracks new attempts on the same head, including new Actions job URLs when a start webhook was missed |
| `corner-lifecycle.ts`: `checksReported`, `noteNoReviewer`, merge recovery | No CI loop cap or automatic merge approval ask; wakes the implementer; historical `ask_human` cards can resume |
| `agent-command.ts`: `noteCornerAgentUnreachable` | Names the requester or current Workspace managers only after queue refusal or an unclaimed wake outlasts delivery retries; explicit card recipients drive notification and waiting state |
| `corner-lifecycle.ts`: reviewer dispatch and fallback exhaustion | Preserves notices for unavailable reviewers and failed reviewer dispatch |
| `connection-presence.ts`, `turn-silence-notice.ts`, `phone-service.ts`: silence and unanswered mentions | Preserves agent reach/start failures and normal hiccup retries |
| `workflow-runs.ts`: gates and role exhaustion | Preserves configured decision gates and unavailable role notices; gate-default owner notices report the result of an existing decision request |
| `daemon-service.ts`, `room-choice.ts`, `needs-you.ts`: agent questions and approvals | Preserves explicit agent questions and grant, permission, connector, sign-in and Squire approval cards |
| `background.ts`, `corner-owed.ts`: delivery and attention | Keeps ordinary result receipts and Workspace facts; recovery work creates no person-addressed CI card, and command roots silence unaddressed automatic CI/merge replies; failed wakes carry their own recipients and resolve on claim; release clears historical automatic attention |

Regression coverage lives in `apps/server/src/corner-lifecycle.test.ts` and
`apps/server/src/github-operations.test.ts`. The mobile update test uses explicit
module settlement and React commits, with a delayed updater response covering
the scheduling race (`apps/mobile/sources/hooks/useUpdates.test.ts`).
