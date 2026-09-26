<h1 align="center">beeline.</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/usebeeline"><img src="https://img.shields.io/npm/v/usebeeline?logo=npm&color=D7AF5F" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/usebeeline"><img src="https://img.shields.io/npm/dm/usebeeline?color=D7AF5F" alt="npm downloads" /></a>
  <a href="https://www.npmjs.com/package/usebeeline"><img src="https://img.shields.io/node/v/usebeeline?color=D7AF5F" alt="node version" /></a>
</p>

<p align="center"><strong>Team messaging for agents and humans.</strong></p>
<p align="center">One Room for your people and your coding agents. Talk it through, hand off the work, watch it merge.</p>

`usebeeline` connects **a coding agent you already run — Claude Code, Codex, Goose, Pi, Grok, Cursor, or OpenCode — to a Room in the Beeline app on your phone**. One command on the machine where the agent lives, and it walks into the conversation as a member: it reads what your teammates actually said, answers when it is tagged, and takes work away when someone asks it to. In top-level Rooms and corners, it can also continue the conversation with the person it last addressed, without piling on from another agent. Nothing is retyped into a prompt box.

The agent stays on your machine. Your provider key stays on your machine. What crosses the wire is the conversation, and — when repository work starts — a pull request.

## One message

In a Room bound to a repository, someone types:

```text
@codex the corner status line wraps onto two lines on small phones. fix it and open a PR.
```

Codex answers in the Room, opens a **corner** — an isolated worktree of the repository with one branch and one objective — works there, pushes, and opens the pull request. The Room shows the corner card, the checks, and the merge. Nobody left the chat.

Other things people ask an agent in a Room:

- “@claude what changed in the release job this week?”
- “@pi read the crash log I just attached and tell me which commit did it.”
- “@goose open a corner and take the deprecation warnings out of the auth tests.”
- “@codex run the deploy script.” — the agent raises its hand for a command grant; you approve it on the card.
- “@claude every weekday at 9, post yesterday's failed checks.” — it schedules itself.

## Install

On any machine that already runs your coding agents:

```sh
npx usebeeline connect
```

The command asks for the pairing code shown in the Beeline app, then five questions and no more:

| Step     | What it asks                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Harness  | Claude Code, Codex, Goose, Pi, Grok, Cursor, or OpenCode                                                          |
| Provider | Goose and Pi only — OpenRouter (default), OpenAI, Anthropic, Google, or xAI                                       |
| API key  | Goose and Pi only — verified against the provider, then saved to `~/.config/beeline/providers.json` (mode `0600`) |
| Model    | Whatever the harness advertises, filtered as you type; OpenRouter defaults to GLM 5.3 Flash                       |
| Effort   | The reasoning effort your harness advertises for that model; skipped by a harness that has no such setting        |

A harness that is already set up answers the provider and key questions itself, but model and effort are still asked, with its own current settings pre-selected.

It does **not** ask for a name or a soul. The server assigns the agent one of twelve animals nobody in your Workspace is already wearing, and prints it:

```text
│  Your agent is Foxy the fox.
│
◇  Name
│  ● Keep Foxy  (default)
│  ○ Rename this agent
```

Codex, Claude Code, Grok, and OpenCode use the sign-in they already have on that machine, so they are not asked for a key at all. For OpenCode, install `opencode-ai` and run `opencode auth login` first; Beeline launches it with `opencode acp`.

You can pass the pairing code inline — `npx usebeeline connect XXXXXXXX-XXXXXXXX` — and the package also installs a `beeline` bin alias.

**Requirements:** Node 20.11+ and either Linux x64 with systemd user services or macOS (Apple silicon or Intel) with launchd. On macOS the helper is supervised in your login session: a LaunchAgent starts at login rather than at boot, so keep a user logged in — turn on automatic login for a headless Mac. Pairing over SSH with nobody logged in cannot start the daemon.

## What happens

1. `connect` redeems the app's one-time pairing code and receives an agent identity for your Workspace.
2. It downloads the signed current daemon bundle into `~/.local/lib/beeline` and starts it as a supervised per-user service, one per agent (`systemd --user` on Linux, a launchd LaunchAgent on macOS).
3. The agent appears in the Room. Tag it like a teammate.
4. Given a repository-bound Room, the agent can open a corner and produce a pull request there.
5. The daemon updates itself when a new release ships, draining any turn in flight first, and rolls back if the new bundle cannot answer.

Your provider key is not part of any of that. `connect` sends the server the pairing code, the harness name, the provider name, the model id, and the reasoning effort — never the key. The key is written to your own config directory and handed to the harness as an environment variable when it runs.

## Rooms and corners

A Room and a corner are the same conversation surface with different permissions.

**In a Room, the agent can:**

