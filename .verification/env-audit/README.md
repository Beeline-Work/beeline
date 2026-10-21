# Environment sweep, PR #2678

Revision 2 applies the stale sweep before the compatibility rename. No Fly
secrets, machines, deployments or flags were changed. This is not a defect report.

The names-only [Fly snapshot](fly-names.json) was obtained on 2026-10-20 from
Machines API `/v1/apps/<app>/secrets` and machine configuration metadata, plus
all three checked-in Fly tomls. The older GraphQL `app.secrets` list omitted
Machines secrets and was not used as the final inventory. Native flyctl had no
local token; the owner's existing sealed Fly connection supplied the API calls.
No secret values were fetched. The setup token was not read.

The two running server images identify source commit
`6d908054c0dd404885ec2daa08115c9ef5ed10c2`; reader checks below use that commit,
not only this feature branch. Free-agent images are digest-pinned and suspended
or stopped; their source SHA was not exposed in machine metadata. Their four
configured names have current helper readers; no machine was woken for the audit.

The names-only squire audit ran successfully under approved command grant
`088c704e-b1ca-4bb0-a2b2-d091af2fd601` on 2026-10-21. Across 20 matching Beeline
processes it found no `BUZZY_` names and no in-scope `BEELINE_` knobs. The managed
helper carried only bootstrap/library/systemd names; see [the observation](squire-names.json)
and [the approved audit script](helper-env-names.py). The script is archived here
with the same bytes after execution; its old scratch path is no longer needed.
The brief supplies chad's names-only observation: no `BUZZY_` variables.
Live knobs absent from these observations remain **ask**, not removal candidates.
The owner decision goes through Niglet.

