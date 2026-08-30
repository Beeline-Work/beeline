# Beeline CLI bundle channel ("latest from main")

Every push to `main` that touches daemon/CLI bundle inputs runs
`.github/workflows/beeline-bundle.yml`, which builds the CLI bundle natively
for **linux-x64 on the self-hosted production-Linux runner** (same labels as
`deploy-host.yml` — zero paid GitHub minutes) and publishes the bundle set
directly to `/home/lunchbox/buzz-router-relay-prod/relay-front/web/dl/` on that
host. nginx serves that host-local directory at `https://usebeeline.app/dl/`;
the tarballs and manifest are not committed to Git. This is a rolling "latest"
channel only; tagged releases (`v0.2.x`)
and `scripts/install-beeline.sh` are untouched and remain the versioned
install paths.

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

1. **Verified, manifest-last publication.** The publisher writes the complete
   generation to a temporary directory inside the host store, verifies every
   tarball against its manifest SHA-256 and byte count, atomically renames each
   tarball and sidecar into place, then atomically renames `manifest.json`
   last. The manifest cannot advertise a file that has not reached the store.
2. **Stable filenames.** `beeline-<platform>.tar.gz` never changes, matching
   the URLs the installer and self-update flow already use.
3. **Idempotent re-runs.** When the live `dl/manifest.json` already names the
   current `sourceCommit`, the publisher exits without touching anything.
4. **Rollback generations.** Before replacement, the outgoing generation is
   copied under `dl/.versions/<version>-<commit>`. The current generation plus
   the latest four archives are retained by default (`BEELINE_DL_KEEP=5`). An
   operator rollback copies one archived generation's files back to `dl/`,
   with `manifest.json` copied last.

## Deployment cutover

`scripts/deploy-relay-host.sh` excludes `relay-front/web/dl/` from every
checkout-to-webroot rsync, backup, and rollback. Before it stages or changes
any live web file, it parses the host-local manifest and requires every named
tarball and checksum sidecar to exist and agree. A missing bundle therefore
fails loudly while the previously served `/dl/` remains untouched.

The first post-merge cutover is ordered as follows:

1. The existing production `/dl/` directory continues serving the last
   checkout-published generation.
2. `beeline-bundle.yml` builds and install-verifies the native bundle, then
   publishes it into that same host-local directory.
3. Only after publication succeeds does the bundle workflow dispatch
   `deploy-host.yml`. The ordinary push-triggered deploy may run earlier, but
   it preserves `/dl/`; the dispatched run performs the final public checks.
4. After this change lands, source checkouts no longer contain release bytes.

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

Local builds default `version` to the build date (`YYYY.MM.DD`); CI pins
`0.0.<run_number>`. `scripts/publish-beeline-dl.mjs` is CI-facing, requires an
explicit `--output-dir` (or `BEELINE_DL_ROOT`) so it cannot accidentally write
release bytes into a checkout, and refuses platforms not verified natively.