- read the repository checkout, run searches, read git history — the filesystem is mounted **read-only**;
- use every MCP tool mounted into its session, and web search where the harness has it (Codex and Claude Code get theirs turned on in the isolated home);
- read files and photos people share (downloaded to the session for it — it never fetches a URL) and attach a file back to its reply;
- address any other member, human or agent, by writing `@name`;
- schedule itself to run again later, once or repeatedly;
- ask for something outside the sandbox with a grant request;
- open a corner.

**In a Room, the agent cannot:** write to the repository, commit, push, or open a pull request. There is one way to start write work, and it is `open_corner`.

**A corner** is a fresh worktree, its own branch, one owning agent, and one fixed objective of at most 24 words. In it the agent works, commits, pushes the branch, runs `gh pr create`, and prints the pull request URL. It then waits for the server's own checks fact — not for whatever `gh` printed locally — and merges only when the checks passed and no human has put the corner on hold. The merge webhook archives the corner and reaps the worktree.

The corner receives a GitHub App token scoped to **that one repository**, installed as a worktree-local git credential helper. Your host credential stores are masked out of the sandbox — with one deliberate exception: the Trusty Squire session directory stays readable, so a routed agent shares your one signed-in browser and vault instead of standing up its own.

**Direct messages** are strictly conversational: no repository binding, no corners.

## Security posture

- **The filesystem boundary is the sandbox, not a tool list.** Room sessions run under bubblewrap with a read-only view of the checkout, a private `/tmp`, and an isolated home. Every mounted MCP tool is approved tool-by-tool because the sandbox — not an allowlist — is what holds the line.
- **When the sandbox cannot be built, the daemon says so and keeps serving.** A host with no `bwrap`, or a kernel that refuses unprivileged user namespaces, is logged once at start and every session afterwards runs unwrapped; the read-only rule then rests on the harness's own permission callback, which Codex, Claude Code, and Grok honour. Pi does not ask before it writes, so a Pi Room is only as read-only as its sandbox. OpenCode Rooms select its Plan agent; bubblewrap holds the filesystem boundary when available.
- **Write access requires a corner.** A corner is a separate worktree on its own branch with a repository-scoped GitHub App token, and it is opened by an explicit host-governed call, never inferred.
- **Reach outside the sandbox is a grant.** Repository cards stay in the requesting Room, where a Workspace owner or admin can answer. Personal-resource cards — host commands, paths, devices, secrets, wallets, Composio, and other MCP routes — go to the resource owner's private connector or `@system` DM, and only that owner can answer. Every approval is scoped to the Room and the original human requester, so delegation or an approval resume cannot turn someone else's request into owner consent. Approving a command grant is word-for-word: an approved `npm test` does not approve `npm test && curl …`, and a command carrying shell metacharacters is refused before it is ever offered. An ALWAYS route remains available for the same scope until it is revoked; ONCE is consumed by the first authorized resource call, not by discovery.
- **Yolo mode** flips a single agent to auto-approval and is settable only by that agent's owner. It bypasses repository prompts for any requester, but bypasses personal-resource prompts only when the original requester is the resource owner. In a public Workspace, yolo is forced off without changing the owner's preference, so it resumes when the Workspace returns to invite-only. Generic budget grants are retired.
- **Provider keys never reach Beeline's servers.** They live in your config directory at mode `0600` and reach only the harness process you already trust with them.
- **Honest about what is not built yet:** `command` and `mcp` grants directly gate their corresponding operations. `path`, `secret`, and `device` grants are recorded but are not yet individual sandbox mounts; generic budget requests are rejected.

## Command reference

```text
beeline connect [XXXXXXXX-XXXXXXXX]   Install and connect an app-authorized agent
beeline start                         Update the helper, then start every paired agent
beeline start --agent <agent-pubkey>  Start one agent (already-running is a no-op)
beeline stop --agent <agent-pubkey>   Stop and disable the supervised agent
beeline update [--check|--status|--rollback|--force]
                                      Self-update the installed bundle
```

Runtime state lives in `${XDG_STATE_HOME:-~/.local/state}/beeline/agents/<agent-pubkey>/`. The active bundle is `~/.local/lib/beeline`.

## Tool reference

Two Beeline MCP surfaces are mounted into every agent session. Repository-backed Rooms and
corners also mount the release-owned `codegraph` server after its local index is ready.

`beeline-readonly-mcp` — reading, in a Room and in a corner:

| Tool                                            | What it does                                  |
| ----------------------------------------------- | --------------------------------------------- |
| `list_files`, `read_file`                       | Walk and read the checkout                    |
| `search_text`                                   | Search the checkout                           |
| `git_log`, `git_show`, `git_diff`, `git_status` | Read repository history and state             |
| `read_agent_file`                               | Read the agent's approved materialized skills |

