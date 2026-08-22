# Beeline CLI bundle channel ("latest from main")

Every push to `main` runs `.github/workflows/beeline-bundle.yml`, which builds
the CLI bundle natively for each supported platform and publishes a
sha256-verifiable, commit-addressed asset set on a single rolling GitHub
release (tag `beeline-latest`) in `lunchboxfortwo/beeline`. This is a rolling
"latest" channel only; tagged releases (`v0.2.x`) and `scripts/install-beeline.sh`
are untouched and remain the versioned install paths.

## Fetching without a GitHub credential

The repository is private, so release assets are served through the auth
service pass-through (`apps/auth/src/bundle-delivery.ts`, nginx location
`/dl/beeline/`):

```
GET https://usebeeline.app/dl/beeline/manifest.json
GET https://usebeeline.app/dl/beeline/<file named by the manifest>
Authorization: Nostr <NIP-98 GET event bound to the exact URL>
```

The NIP-98 requirement is what keeps the private repo's build output off the
anonymous internet; any valid Beeline identity works, no GitHub token is ever
needed client-side.

## manifest.json contract

```json
{
  "schemaVersion": 2,
  "channel": "main",
  "version": "0.0.0-main.<run_number>",
  "source": {
    "commit": "<40-hex sha of the main commit built into these bundles>",
    "shortSha": "<8-hex>",
    "ref": "refs/heads/main",
    "runId": 123,
    "runNumber": 45,
    "builtAt": "<ISO timestamp>"
  },
  "bundles": {
    "linux-x64": {
      "file": "beeline-linux-x64-<shortsha>.tar.gz",
      "sha256": "<hex of the tarball bytes>",
      "bytes": 14565142,
      "node": ">=20.11.0",
      "verified": true
    }
  }
}
```

- **`version` is comparable**: `<base>-main.<run_number>` where `run_number` is
  GitHub's monotonic per-workflow counter. A larger numeric suffix always means
  a newer build; compare numerically on the suffix, never lexically.
- **`source.commit`** answers "is the installed bundle current?" — compare it to
  the commit the installed bundle was installed from.
- **`bundles[<platform>].verified`** is `true` only when that platform's bundle
  was built AND install-verified on a native runner of that same platform
  (`scripts/verify-beeline-install.mjs`). The workflow builds every platform
  natively, so published entries are always verified; a locally cross-built
  bundle would carry `verified: false`, and the publish script refuses to
  publish such a set.
- **`.sha256` sidecars** travel alongside each tarball with the standard
  `<digest>  <filename>` format, so checksums survive any byte-exact transport.

## Publish safety properties

1. **Commit-addressed assets.** Tarballs/sidecars are published as
   `beeline-<platform>-<shortsha>.tar.gz[.sha256]`; an older published manifest
   therefore always points at assets that still exist unchanged. Old asset sets
   are pruned to the last few commits (`BEELINE_BUNDLE_KEEP`).
2. **Manifest flips last.** All tarballs are uploaded before `manifest.json` is
   replaced, so a consumer can never fetch a manifest pointing at a missing or
   half-uploaded tarball.
3. **Idempotent re-runs.** The release body carries a `bundle-commit: <sha>`
   marker; re-running the workflow for the same commit exits successfully
   without touching anything.

## Local development

```sh
npm run bundle:beeline                       # host platform, self-verifies
BEELINE_BUNDLE_COMMIT=$(git rev-parse HEAD) npm run bundle:beeline -- --platform linux-x64
```

Local (non-CI) manifests omit `version` unless `BEELINE_BUNDLE_VERSION` is set;
`scripts/publish-beeline-release.mjs` requires CI identity env and refuses to
publish unverified platforms.
