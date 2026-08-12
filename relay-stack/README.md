# Relay front assets

The relay front serves invite links, app-association files, and the hosted
Beeline installer from the read-only `web/` mount.

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

`darwin-arm64` is also a declared target. On a non-macOS build host, supply
both matching binaries:

```sh
BUZZ_AGENT_BIN=/path/to/darwin-arm64/buzz-agent \
BUZZ_DEV_MCP_BIN=/path/to/darwin-arm64/buzz-dev-mcp \
npm run bundle:beeline -- --platform darwin-arm64
```

Each build updates `web/dl/manifest.json` and writes a checksum sidecar. Deploy
the complete `relay-stack/` directory so nginx can serve:

- `/install` as `text/x-shellscript`
- `/dl/beeline-<os>-<arch>.tar.gz` and its `.sha256` sidecar

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
