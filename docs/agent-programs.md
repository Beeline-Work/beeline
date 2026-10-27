# Installed agent programs and daily adapter checks

The add-agent wizard always lists Codex, Claude Code, Goose, Pi, Grok, Cursor
and OpenCode. It checks the selected program before installing an adapter,
probing models, asking for a provider key or requesting a pairing grant. A
missing program ends the wizard with its name and installation command.
Existing agents whose program was removed carry that same error through the
ordinary Room turn receipt. No System message is added.

The helper follows npm's latest release channel for Claude, Codex and Pi ACP
adapters, waiting **24 hours from the npm registry publish time** before adoption.
While the newest release ages, the newest eligible prior release is considered.
Each candidate installs at an exact version in a unique prefix under
`$XDG_DATA_HOME/beeline/adapters` (default `~/.local/share/beeline/adapters`),
omitting optional bundled native harness binaries. It never replaces a global
adapter or an already adopted prefix.

Before promotion, `adapter-session-check.ts` runs the production `AcpClient`
through `initialize` and `session/new`, including a system prompt, MCP declaration
and harness-specific metadata, without a model prompt. Protocol version 1 must
negotiate successfully; advertised capabilities are recorded, with optional
features left optional. Package versions select releases, never compatibility.
The runtime check uses the operator's installed program and existing environment;
an authentication refusal fails the check just like any other session failure.

A passing candidate atomically becomes the shared active command for every agent
of that kind, including agents with older global paths in their runtime records.
Already running sessions retain their original prefix. On failure, the working
command stays selected, the failed version is remembered, and one helper error
names the adapter, exact version and redacted cause. It uses the existing Sentry
alert route (`/api/webhooks/sentry`) to the configured Telegram channel. Repeated
starts and concurrent helpers sharing the adapter store do not repeat that alert
or retry that version; the next published version gets a fresh check. A
kernel-owned lock serializes installations and pointer writes, including Connect
and pairing. Candidate installation does not block sessions on the working copy.
Registry and npm failures leave the active command intact. No compatibility
allowlist, package-version pin, or manual adoption gate is used.

Node/npm and agent programs belong to the operator. Workspace cache sharing remains, but the helper no longer creates
Workspace copies of adapters and harness CLIs. No toolchain manifest, Node or
agent downloader, checksum store, or helper-owned harness program prefix is retained.

`loadBodyConfig` and Connect model probes explicitly set
`CLAUDE_CODE_EXECUTABLE` to the discovered user `claude`, `CODEX_PATH` to the user
`codex`, and `PI_ACP_PI_COMMAND` to the user `pi`. Codex supports this override;
it does not need to use its package's bundled Codex. Older Claude programs that
reject adapter flags receive the install-message style with their version.

## Official installation references

Commands were checked against these upstream sources on 18 October 2026.
The helper displays these commands; it does not run them.

| Program | Command | Official source |
| --- | --- | --- |
| Codex | `npm install -g @openai/codex` | [OpenAI](https://help.openai.com/en/articles/11096431) |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | [Claude](https://support.claude.com/en/articles/14554922-claude-code-user-faq) |
| OpenCode | `npm install -g opencode-ai` | [OpenCode](https://opencode.ai/docs/) |
| Pi | `curl -fsSL https://pi.dev/install.sh \| sh` | [Pi repository](https://github.com/earendil-works/pi#readme) |
| Goose | `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh \| bash` | [Goose](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/installation.md) |
| Grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | [Grok](https://x.ai/build) |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | [Cursor](https://cursor.com/docs/cli/overview) |

Adapter overrides: [Codex runtime options](https://github.com/agentclientprotocol/codex-acp#runtime-options)
and [Claude adapter implementation](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts).

## Daily check

The daily GitHub workflow `.github/workflows/acp-adapters.yml` and the
feedback-triage workflow's `adapters` step run `node scripts/check-acp-adapters.mjs`
after building Body. It installs the three latest adapters into temporary prefixes and uses the installed programs. Every
check has private HOME/XDG/config/cache directories and an explicit environment
without provider keys, logins, tokens or inherited Node options. It uses the
same session-start check as runtime adoption, deliberately bypasses
the release-age delay to test the newest versions immediately, never prompts a
model, cleans up processes/files and returns versioned JSON results including
negotiated protocol and capabilities when initialization succeeds. Nonzero exit
means findings must be assessed, not ignored. See the workflow procedure for the
normal human approval and dispatch path.

A refused unauthenticated session is a precise limitation, not evidence that a
logged-in turn is broken. The isolated run on 27 October 2026 reproduced the
production request-shape failure:

```text
@agentclientprotocol/codex-acp 2.3.0: initialize passed; session/new refused Invalid params (-32602)
@agentclientprotocol/claude-agent-acp 0.97.0: initialize passed; session/new refused Invalid params (-32602)
pi-acp 0.0.34: initialize passed; session/new refused Authentication required
exit status: 1
```

No login or credential was supplied to resolve those refusals. Authentication
refusals remain failures in CI; a green check requires an actual successful
session start, not just a successful initialize. The separate system-prompt wire
fix is responsible for making the October releases pass; this update protection
keeps the working command selected when a new release fails.

Regression coverage: `adapter-update.test.ts` exercises failing and passing real
ACP subprocesses for all three kinds, durable alert deduplication, the one-day
boundary, partial installs, live command resolution and two independent helpers
sharing one installation. `adapter-freshness.test.ts` covers update fan-out and
session launches proceeding while a candidate holds the install lock.

## Reproduction installed-agent-add

A Debian container had Node, an empty private HOME and no Cursor. The built
wizard was driven with the actual harness picker and Cursor selected. The
baseline wizard's control flow attempted model discovery twice before surfacing
the missing-program error; the revised wizard stopped before any probe. The
reported late-running-agent variant was not reproduced in this baseline.

```text
Wizard choices: codex, claude, goose, pi, grok, cursor, opencode
Reproduction installed-agent-add PASS: Error: Cursor is not installed on this machine (cursor-agent). Install it with `curl https://cursor.com/install -fsS | bash`, then try again.
```

A second container started with the operator's Claude Code 2.1.301 binary already
installed as `/usr/local/bin/claude`, through a logging wrapper. Only the latest
Claude adapter was installed in the fixture, with optional SDK native binaries
omitted. The real wizard selected Claude and opened its ACP model catalog using
that installed program:

```text
Reproduction installed-agent-add PASS: Claude adapter launched the preinstalled operator-claude; no optional SDK native copy installed
```

The launch log records the wrapper executing that preinstalled program. The
container had no test login, so this proves the launch path and session setup,
not a logged-in model turn. These proofs invoke the built wizard directly with
terminal answers and avoid production pairing or native supervisor state.
