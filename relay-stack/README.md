# Relay front assets

The relay front serves invite links, app-association files, and the hosted
Beeline installer from the read-only `web/` mount.

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

Each build updates `web/dl/manifest.json` and writes a checksum sidecar. CI
(`.github/workflows/beeline-bundle.yml`) regenerates and commits this set on
every push to `main`; deploy the complete `relay-stack/` directory so nginx can
serve:

- `/install` as `text/x-shellscript`
- `/dl/beeline-<os>-<arch>.tar.gz` and its `.sha256` sidecar
- `/dl/manifest.json` — the rolling "latest from main" manifest consumed by
  the daemon self-update flow (see `docs/cli-bundle-channel.md`)

The invite landing page also expects the latest signed Android release APK at
`web/dl/beeline-android.apk`. This stable deployment alias is not committed;
copy the same APK attached to the current GitHub release before deploying the
relay front so new invitees can install Beeline without losing their invite URL.

For local verification, override the install origin while using the same
published script:

```sh
curl -fsSL http://127.0.0.1:3010/install | \
  BEELINE_INSTALL_BASE_URL=http://127.0.0.1:3010 sh
```
