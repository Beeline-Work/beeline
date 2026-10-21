# Beeline environment names

Use the `BEELINE_` names below. Matching `BUZZY_` names still work without
changing existing deployments or helper configuration. If both are present,
`BEELINE_` wins, including an empty string; validation and defaults remain the
same. Explicit `OPENAI_COMPAT_*` settings still take precedence over LLM aliases.
LLM file values still replace ambient values of the same spelling.

| Area              | Names after `BEELINE_`                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Auth              | `AUTH_TENANTS_JSON`, `AUTH_SETUP_TOKEN`, `AUTH_HOST`                                                                           |
| Helper sandbox    | `BODY_SANDBOX`, `BODY_SANDBOX_MASK`                                                                                            |
| Agent environment | `BODY_AGENT_ENV_PASSTHROUGH`, `BODY_AGENT_ENV_INHERIT`                                                                         |
| Session capacity  | `BODY_MAX_SESSIONS`, `BODY_MAX_SESSIONS_FLOOR`, `BODY_MAX_SESSIONS_PER_ROOM`, `BODY_MAX_WARM_SESSIONS`, `BODY_SESSION_IDLE_MS` |
| Helper policy     | `BODY_ROOM_HOME`, `BODY_AGENT_DELEGATION_MAX_HOPS`, `BODY_AUTO_APPROVE`                                                        |
| Private state     | `AGENT_PRIVATE_DIR`                                                                                                            |
| LLM file          | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`                                                                                     |

The helper's child environment and free-agent model file export both spellings with the selected value so older programs
keep working. Auth proof scripts use the Beeline tenant name; launchers
also export the old spelling. `AGENT_PRIVATE_DIR` is currently only inspected
for sandbox state directories and forwarded if supplied; agent-home preparation
does not create or set this variable.

The unused `BUZZY_RELAY_HOST`, `BUZZY_RELAY_SCHEME`, and `BUZZY_RELAY_URL`
assignments were removed. The legacy cleanup script now accepts only `DATABASE_URL`;
its unused `BUZZY_PUSH_DATABASE_URL` alias was removed rather than renamed.

`BUZZY_BODY_LLM_FILE` occurred in a historical CLI example but had no reader.
Neither spelling selects a file: retain the existing runtime record's
`llmEnvFile` setting. Adding a reader would change behavior and is excluded.
Google OIDC variables belong to the separate Google sign-in work. Mobile's
`EXPO_PUBLIC_BUZZY_*` names and `BUZZY_FLAGS` are outside this migration.
Historical audit snapshots retain the names they recorded.

Production can continue using only the old names. After this code merges and
is deployed, non-secret values may be copied to the new names with
`fly secrets set --stage`. Do not remove old names, deploy or restart as part
of this migration. Never read `BUZZY_AUTH_SETUP_TOKEN` out of Fly; copying that
secret requires its vault approval, otherwise retain only the old name.

Validation: `node scripts/prove-env-aliases.mjs` after `npm run build` exercises
an operator LLM file through the built helper into a real child process with
each prefix, plus auth tenant loading and dual-name precedence. It uses fixture
values and does not start a daemon or contact production.

The [environment audit](../.verification/env-audit/README.md) records each
keep/remove/ask verdict and the names-only Fly inventory. Unset knobs are retained
with compatible aliases while the owner considers the ask list.
