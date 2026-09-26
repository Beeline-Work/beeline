# Beeline helper update channel

> **Current topology (2026-09-09):** the cutover below is complete.
> `usebeeline.app` is backed by GitHub Pages and `server.usebeeline.app` is the
> Fly monolith. The unified release has no legacy host mirror. The runbook is
> retained only as cutover history; do not execute its mirror-enable steps.

Existing helpers poll `https://usebeeline.app/dl/manifest.json`. That URL and
its relative platform archive and `.sha256` paths remain unchanged.
No helper migration, URL override, or intervening helper release is required.
Cloudflare remains the public TLS endpoint; GitHub Pages becomes the origin
for the entire website, including `/dl` and `.well-known`.

## Release authority and durable storage

When helper code or a shared helper contract is selected,
`.github/actions/daemon-leg/action.yml` combines install-verified native
`linux-x64`, `darwin-arm64`, and `darwin-x64` bundles under the release's exact
version and source SHA. The macOS builds run natively: Apple silicon on GitHub's
hosted macOS runner and Intel on the repository's self-hosted macOS runner. They
run only while this release identity still owes merged bytes; a retry that
already has that merged artifact promotes those exact bytes instead of
rebuilding them (see [the release pipeline](./release-pipeline.md)).
Other selective releases carry the last successful helper version, SHA, and
artifact reference.
Its promote phase passes `daemon-artifact-<version>-<sha>` to
`.github/actions/pages-leg/action.yml`. The Pages leg:

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

Website changes are selected and deployed only by `unified-release.yml`; a
merge to main does not deploy Pages. Website-only releases reuse the durable
helper channel and never build or assign a second helper version. A missing or
corrupt channel fails closed, preserving the existing Pages site; it never
falls back to checkout helper bytes or the dev machine.

No new binaries are committed to Git (#647). The served Pages site and Release
assets are independent of the dev machine and Actions artifact retention.
Build runners still run the existing release jobs; moving those runners is a
separate task from retiring the dev relay services.

## Consumer and verification contract

The manifest uses schemaVersion 1, with `sourceCommit`, `version`, and
`bundles["linux-x64"]`, `bundles["darwin-arm64"]`, and
`bundles["darwin-x64"]` entries containing `file`, `sha256`, `bytes`, `node`,
`commit`, `version`, and `verified: true`. Every bundle and the top-level identity
must match the unified release identity. Source commit is the helper's primary
comparison; the unified release's `vX.Y.Z` is the version fallback.

The verifier requires the exact expected manifest, checks every SHA sidecar,
and executes the production `SelfUpdateManager` in a disposable prefix seeded
with an older identity. It fetches and hashes the actual tarball, extracts it,
smoke-tests the CLI, activates the stable anchor, checks the installed identity,
and runs the installed `beeline --version`. Release bundle verification does not
pair, start a production daemon, or touch an existing helper. The older identity
is a fixture that forces a same-release redeploy through the real updater path,
not a claim of fleet restart. Release-time smoke proves the published package
and manifest. Fleet uptake is asynchronous post-release observability and never
blocks delivery.

The PR gate `MAC HELPER ACCEPTANCE` runs on the repository's self-hosted Intel
Mac. Its filter is the macOS-specific sources alone — never the run-everything
fallback — so an ordinary `apps/body`, shared-package, or unmapped-path change
never queues behind that one machine. It performs a fresh installer run,
exercises launchd crash restart and a bootout/bootstrap cycle
(the closest non-destructive CI equivalent to a logout/login), verifies the
terminal exit-status contract, pairs against the in-process monolith, observes a
Room answer, and exercises `open_corner` with the deterministic ACP fixture. The
native Apple-silicon bundle is proven only by the release's own `helper_macos`
leg, which runs the same installer/ACP/CodeGraph bundle proof on GitHub's hosted
arm64 Mac runner; no pull-request gate rebuilds it.

macOS has no bubblewrap namespaces. The helper therefore uses the existing
`bwrap`-unavailable fallback: it logs `harness OS sandbox UNAVAILABLE`, runs ACP
children without an OS-level filesystem sandbox, and relies on the permission
handler for the Room read-only rule. This is the same behavior as a Linux host
without a working `bwrap`; this release adds no substitute sandbox.

Having no bubblewrap also makes one product behavior reachable on macOS that a
Linux host with a working `bwrap` never sees: a granted command run in a
TOP-LEVEL Room is refused with `ROOM_SANDBOX_UNAVAILABLE`, because a Room run
is sandboxed or nothing (C94 fail-closed). Corner grants are unaffected — they
run on the host by design — so `run_granted_command` works in corners and
refuses in Rooms on every Mac.

Three supervision guarantees the Linux systemd unit provides have no launchd
counterpart, and are accepted platform gaps rather than omissions. Agent
stdout and stderr go to the single plain file
`~/Library/Logs/Beeline/agent-<key>.log` with no rotation and no size cap,
where Linux writes to the capped and rotated journal — a crash loop or months
of ordinary logging grow that file without bound, and pruning that file is the
operator's job. launchd has no `sd_notify` protocol, so the unit's
`Type=notify` plus `WatchdogSec=180s` recovery of a wedged-but-running daemon
does not exist on macOS: such a daemon stays up and silent until a human
restarts it. This release adds neither a rotating writer nor a watchdog.

And the helper is supervised in the per-GUI-session domain, `gui/<uid>`, not a
system domain: the LaunchAgent loads when that user LOGS IN, not at boot, and
`launchctl enable|bootstrap gui/<uid>/…` fails outright when no Aqua session
exists. So a Mac needs a real logged-in session — autologin on a headless Mac
mini, or a human at the keyboard — for `beeline connect`/`beeline start` to
install the job at all, and for the helper to come back after a reboot; over
SSH with nobody logged in, pairing reports `its daemon did not start` and there
is no non-launchd fallback. The `gui/` domain is deliberate, not incidental:
Trusty Squire drives a real Chrome in that session, and Linux's
`systemctl --user` carries the analogous `loginctl enable-linger` requirement.

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
  The retired bootstrap workflow used this command (historical evidence only;
  the workflow no longer exists):

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
