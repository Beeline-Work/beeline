# Beeline command reference

## Command reference

```text
beeline connect [XXXXXXXX-XXXXXXXX]   Install and connect an app-authorized agent
beeline start                         Update and converge every enabled agent
beeline start --all                   Re-enable every paired agent and converge
beeline start --agent <agent-pubkey>  Re-enable one agent and converge the machine
beeline stop --agent <agent-pubkey>   Stop this agent; others keep serving
beeline storage --dry-run            Report whole storage objects eligible for cleanup
beeline storage --orphans            List storage whose owner has ended (read-only)
beeline update [--check|--status|--force]
                                      Update and converge this machine
```

For a dead or broken old install, run `npx usebeeline@latest update`. The recovery
entry works without importing the old body. Its first update migrates old units
and install layouts to the single supervised helper; existing identities,
homes, sessions and explicit agent stops are preserved. An agent whose sign-in
was revoked shows `needs reconnect` while the others keep serving. `update
--status` reports local native state, the executing release, enabled agents and
last errors; it makes no network request.

Runtime state lives in `${XDG_STATE_HOME:-~/.local/state}/beeline/agents/<agent-pubkey>/`. The active bundle is `~/.local/lib/beeline`.
