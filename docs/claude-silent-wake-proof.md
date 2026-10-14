# Claude silent wake proof

Reproduction `claude-native-thinking-only-20261013`: a worker-report wake
ends with thinking only. Native Claude 2.1.293 injects the exact sentence
“Your previous response had no visible output. Please continue and produce a
user-visible response.” before returning the ACP completion. PR #2418 only
handled an empty completion returned to the helper, so it could not prevent
this SDK-internal retry.

## Deployment observations

On squire, the read-only checks on October 13, 2026 found:

- Production `https://server.usebeeline.app/version` served v0.1.55,
  source SHA `20822ca3e10f512ca8d623823abbcf5fd493e327`.
- The published helper manifest and `beeline update --status` reported the
  same release. The native helper service started at 23:03 EDT.
- The helper journal at 22:43 EDT referenced release
  `638e2a3001b3804211fdab4b08f1ecf33eb5edf6`.
- Both source commits include #2418's merge
  `8611428059b260ac4f65343a483bc42cd03037fa`, merged at 17:10:12 UTC.
  Neither compiled Beeline bundle contained the retry sentence.
- The installed Claude SDK executable contained both that sentence and the
  internal thinking-only retry. These observations establish the release at
  22:43, not the exact helper identity for every minute of the reported window.

## Re-run

Build `@beeline/body`, then run:

```sh
node scripts/prove-claude-silent-wake.mjs /absolute/path/to/installed/claude-agent-acp
```

The Linux proof clears inherited environment, isolates HOME/XDG and cwd, uses
a fake local Messages API and fake key, and mounts the built Beeline MCP server.
It saves raw observations in the printed temporary evidence directory. It does
not start, pair, update or restart a production helper, contact the Beeline
server, or ask a real model to decide whether to reply.

The baseline produces one internal retry and visible retry text. The built
`no_reply_needed` handler plus the exact terminal declaration produces one
successful tool call, zero retries, zero assistant text and ACP `end_turn`.
Human calls to the tool are refused; human provider failures remain visible.
Room turn-loop regressions separately verify the completed terminal call posts
no Room reply and completes once.

## Integration limits

`CLAUDE_CODE_TERMINAL_MCP_TOOLS` is proven against installed Claude 2.1.293,
SDK 0.3.293 and ACP 0.89.1. It is not listed in the public environment reference;
this is a runtime-proven integration, not a documented stable per-turn API.
The exact model-visible name is `mcp__beeline-agent__no_reply_needed`.
The handler checks the current command file every time, including after
retained sessions switch to human input. It makes no server write. Every new
Claude session receives the declaration; a helper release restart creates new
ACP processes rather than retaining a process with the previous declaration.
