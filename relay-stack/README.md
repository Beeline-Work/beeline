# Relay front assets

The relay front serves invite links, app-association files, and the hosted
Beeline installer from the read-only `web/` mount.

## Publish the Pages assets

The repository's `relay-stack/web/` tree is the source of truth. The Pages leg
publishes it to GitHub Pages. No production command writes or reloads the
retired relay-front host.

`.github/workflows/app-association-drift.yml` independently checks the live
domain every six hours. It fails the workflow and prints every repository-only
or live-only app ID/path and Android package/relation/fingerprint entry, so
drift is visible well before the next store review.

## Store reviewer entry

Put the custom-scheme form in the App Store and Play submission review notes:

```text
beeline://review/<secret>
```

That is the durable reviewer entry because the `beeline` scheme is baked into
the shipped app binary and needs no server association file. Keep the universal
link too — `https://usebeeline.app/review/<secret>` remains the convenient
verified-link form and its browser fallback offers the same custom-scheme open
action when an OS association handoff fails. Both forms resolve to the same
invisible review route and server redemption; neither adds a login control.

## Local RoomView proof

`npm run stack:up` starts the local relay and its credential-free materializer;
the latter serves the RoomView indexer through the same `127.0.0.1:3010`
front. After it becomes healthy, run:

```sh
npm run verify:local-room-indexer
```

The proof creates a fresh local Room and reads it through `/room/:id` with the
creator's NIP-98 identity. Its request URL is local and its relay Host header
can be set separately with `BUZZY_LOCAL_RELAY_HOST` for an isolated test port.

## Build the Beeline download

From the repository root:

```sh
npm install
npm run bundle:beeline -- --platform linux-x64
```

The command builds the TypeScript CLI, bundles its JavaScript dependencies,
and packages it with `buzz-agent` and `buzz-dev-mcp` into
`web/dl/beeline-linux-x64.tar.gz`. It uses executable binaries from
`BUZZ_AGENT_BIN` and `BUZZ_DEV_MCP_BIN`, then `PATH`, and otherwise builds the
pinned upstream source for the host platform.

`darwin-arm64` is also a declared target for LOCAL builds (CI no longer builds
it — see `docs/cli-bundle-channel.md`; a cross-built darwin bundle carries
`verified: false` and cannot be published). On a non-macOS build host, supply
both matching binaries:

```sh
BUZZ_AGENT_BIN=/path/to/darwin-arm64/buzz-agent \
BUZZ_DEV_MCP_BIN=/path/to/darwin-arm64/buzz-dev-mcp \
npm run bundle:beeline -- --platform darwin-arm64
```

Each local build writes `web/dl/manifest.json`, a tarball, and its checksum
sidecar as ignored build outputs. The release workflow uploads the verified
bundle as a GitHub Actions artifact; it no longer mirrors files into the
retired relay-front host. Git carries none of those generated files. The
Pages deployment serves the repository-owned static site, while the Fly
monolith is the only production API/server.

- `/install` as `text/x-shellscript`
- `/dl/beeline-<os>-<arch>.tar.gz` and its `.sha256` sidecar
- `/dl/manifest.json` — the rolling "latest from main" manifest consumed by
  the daemon self-update flow (see `docs/cli-bundle-channel.md`)

Historical relay-front publication procedures are intentionally not retained
as runnable instructions. Release artifacts belong in GitHub releases/Actions;
do not restore a host-side `/dl` mirror.

For local verification, override the install origin while using the same
published script:

```sh
curl -fsSL http://127.0.0.1:3010/install | \
  BEELINE_INSTALL_BASE_URL=http://127.0.0.1:3010 sh
```
