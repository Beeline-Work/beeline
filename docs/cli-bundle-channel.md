# Beeline helper update channel

> **Current topology (2026-09-09):** the cutover below is complete.
> `usebeeline.app` is backed by GitHub Pages and `server.usebeeline.app` is the
> Fly monolith. The unified release has no legacy host mirror. The runbook is
> retained only as cutover history; do not execute its mirror-enable steps.

Existing helpers poll `https://usebeeline.app/dl/manifest.json`. That URL and
its relative `beeline-linux-x64.tar.gz` and `.sha256` paths remain unchanged.
No helper migration, URL override, or intervening helper release is required.
Cloudflare remains the public TLS endpoint; GitHub Pages becomes the origin
for the entire website, including `/dl` and `.well-known`.

## Release authority and durable storage

`.github/actions/daemon-leg/action.yml` builds and install-verifies the native
linux-x64 bundle under the unified release's exact version and source SHA.
After the server confirms that identity, its promote phase passes the downloaded
`daemon-artifact-<sha>` to `.github/actions/pages-leg/action.yml`. The Pages leg:

1. Verifies the artifact identity, every archive's digest and size, and sidecars.
2. Assembles the static website with those exact bytes, ignoring checkout `dl/`.
3. Saves the same files as GitHub Release assets on `helper-update-channel`.
4. Deploys the complete Pages artifact, including hidden association files.
5. Runs `scripts/verify-pages-update.mjs` against the deployed host.

The rolling `helper-update-channel` release is a prerelease, excluded from
GitHub's latest stable release selection. It supplies durable inputs for
website-only deployments after Actions artifacts expire. It is not the URL
helpers poll. `scripts/pages-channel.mjs` owns its upload/download contract.
Every caller holds the same `usebeeline-pages` concurrency group through
publication and deployment. An interrupted backup upload fails validation;
the next release retry replaces and repairs it. The previous Pages deployment
continues serving until a complete replacement is deployed.

`.github/workflows/pages.yml` still runs on pushes to main. It reuses the
GitHub Release assets and never builds or assigns a second helper version.
A missing or corrupt channel fails closed, preserving the existing Pages site;
it never falls back to the stale checkout or the dev machine. For the first
migration, its manual `release_run_id` input bootstraps from the exact artifact
matching the live server identity. A normal unified release also bootstraps it.