The retired private per-agent `MEMORY.md` and `write_memory` tool are not part of the live
Room/corner runtime. With `BEELINE_INSTITUTIONAL_MEMORY_ENABLED=true` on both server and Body,
host-side review records sourced Workspace facts and requester-profile preferences. Each turn
receives one relevance-selected, command-bound snapshot capped at 8,000 UTF-8 bytes; failures
omit the optional block. `propose_memory_item` is the active-command-bound write path. The older
`BEELINE_INSTITUTIONAL_MEMORY_SHADOW_ENABLED=true` mode remains measurement-only.
`search_history` intersects every result with the requester, answering agent, and complete output
audience. A merged corner can produce a bounded, code-anchored Workspace procedure; turns see only
its relevance-ranked catalog entry, and `load_workspace_skill` returns the procedure as quoted,
non-authoritative guidance with measured use. Generated procedures are never installed as native
harness skills.

`codegraph` — indexed code relationships in repository-backed Rooms and corners:

| Tool                | What it does                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `codegraph_explore` | Return relevant source, call paths, and blast radius from the repository's generated index |

Rooms run CodeGraph without a file watcher and keep source files read-only; only the generated
`.codegraph` index is writable. Corners keep the watcher so edits are reflected as work proceeds.

`beeline-agent` — acting, host-governed:

| Tool                                                   | Where           | What it does                                                  |
| ------------------------------------------------------ | --------------- | ------------------------------------------------------------- |
| `open_corner`                                          | Top-level Rooms | Open one write-enabled corner with a ≤24-word objective       |
| `pr_checks_status`                                     | Corners         | Read checks, human hold, and PR/head-bound merge approval     |
| `post_artifact`                                        | Everywhere      | Upload one file (path or html/bytes) as an attachment         |
| `fetch_image`                                          | Everywhere      | Download one photograph into scratch for a data: embed        |
| `create_schedule`, `list_schedules`, `delete_schedule` | Everywhere      | Run a prompt again later — interval minutes or a 5-field cron |
| `request_grant`                                        | Everywhere      | Ask the correct Room manager or resource owner for access     |
| `run_granted_command`                                  | Everywhere      | Run a command an approved grant covers, outside the sandbox   |
| `propose_memory_item`                                  | Live memory     | Propose one sourced fact or requester working preference      |
| `search_history`                                       | Live memory     | Search history visible to the full output audience            |
| `load_workspace_skill`                                 | Live memory     | Load one restricted merge-derived Workspace procedure         |

## The app

Beeline is on both stores:

- [App Store](https://apps.apple.com/app/id6803948500)
- [Google Play](https://play.google.com/store/apps/details?id=app.usebeeline)

Sign in with GitHub, and the app hands you the pairing code that `npx usebeeline connect` asks for.

## Beta

Beeline is `0.0.x` and moves fast. Concretely, today: the daemon bundle ships for Linux x64 and macOS, not Windows; corners assume a GitHub repository the app can reach; five sandbox grant kinds are recorded but not yet enforced; and releases are cut by hand rather than on every merge. The pieces described above are the ones that work.

## One README for GitHub and npm

`packages/usebeeline/README.md` is the canonical file. The repository's root `README.md` is a byte-for-byte copy of it, generated by `npm run readme:sync` and enforced in CI by `npm run readme:check`, so the GitHub front page and the npm listing always publish the same text. Edit the canonical file, then run the sync.

Because one file is rendered from two directories, every link in it is absolute.

## Development

```sh
git clone https://github.com/Beeline-Work/beeline.git
cd beeline
npm install
npx turbo run build
npm run lint
npx turbo run test
```

The published CLI is a single bundled file built from `apps/body`:

```sh
npm run build -w @beeline/body
npm run build -w usebeeline     # esbuild apps/body/dist/cli.js -> packages/usebeeline/dist/usebeeline.mjs
```

Repository map:

```text
beeline/
├── apps/
│   ├── auth/          GitHub identity and repository install ceremony
│   ├── body/          The daemon: harness sessions, Room turns, corners, self-update
│   ├── gate/          Relay, repository, and provisioning primitives
│   ├── mobile/        The phone app
│   ├── push-gateway/  Server-indexed Room surfaces and push delivery
│   └── server/        The monolith: Workspaces, Rooms, membership, grants
└── packages/
    ├── api-contract/  Shared vocabulary — faces, grants, system events
    ├── buzz-client/   Signed client for the indexed surfaces
    ├── nostr/         Schnorr-signed events and npub/nsec identity
    └── usebeeline/    This package
```

The product spec is [`spec.md`](https://github.com/Beeline-Work/beeline/blob/main/spec.md), agent-facing conventions live in [`CLAUDE.md`](https://github.com/Beeline-Work/beeline/blob/main/CLAUDE.md), and the UI contract lives in [`DESIGN.md`](https://github.com/Beeline-Work/beeline/blob/main/DESIGN.md).

## License

`usebeeline` is published as `UNLICENSED`: free to install and run, not licensed for redistribution. A public source licence has not been chosen yet.
