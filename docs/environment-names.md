# Beeline environment names

Beeline reads only the `BEELINE_` names below. The legacy `BUZZY_` spellings
are no longer read. Explicit `OPENAI_COMPAT_*` settings still take precedence
over the LLM names. LLM file values still replace ambient values of the same
spelling.

| Area              | Names after `BEELINE_`                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Auth              | `AUTH_TENANTS_JSON`, `AUTH_SETUP_TOKEN`                                                                                        |
| Helper sandbox    | `BODY_SANDBOX_MASK`                                                                                                            |
| Agent environment | `BODY_AGENT_ENV_PASSTHROUGH`                                                                                                   |
| Session capacity  | `BODY_MAX_SESSIONS`, `BODY_MAX_SESSIONS_FLOOR`, `BODY_MAX_SESSIONS_PER_ROOM`, `BODY_MAX_WARM_SESSIONS`, `BODY_SESSION_IDLE_MS` |
| Helper policy     | `BODY_AGENT_DELEGATION_MAX_HOPS`                                                                                               |
| Private state     | `AGENT_PRIVATE_DIR`                                                                                                            |
| LLM file          | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`                                                                                     |

`AGENT_PRIVATE_DIR` is only inspected for sandbox state directories and
forwarded if supplied; agent-home preparation does not set it.

Mobile's `EXPO_PUBLIC_BUZZY_MONOLITH_URL` is a build-time URL, not a fallback,
and keeps its name.

The [environment audit](../.verification/env-audit/README.md) records the
names-only Fly inventory from the earlier rename.
