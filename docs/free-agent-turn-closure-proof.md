# Free-agent turn closure

## Reproduction free-turn-closure

Read-only production diagnosis on 2026-10-22 used `agent_turns`,
`agent_commands`, `messages`, `free_agent_events`, `free_agent_usage`, and the
retained Fly Machines events for the reported October 19 game conversation.
No production records or Machines were changed.

The final turn **ended normally with a promise as its final reply**. The
command and turn both completed at 21:56:30.173570 UTC, with no cancellation or
failure reason. Its claimed execution began at 21:53:58.009011 UTC. Successful
model usage continued through 21:56:30.105761 UTC. The helper requested sleep at
21:57:29.288693 UTC; Fly recorded a requested, clean exit at
21:57:30.411 UTC (exit code 0, `oom_killed=false`). This was neither the
15-minute deadline nor a runtime crash.

An allowance refusal at 21:51:25.653365 UTC belonged to the **previous** turn,
whose final reply included the allowance explanation. A later pickup stall
produced a retry line at 21:53:57.913702 UTC before the final execution above.
The owner's October 19 settled usage row contains 902,896 tokens. An admission
refusal can occur below the cap because the next request must reserve room;
that row alone does not prove why a particular turn ended.

## Demonstrated service path

Injecting failures into the person's real agent would disrupt their work.
The approved browser waiver applies. The closest stand-in uses the production
`DaemonService.execute('postAgentTurnReceipt', …)` interface, the expired-lease
reconciler, and `FreeAgentService.sweep()` with an isolated migrated database
and a recording Fly Machines substitute. Assertions inspect committed
conversation messages, not only a classifier's return value.

| Terminal path | Conversation result |
| --- | --- |
| Allowance refusal without a final reply | One System line explaining the UTC reset and how to continue |
| Helper time limit without a final reply | One System line explaining the 15-minute limit and how to continue |
| Server hard-cap cleanup without a receipt | Same time-limit line, committed with cancellation |
| Runtime crash or dead command lease | One System line explaining the stop and how to continue |
| Successful final reply | No closing line |
| Empty successful receipt | One honest ended-without-a-reply line |

Replaying the detector or sweep does not add another line. An existing
turn-failed line is updated in place. Allowance refusal facts carry the
request and conversation identifiers; another request's refusal cannot supply
the ending's cause. Deliberate no-reply, passive computer observations,
update retries, stale generations, and private commander reports retain their
existing authority paths.

Run the service regressions with:

```sh
npx vitest run apps/server/src/turn-silence-notice.test.ts apps/server/src/free-agents.test.ts apps/server/src/free-agent-model-proxy.test.ts apps/server/src/free-agent-warning.test.ts --maxWorkers=2 --minWorkers=1
```

The final-reply promise is addressed by `FREE_AGENT_TURN_GUIDE`, delivered to
new and existing free agents in configuration reads. The saved
`free-agent-long-work-closure` prompt case checks usage before a long task and
an honest ending when the allowance is small. Prompt-case validation checks
the case contract; it is not a claim that a model replay or live release has
already passed. The existing allowance and time-limit settings are unchanged.
