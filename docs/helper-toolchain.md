# Helper-owned agent dependencies

`apps/body/src/helper-toolchain-manifest.ts` is the release's dependency authority.
It pins Node, the Codex/Claude/Pi ACP adapters and their complete npm graphs,
and the Codex, Claude Code, Pi, Goose, OpenCode, Cursor and Grok harnesses.
Each downloadable artifact has an exact URL and SHA-256. Node's archive also
contains the npm version used for installation. Reference-agent binaries and
the Cursor ACP bridge ship inside the helper itself; arbitrary custom ACP
commands remain operator supplied.

The helper stores dependencies under `$XDG_DATA_HOME/beeline/toolchain`, or
`$HOME/.local/share/beeline/toolchain`. Selecting a kind in Connect or starting
an existing agent provisions only that kind and Node. `beeline toolchain install
<kind>` invokes the same path for recovery. Resolution prefers complete managed
generations, with existing PATH/version-manager discovery as fallback.

All installers use `withAdapterInstallLock`, keyed by the dependency prefix,
including when no helper bundle anchor exists yet. Downloads retry with backoff,
are SHA-256 verified before extraction, and build in a private staging directory.
Only a complete generation is renamed into place. npm runs through the managed
Node, with its prefix, cache and configuration inside staging. It runs offline
with scripts disabled after the verified tarballs seed its local cache. Pi's
nested shrinkwrap can use the same verified URL responses without fetching
unlisted packages. A failed upgrade preserves the prior published generation.

A changed manifest changes the generation identity. Startup installs that
generation and removes superseded bytes after publication. Old Node directory
names become relative symlinks to the current runtime: installed launchers may
have recorded the previous `process.execPath`. These aliases retain no old Node
bytes and prevent dependency upgrades from stranding a Node-free installation.
Claude/OpenCode automatic updates are disabled; managed Cursor launches with
`--disable-auto-update`.

The shell installer contains a generated Node bootstrap from this same manifest.
It verifies the archive using `sha256sum` or macOS `shasum`, then runs the existing
recovery bootstrap with that Node. It needs curl and the platform's standard tar,
SHA-256 and C/C++ runtime support. It does not require a user Node/npm installation.

Download/install errors retain the dependency/version and use the existing failed
turn receipt, which produces ordinary Room prose. They create no System messages.
A restart retries installation. Connect reports the same error directly.

## Updating a pin

1. Edit the manifest's npm `package.dependencies`, Node version, or native version
   and platform URLs. Keep the four supported platform entries together.
2. Run `node scripts/update-helper-toolchain.mjs`. It preserves existing npm locks,
   updates them for changed direct pins, checks registry SRI, hashes release bytes,
   and regenerates both the manifest and shell bootstrap. Review the graph and
   checksum changes together. Native URLs must be immutable versioned releases.
3. Run the manifest/installer tests and the clean-machine proof below before
   shipping a helper release. No release dispatch belongs to this change.

## Reproduction helper-pinned-dependencies

The proof uses a fresh `debian:stable-slim` container with curl, certificates and
git, with no Node, npm, Codex, Claude or Pi executable on `/usr/bin:/bin`.
`scripts/prove-helper-toolchain.mjs` is an esbuild entrypoint. Bundle it and the
actual helper CLI with the same ESM/createRequire settings as the helper bundle.
Start it after the generated Node bootstrap in an isolated writable `/proof`.
Do not bind a production HOME, XDG state directory, native manager or git runtime.

For each of Codex, Claude and Pi, it:

1. Resolves the unprovisioned command with managed discovery disabled: the CLI is
   missing, matching the main helper's clean-machine failure.
2. Invokes the built helper's `toolchain install <kind>` command with the freshly
   bootstrapped Node and the original stripped PATH.
3. Resolves the managed ACP adapter, initializes ACP, opens a session and prompts
   it to reply `TOOLCHAIN_OK` without tools.
4. Asserts the answer, then repeats installation and asserts no generation changed.

Observed on 18 October 2026:

```text
codex: ACP initialized
codex: ACP session opened
Reproduction helper-pinned-dependencies PASS: codex answered "TOOLCHAIN_OK"
claude: ACP initialized
claude: ACP session opened
Reproduction helper-pinned-dependencies PASS: claude answered "TOOLCHAIN_OK"
pi: ACP initialized
pi: ACP session opened
Reproduction helper-pinned-dependencies PASS: pi answered "TOOLCHAIN_OK"
```

The container's local HTTP relay wrote model requests to `/proof/output`.
The owner's existing vaulted OpenRouter connection sent those requests to the
Responses, Messages and Chat Completions APIs respectively. The relay converted
nonstreaming provider responses into the matching SSE events. Codex/Pi used
`openai/gpt-4.1-mini`; Claude used `anthropic/claude-haiku-4.5`. Claude's unused
tool definitions were omitted to fit the vault HTTP request limit. The actual
provider answers were `TOOLCHAIN_OK`; no provider secret entered the container.
The proof emits separate `*.pass.json` results for review.

This is the narrow affected-service stand-in for a fully paired native helper:
it exercises the built CLI, real downloads, real harness processes, ACP sessions
and provider answers, while avoiding a production Room or native supervisor.
`daemon-api-client.integration.test.ts` separately proves the paired helper's
visible reply using its deterministic custom ACP fixture.

Regression coverage also rejects checksum mismatches without publishing an
installation, replaces version drift, preserves failed upgrades, serializes cold
installs, retains old launcher Node paths, and carries dependency errors through
the ordinary Room receipt. All four platforms' release artifacts were fetched
and hashed; executable acceptance here ran on Linux x64.