| Legacy name                            | Production reader                            | Known setter                                               | Verdict            | Evidence                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUZZY_AUTH_TENANTS_JSON`              | auth/environment; server/monolith-auth       | server Fly secret; proof fixtures                          | keep+rename        | Present in server secret-name list; required mounted auth tenant configuration.                                                                                                  |
| `BUZZY_AUTH_SETUP_TOKEN`               | standalone auth and mounted auth setup/drift | operator; absent from all three Fly name lists             | ask; retain+rename | Real operator-only endpoint gate. No known deployment setter; never read its value.                                                                                              |
| `BUZZY_AUTH_HOST`                      | auth/index listen address                    | operator; no Fly setter found                              | ask; retain+rename | `apps/auth/Dockerfile` explicitly starts auth/dist/index.js; Checks builds that image. No auth app in the three supplied Fly apps, but entry remains a runnable supported image. |
| `BUZZY_BODY_SANDBOX`                   | bwrap-sandbox detect/ensure                  | documented operator override                               | keep+rename        | Explicit escape hatch, including off; removal changes helper behavior.                                                                                                           |
| `BUZZY_BODY_SANDBOX_MASK`              | config → sandbox masks                       | documented operator override                               | keep+rename        | Existing configuration API and path-mask tests; cannot remove a real safety control.                                                                                             |
| `BUZZY_BODY_AGENT_ENV_PASSTHROUGH`     | config/buildAgentEnv                         | free-agent-vm model file                                   | keep+rename        | Free-agent scoped model token and turn limit depend on it. Model file exports both spellings.                                                                                    |
| `BUZZY_BODY_AGENT_ENV_INHERIT`         | AcpClient                                    | operator; no known deployed setter                         | ask; retain+rename | Overrides child process environment inheritance; not dead.                                                                                                                       |
| `BUZZY_BODY_MAX_SESSIONS`              | RoomRuntimeCoordinator                       | operator; no known deployed setter                         | ask; retain+rename | Changes workspace scheduler ceiling.                                                                                                                                             |
| `BUZZY_BODY_MAX_SESSIONS_FLOOR`        | RoomRuntimeCoordinator                       | operator; no known deployed setter                         | ask; retain+rename | Changes workspace scheduler floor.                                                                                                                                               |
| `BUZZY_BODY_MAX_SESSIONS_PER_ROOM`     | session-scheduler                            | operator; no known deployed setter                         | ask; retain+rename | Changes per-Room live session capacity.                                                                                                                                          |
| `BUZZY_BODY_MAX_WARM_SESSIONS`         | session-scheduler                            | operator; no known deployed setter                         | ask; retain+rename | Changes retained session capacity.                                                                                                                                               |
| `BUZZY_BODY_SESSION_IDLE_MS`           | session-scheduler                            | operator; no known deployed setter                         | ask; retain+rename | Changes session idle expiry.                                                                                                                                                     |
| `BUZZY_BODY_ROOM_HOME`                 | RoomRuntimeCoordinator                       | operator; no known deployed setter                         | ask; retain+rename | Selects Room harness-home isolation; warning text documents the remedy.                                                                                                          |
| `BUZZY_BODY_LLM_FILE`                  | none                                         | obsolete CLI comment only                                  | remove             | No reader or writer, including computed-name search. Removed the misleading example; existing runtime llmEnvFile remains authoritative.                                          |
| `BUZZY_BODY_AGENT_DELEGATION_MAX_HOPS` | config/loadBodyConfig                        | operator; no known deployed setter                         | ask; retain+rename | Sets agentDelegationMaxHops; still observable.                                                                                                                                   |
| `BUZZY_BODY_AUTO_APPROVE`              | config/loadBodyConfig                        | operator; no known deployed setter                         | ask; retain+rename | Changes permission auto-approval; not dead.                                                                                                                                      |
| `BUZZY_AGENT_PRIVATE_DIR`              | agent-home/harnessStateDirsFromEnv           | operator/forwarded child env; no current agent-home setter | ask; retain+rename | Special state-directory reader remains; do not infer absence from a missing setter.                                                                                              |
| `BUZZY_LLM_API_KEY`                    | config/buildAgentEnv                         | user LLM file or operator env                              | keep+rename        | User-file fallback is mandatory; retained OPENAI_COMPAT precedence.                                                                                                              |
| `BUZZY_LLM_BASE_URL`                   | config/buildAgentEnv                         | user LLM file or operator env                              | keep+rename        | User-file fallback is mandatory.                                                                                                                                                 |
| `BUZZY_LLM_MODEL`                      | config/buildAgentEnv                         | user LLM file or operator env                              | keep+rename        | User-file fallback is mandatory.                                                                                                                                                 |
| `BUZZY_RELAY_HOST`                     | none                                         | vitest.live.config only                                    | remove             | Removed unused assignment and the new alias added in revision 1. No semantic reader.                                                                                             |
| `BUZZY_RELAY_SCHEME`                   | none                                         | vitest.live.config only                                    | remove             | Same prefix/dynamic-access audit; no semantic reader.                                                                                                                            |
| `BUZZY_RELAY_URL`                      | none                                         | vitest.live.config only                                    | remove             | Same audit. Separate BUZZ_RELAY_URL is unchanged.                                                                                                                                |
| `BUZZY_PUSH_DATABASE_URL`              | legacy cleanup script only                   | operator; no invocation found                              | remove alias       | Cleanup execution history is not proven, so retain the script with DATABASE_URL only; do not run it in production.                                                               |

The seven `BUZZY_AUTH_OIDC_*`/`BUZZY_AUTH_ALLOW_INSECURE_OIDC` settings belong
to #2676 and remain untouched. Mobile `EXPO_PUBLIC_BUZZY_*`, `BUZZY_FLAGS`,
Composio/product flags and non-env identifiers remain outside this code sweep.
Generic prefix passthrough is not treated as evidence that an otherwise unread
relay setting controls behavior. Unknown legacy passthrough values are not scrubbed.

## Fly names with no active reader, and retained exceptions

These are name observations, not approval to remove a value. Before any staging,
Niglet must receive this list and the ask list above. Recheck the then-deployed
head and the #2676 handoff. Code must merge before stale secret unsets; renamed
copies require both merge and deployment. No unsets were performed in this PR.

| App                                    | Secret/env name                                                                                                                                                                   | Deployed reader evidence and handling                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| beeline-server                         | `AWS_REGION`                                                                                                                                                                      | No source reader; object-storage supplies its own region to aws4fetch. Stale secret candidate after merge.                                                                                                     |
| beeline-server                         | `FISH_AUDIO_API_KEY`                                                                                                                                                              | No reader in deployed apps/server, apps/auth or shared packages; current speech uses other providers. Stale secret candidate after merge.                                                                      |
| beeline-server                         | `BEELINE_GOOGLE_CLIENT_ID`, `BEELINE_GOOGLE_CLIENT_SECRET`, `BEELINE_GOOGLE_TOKEN_KEY`                                                                                            | No reader at the deployed server commit. Report as unused; coordinate with #2676 before staging any removal. No values compared.                                                                               |
| beeline-server                         | `BEELINE_GITHUB_APP_ID`, `BEELINE_GITHUB_APP_PRIVATE_KEY`, `BEELINE_GITHUB_APP_SLUG`, `BEELINE_GITHUB_CLIENT_ID`, `BEELINE_GITHUB_CLIENT_SECRET`, `BEELINE_GITHUB_WEBHOOK_SECRET` | Not read by deployed server bootstrap, which reads GITHUB_* directly. Standalone auth still reads these canonical keys. List as runtime-unused but retain pending Niglet's standalone/future-release decision. |
| beeline-server                         | `FLY_PG_URL`                                                                                                                                                                      | No live server reader. The copy-postgres-data.mjs migration tool and managed-Postgres runbook still read it; retain as an operational escape hatch pending a decision, not proven stale everywhere.            |
| beeline-server                         | six `BEELINE_AUTH_OIDC_*` names                                                                                                                                                   | Unread by deployed commit; newly staged copies for #2676. Preserve them and all six pre-migration BUZZY_AUTH_OIDC_* secrets until that PR's cleanup.                                                           |
| beeline-server / beeline-voice-livekit | `FLY_PROCESS_GROUP`, `PRIMARY_REGION`                                                                                                                                             | No application source reader; Fly platform metadata. Reported for completeness, not stale application secrets; do not unset or mutate machine configuration.                                                   |
| beeline-server                         | `NODE_OPTIONS`                                                                                                                                                                    | Read by Node itself; keep even without a literal application read.                                                                                                                                             |
| beeline-free-agents                    | no unused names found                                                                                                                                                             | No app secrets; machine names BEELINE_FREE_AGENT_BOOTSTRAP, BEELINE_FREE_AGENT_ID, BEELINE_FREE_AGENT_MAX_TURN_SECONDS, BEELINE_SERVER_URL have helper/bootstrap readers. Source SHA limitation noted above.   |
| beeline-voice-livekit                  | no unused application names found                                                                                                                                                 | start.sh reads LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_NODE_IP. LIVEKIT_PORT is read by the upstream binary's generated CLI flags.                                                                     |

LiveKit's dynamic reader is confirmed in the pinned version's
[configuration flag generator](https://github.com/livekit/livekit/blob/v1.9.12/pkg/config/config.go#L579)
and [server flag registration](https://github.com/livekit/livekit/blob/v1.9.12/cmd/server/main.go#L125).
Do not classify LIVEKIT_PORT as stale from our shell script's hardcoded config.

All other observed server secret names have deployed readers in the server/auth
runtime (APNs, object storage, wallet, free agents, GitHub, push, speech, Sentry,
System senders and other configured integrations). All checked-in server toml env
names have index/bootstrap readers. The JSON snapshot lists every name inspected,
including the retained names, without values or credential digests.

## Demonstration and validation

`node scripts/prove-env-aliases.mjs` after building exercises an operator LLM
file through the built helper into a real Node child, with both prefixes and
new-name precedence. The mounted auth HTTP tests prove the new tenant spelling
through auth start/callback/session exchange. Existing migration tests verify
new-wins, old-still-works and paired exports for the 19 retained settings.
The cleanup CLI test supplies each obsolete alias without DATABASE_URL and proves
that it refuses before opening a database. Production cleanup was not executed.

Full typecheck and affected helper config/free-agent suites are rerun for this
revision; earlier broad helper/auth results remain recorded in the PR history.
The squire host audit is complete. Optional owner decisions about retained ask
knobs remain with Niglet; none was removed.

## CI repair proof

CI-ENV-01: the free-allowance integration case seeded the database's current UTC
day but mocked Date.now to a fixed October 20. On October 21, running that exact
test reproduced used=0 instead of 123000/paused. The test now anchors its clock
to the current UTC day; all six agent-usage integration tests pass. Current main
contains the same fix, so the merge retains that upstream fixture unchanged. This changes only the fixture, retaining the timestamp/privacy assertions.

CI-ENV-02: the dead-code checker identified the manually invoked compatibility
proof as an unregistered entry. Its explicit Knip entry makes the proof reachable
without increasing the baseline or excluding production code.