No new binaries are committed to Git (#647). The served Pages site and Release
assets are independent of the dev machine and Actions artifact retention.
Build runners still run the existing release jobs; moving those runners is a
separate task from retiring the dev relay services.

## Consumer and verification contract

The manifest uses schemaVersion 1, with `sourceCommit`, `version`, and one
`bundles["linux-x64"]` entry containing `file`, `sha256`, `bytes`, `node`,
`commit`, `version`, and `verified: true`. The bundle and top-level identities
must match the unified release identity. Source commit is the helper's primary
comparison; the unified release's `vX.Y.Z` is the version fallback. Darwin
publishing remains disabled; this change adds no platform or independent build.

The verifier requires the exact expected manifest, checks the SHA sidecar,
and executes the production `SelfUpdateManager` in a disposable prefix seeded
with an older identity. It fetches and hashes the actual tarball, extracts it,
smoke-tests the CLI, activates the stable anchor, checks the installed identity,
and runs the installed `beeline --version`. It does not pair, start a daemon,
or touch an existing helper. The older identity is a fixture that forces a
same-release redeploy through the real updater path, not a claim of fleet
restart. The unified release's existing readiness check proves fleet uptake.

Redirects are refused in the hosting proof: a github.io redirect back to the
old dev origin must not count as a successful Pages verification. Use the
direct github.io URL before custom-domain setup and the public Cloudflare URL
after cutover. Pages propagation is retried for up to 20 attempts, 15 seconds
apart; stale manifests and checksum mismatches never count as success.

## Historical firstmate cutover runbook (completed; do not execute)

Only firstmate performs these remote configuration and teardown steps. Decision
`pages-tls-cutover`: use the ongoing Cloudflare bridge, with orange-cloud proxying
and **Full** SSL to the Pages origin. GitHub provisioning a `usebeeline.app`
certificate is not a prerequisite. Never turn off Cloudflare proxying as part
of this migration; never retain the dev origin as a permanent fallback.

### 1. Land and populate Pages while the old origin remains live

- Merge the validated PR. Do not change DNS or stop the dev stack yet.
- The former temporary host mirror was active during this historical step; it
  has since been removed from the release workflow.
- Bootstrap Pages with the current unified release's artifact, or run a full
  unified release. At implementation time the current release was `v0.0.63`,
  SHA `9fc9f30cde8e6cbdeab6183dbf22b5402e47473a`, run `34189855500`, archive
  SHA-256 `77a3a0cd4fc180e64dac0f3f55dbfd3ab4c77189de3e3d111df3274b876664d3`.
  Confirm those values are still current before using this example:

  ```sh
  gh-axi workflow run pages.yml --repo lunchboxfortwo/beeline --ref main -f release_run_id=34189855500
  ```

- Wait for the Pages workflow's real-update proof to pass against
  `https://beeline-work.github.io/beeline/dl/manifest.json`. A first push can
  fail because the channel does not exist yet; bootstrap repairs that without
  using the checkout's stale bytes. If the release artifact has expired, run a
  new unified release; do not rebuild the old release under a new identity.
- Download the durable channel into a fresh local directory for later comparison:

  ```sh
  gh-axi release download helper-update-channel --repo lunchboxfortwo/beeline --dir .scratch/cutover-expected
  node scripts/verify-pages-update.mjs --manifest-url https://beeline-work.github.io/beeline/dl/manifest.json --expected-manifest .scratch/cutover-expected/manifest.json --work-dir .scratch/cutover-proof
  node scripts/verify-pages-update.mjs --manifest-url https://usebeeline.app/dl/manifest.json --expected-manifest .scratch/cutover-expected/manifest.json --work-dir .scratch/cutover-proof
  ```

Both origins must pass with the same current version, commit, and digest before
cutover. Pause release dispatches and website changes during the transition so
the compared generation stays fixed. Preserve the current Cloudflare DNS record
and origin/SSL settings in the operator log for rollback.

### 2. Change the Cloudflare origin, keeping public TLS at Cloudflare

1. In GitHub repository **Settings → Pages**, retain **GitHub Actions** as the
   publishing source and set the custom domain to `usebeeline.app`. This binds
   the incoming Host header to this Pages project at `/`, rather than `/beeline`.
   The checked-in `CNAME` alone does not configure a custom Actions deployment.
   Do not wait for a GitHub custom-domain certificate or make Enforce HTTPS a
   gate; Cloudflare already owns the browser/helper-facing certificate.
2. In Cloudflare's `usebeeline.app` zone, keep the apex record **Proxied**
   (orange cloud). Edit the existing apex `CNAME` (`@` / `usebeeline.app`):
   replace its `<tunnel-id>.cfargotunnel.com` target with
   **`beeline-work.github.io`**. Target is a hostname, without `https://` or
   `/beeline`. Cloudflare flattens the apex CNAME. Do not leave competing A,
   AAAA, or tunnel records for this same apex name.
3. Set Cloudflare origin SSL mode to **Full** for `usebeeline.app` (use a
   hostname-scoped Configuration Rule if other hostnames need a different
   setting). Keep the Cloudflare edge certificate active. Full encrypts the
   origin hop without requiring a certificate matching `usebeeline.app`;
   Pages can present its `*.github.io` certificate. Do not use Full (strict),
   Flexible, Off, or DNS-only for this agreed transition.
4. Remove or disable any apex-specific Worker, Origin Rule, redirect, or
   tunnel routing override that would still send `/dl` or the website to the
   dev stack. The entire apex, including `/dl/*` and `/.well-known/*`, uses
   Pages. Do not change `server.usebeeline.app` or other unrelated hostnames.
5. Purge Cloudflare's cached apex content, including `/dl/manifest.json`, the
   tarball, sidecar, and both association paths. Set a cache-bypass rule for
   `http.host eq "usebeeline.app" and starts_with(http.request.uri.path, "/dl/")`
   so Cloudflare does not retain an older rolling helper generation.
6. Set the repository variable used by future deploy proofs:

   ```sh
   gh-axi variable set BEELINE_PAGES_MANIFEST_URL --repo lunchboxfortwo/beeline --body https://usebeeline.app/dl/manifest.json
   ```

GitHub's default project URL may now redirect to the public domain. That is
expected; proofs must now use the public URL above, not silently follow a
redirect from the old pre-cutover probe URL.

### 3. Verify the public contract, then remove the dev dependency

Run the real update proof again, with normal certificate validation:

```sh
node scripts/verify-pages-update.mjs --manifest-url https://usebeeline.app/dl/manifest.json --expected-manifest .scratch/cutover-expected/manifest.json --work-dir .scratch/cutover-proof --attempts 20
curl --fail --silent --show-error https://usebeeline.app/ -o .scratch/cutover-index.html
curl --fail --silent --show-error https://usebeeline.app/.well-known/assetlinks.json -o .scratch/cutover-assetlinks.json
curl --fail --silent --show-error https://usebeeline.app/.well-known/apple-app-site-association -o .scratch/cutover-apple-association
cmp relay-stack/web/.well-known/assetlinks.json .scratch/cutover-assetlinks.json
cmp relay-stack/web/.well-known/apple-app-site-association .scratch/cutover-apple-association
```

Confirm `/` is the deployed site, and in Cloudflare confirm the apex origin is
Pages and no active rule routes the apex to the tunnel. Record the successful
Pages deployment and public version/SHA/digest proof. Inspect the ordinary
server daemon-readiness report for release convergence. A certificate mismatch
from a **direct** `curl --resolve usebeeline.app:443:<Pages-IP>` is irrelevant
to this bridge; the public Cloudflare URL must pass without `--insecure`.

The completed cutover then ran a website-only Pages deployment and confirmed
future releases no longer wrote the dev `/dl` directory.

Firstmate may then disable the cloudflared tunnel services serving this old
apex origin and their autostart, stop the `beeline-front` nginx service/container
and `buzz-acp`, and remove the old
`/home/lunchbox/buzz-router-relay-prod/relay-front/web/dl` store. Identify their
actual supervisor/unit/container names on that host before applying teardown;
this repository does not own those service names or a safe whole-host shutdown
command. Do not stop unrelated tunnels, helpers, the shared release runner,
no-mistakes, or Fly services. Do not delete the dev directory before verification.
Re-run the public update and association proof after services are stopped.

Keep the old origin available only during the verification window. If the public
proof fails before teardown, restore the recorded Cloudflare apex origin and
prior settings, keep the mirror enabled, and repair Pages before trying again.
This is a temporary operator rollback, not a permanent routing fallback. After
teardown, repair/redeploy from GitHub Release assets or a new unified release;
re-enabling the dev mirror is not a recovery dependency.

## References and local checks

- [GitHub custom-domain configuration](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Cloudflare Full SSL](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full/)
- [Cloudflare apex CNAME flattening](https://developers.cloudflare.com/dns/cname-flattening/set-up-cname-flattening/)

Run `npm run test:pages`, the targeted release/association tests, and
`npm run lint:workflows`. `npm run bundle:beeline` remains the local native
build command.
