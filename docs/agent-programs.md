# Installed agent programs and daily adapter checks

The add-agent wizard always lists Codex, Claude Code, Goose, Pi, Grok, Cursor
and OpenCode. It checks the selected program before installing an adapter,
probing models, asking for a provider key or requesting a pairing grant. A
missing program ends the wizard with its name and installation command.
Existing agents whose program was removed carry that same error through the
ordinary Room turn receipt. No System message is added.

The helper installs only separable ACP adapters with npm `@latest`, omitting
optional bundled native harness binaries. Node/npm and agent programs belong to
the operator. Workspace cache sharing remains, but the helper no longer creates
Workspace copies of adapters and harness CLIs. No toolchain manifest, Node or
agent downloader, checksum store, or helper-owned program prefix is retained.

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

The feedback-triage workflow's `adapters` step runs
`node scripts/check-acp-adapters.mjs` after building Body. It installs the three
latest adapters into temporary prefixes and uses the installed programs. Every
check has private HOME/XDG/config/cache directories and an explicit environment
without provider keys, logins, tokens or inherited Node options. It runs the
production ACP client through `initialize` and `session/new`, never prompts a
model, cleans up processes/files and returns versioned JSON results. Nonzero exit
means findings must be assessed, not ignored. See the workflow procedure for the
normal human approval and dispatch path.

A refused unauthenticated session is a precise limitation, not evidence that a
logged-in turn is broken. On the local run:

```text
@agentclientprotocol/codex-acp 2.2.2: initialize passed; session/new refused Authentication required
@agentclientprotocol/claude-agent-acp 0.93.0: initialize and session/new passed
pi-acp 0.0.34: initialize passed; session/new refused Authentication required
exit status: 1
```

No login or credential was supplied to resolve those refusals.

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
