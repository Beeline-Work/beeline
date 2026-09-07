# Static site assets

`relay-stack/web/` is the source of truth for usebeeline.app. The
`Publish usebeeline.app` workflow deploys it to GitHub Pages on every push to
`main`. Its Pages-shaped build adds the current verified helper artifact under
`/dl`, copies `install.sh` to the extensionless `/install` path, and includes
the hidden `.well-known` directory without Jekyll processing.

The same Pages build runs inside the unified release before daemon promotion,
so a helper never sees a manifest before its archive and checksum are live.
`scripts/pages-site.mjs` validates the bundle identity, hashes, byte counts,
association contents, and the absence of `/.well-known/nostr.json`.
`.github/workflows/app-association-drift.yml` continues to compare the live
custom domain with the repository every six hours.

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
sidecar as ignored build outputs. CI (the daemon leg of
`.github/workflows/unified-release.yml`, `.github/actions/daemon-leg/`) uploads
the verified set as a 90-day Actions artifact. The Pages build copies that
artifact into its deployment; Git carries none of those generated files.
GitHub Pages serves these paths:

- `/install`
- `/dl/beeline-<os>-<arch>.tar.gz` and its `.sha256` sidecar
- `/dl/manifest.json` — the rolling "latest from main" manifest consumed by
  the daemon self-update flow (see `docs/cli-bundle-channel.md`)

The Pages artifact is deployed as one immutable unit. A normal `main` publish
reuses the newest artifact from a successful unified release; a unified
release deploys its own exact artifact and verifies the public bytes before
helpers are allowed to restart.

The invite landing page links the signed Android APK directly from the
`apk-v27` GitHub Release. At roughly 294 MB it does not belong in the Pages
artifact; changing that release requires updating `APK_DOWNLOAD_URL` in
`web/join/invite-source.js` and rebuilding `invite.js`.

For local verification, override the install origin while using the same
published script:

```sh
curl -fsSL http://127.0.0.1:3010/install | \
  BEELINE_INSTALL_BASE_URL=http://127.0.0.1:3010 sh
```
