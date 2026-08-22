# Beeline CLI bundle channel ("latest from main")

Every push to `main` runs `.github/workflows/beeline-bundle.yml`, which builds
the CLI bundle natively for each supported platform and publishes the bundle
set to its existing home — `relay-stack/web/dl/`, served statically at
`https://usebeeline.app/dl/` — by committing the regenerated set back to
`main`. This is a rolling "latest" channel only; tagged releases (`v0.2.x`)
and `scripts/install-beeline.sh` are untouched and remain the versioned
install paths.

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
  (`scripts/verify-beeline-install.mjs`). The workflow builds every platform
  natively, so published entries are always verified; a locally cross-built
  bundle carries `verified: false`, and the publisher refuses to publish an
  unverified set.

## Publish safety properties

1. **One commit per publish.** The whole set (both tarballs, both sidecars,
   `manifest.json`) lands as a single git commit to `main`, so a consumer can
   never see a manifest pointing at a missing or half-updated tarball.
2. **Stable filenames.** `beeline-<platform>.tar.gz` never changes, matching
   the URLs the installer and self-update flow already use.
3. **Idempotent re-runs.** When `dl/manifest.json` already names the current
   `sourceCommit`, the publisher exits without touching anything; the
   publisher's own commits carry a `[beeline-bundle-publish]` marker and do
   not re-trigger the workflow.

## Local development

```sh
npm run bundle:beeline                       # host platform, self-verifies
BEELINE_BUNDLE_COMMIT=$(git rev-parse HEAD) npm run bundle:beeline -- --platform linux-x64
```

Local builds default `version` to the build date (`YYYY.MM.DD`); CI pins
`0.0.<run_number>`. `scripts/publish-beeline-dl.mjs` is CI-facing and refuses
platforms that were not verified on their native runner.
