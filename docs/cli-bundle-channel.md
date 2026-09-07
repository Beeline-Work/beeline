# Beeline CLI bundle channel ("latest from main")

The daemon leg of the one release workflow
(`.github/actions/daemon-leg/action.yml`, called by
`.github/workflows/unified-release.yml` as `daemon_artifact` then
`promote_daemon`) builds the CLI bundle natively for **linux-x64 on the
self-hosted production-Linux runner**. The verified output is retained as a
90-day GitHub Actions artifact and copied into the GitHub Pages deployment at
`https://usebeeline.app/dl/`; the tarballs and manifest are not committed to
Git. This is a rolling "latest" channel only.

The darwin-arm64 CI leg is **disabled** (captain decision, 2026-08): no Mac
consumer ever downloaded the bundle and macOS runners bill 10x. The matrix
entry stays commented out in the workflow; re-enable it by uncommenting the
native macOS matrix leg if a real Mac consumer appears. The build script and
installer keep their darwin handling for local/cross builds, but a
cross-built darwin bundle carries `verified: false` and the publisher refuses
to publish an unverified platform — so only a native-macOS job can put a
darwin bundle on this channel.

## Consumer contract

The daemon self-update flow (`apps/body/src/self-update-manifest.ts`) reads:

```
GET https://usebeeline.app/dl/manifest.json          (DEFAULT_UPDATE_MANIFEST_URL)
GET https://usebeeline.app/dl/<file named by the manifest>
```

`manifest.json`:

```json
{
  "schemaVersion": 1,
  "sourceCommit": "<40-hex sha of the main commit built into these bundles>",
  "version": "0.0.<run_number>",
  "bundles": {
    "linux-x64": {
      "file": "beeline-linux-x64.tar.gz",
      "sha256": "<hex of the tarball bytes>",
      "bytes": 14565142,
      "node": ">=20.11.0",
      "commit": "<same as sourceCommit>",
      "version": "<same as top-level version>",
      "verified": true
    }
  }
}
```

- **`sourceCommit` is primary** for the "is the installed bundle current?"
  comparison (any different commit is a newer bundle on a rolling channel);
  **`version` is the comparable fallback**: `0.0.<run_number>` where
  `run_number` is GitHub's monotonic per-workflow counter — a larger number is
  always a newer build. `compareVersions` (`self-update-manifest.ts`) parses it.
- **`.sha256` sidecars** travel beside each tarball in the standard
  `<digest>  <filename>` format; `scripts/install-beeline.sh` verifies them on
  install, and the self-update flow verifies the manifest `sha256` after
  download.
- **`bundles[<platform>].verified`** is `true` only when that platform's bundle
  was built AND install-verified on a native runner of that same platform
  (`scripts/verify-beeline-install.mjs`). The workflow currently builds
  linux-x64 natively (self-hosted), so published entries are always verified;
  a locally cross-built bundle carries `verified: false`, and the publisher
  refuses to publish an unverified set.

## Publish safety properties

1. **Verified, whole-site publication.** `scripts/pages-site.mjs` verifies every
   tarball against its manifest SHA-256 and byte count before GitHub Pages
   deploys the complete site as one immutable artifact. The manifest cannot
   advertise a file omitted from the deployment.
2. **Stable filenames.** `beeline-<platform>.tar.gz` never changes, matching
   the URLs the installer and self-update flow already use.
3. **Idempotent re-runs.** Rebuilding from the same daemon artifact produces
   the same `/dl` bytes; deploying a Pages artifact replaces the site as a
   unit.
4. **Rollback generations.** GitHub Pages retains prior deployments, and the
   release workflow retains the source daemon artifact for 90 days.

## Deployment order

Every push to `main` deploys repository static files with the newest daemon
artifact from a successful unified release. During a unified release, Pages is
rebuilt with that release's exact daemon artifact after server confirmation and
before daemon promotion. The promote leg verifies the public association,
installer, manifest, archive, and checksum bytes before waiting for helpers to
restart.

The repository already contains historical tarball blobs. Removing those
objects requires an owner-approved `git filter-repo` rewrite, coordinated
force-push of all refs, fresh clones (or careful local cleanup) for every
developer and runner, and invalidation/recreation of open work based on old
commit IDs. That is intentionally separate from stopping new blob growth.

## Local development

```sh
npm run bundle:beeline                       # host platform, self-verifies
BEELINE_BUNDLE_COMMIT=$(git rev-parse HEAD) npm run bundle:beeline -- --platform linux-x64
```

Local builds default `version` to the build date (`YYYY.MM.DD`); CI uses the
unified release version. `scripts/pages-site.mjs build` requires an explicit
bundle directory and output directory, refuses unverified or corrupt inputs,
and never writes release bytes into `relay-stack/web/`.
