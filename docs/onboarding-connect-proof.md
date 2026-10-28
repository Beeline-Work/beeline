# Onboarding connect proof (28 October 2026)

The hosted service-manager and cold-broker failures now pass an isolated Fly installation proof. This work remains incomplete: the PR stays draft until a fresh Beeline test account completes provider sign-in and a real Squire app connects.

## Reproduction onboarding-connect-1

The closest isolated stand-in uses the built HTTP service, PGlite storage and fixture providers. Run `npm run build -w @beeline/server`, then `node --import tsx scripts/prove-connect-flow.mjs`.

Before the change, the HTTP `connect` operation for `grok` creates a `squire-api` app and returns unavailable with a Squire instruction. The proof fails because the result's app is `grok`, rather than `Beeline Rooms`.

After the change, the same HTTP path for Grok and Meta Muse returns the Beeline Rooms URL and consent/member steps, without an app row. TikTok returns unavailable pending approval without a sign-in card. Repeated Shopify setup returns one Trusty Squire offer, which is also visible through the built phone Room reader. The existing Link sign-in, callback and request-resumption proof still passes. Providers are fixtures; no real TikTok approval or Shopify sign-in is claimed.

The integration suites cover all assistant aliases, real app names, Shopify before and after a fixture Squire install and vault report, and hosted helper visibility. YouTube/Stripe official-publisher regressions remain in the app suite.

## Reproduction hosted-squire-install-1

Read-only production inspection found Luna's machine `185d270c3191e8` suspended with a shared CPU and (2048 MiB) memory. The Beeline machine ID is `1f633752-09ef-425d-875c-b958e5e51c6c`. Its Squire work generation (5) records helper reached, install failed, and `run_failed`; its broker report is `not-added`.

Fly's per-instance logs for the reported period show dead Squire connect-session claims at 17:25:01, 17:27:09 and 17:27:29 UTC. The logs do not contain the underlying installer exception. The GraphQL App object has no `logs` field; the working read route is the Fly REST per-app logs endpoint with the instance filter. No production install or account changes were made.

The isolated hosted-image stand-in invokes the published Squire package's actual `installBrokerService`, which `connect --json` calls before opening sign-in. The current package is `@trusty-squire/mcp` (1.1.37). Its source was inspected before invocation. With dependencies installed in a private container capped to the hosted memory/CPU size, it fails:

```
Broker user service failed (systemctl --user show --type=service --all
--no-pager -p Id -p ActiveState -p Environment -p ExecStart):
spawnSync systemctl ENOENT. A working systemctl user manager is required;
no direct broker fallback was attempted
```

The original hosted image installed neither systemd nor a user manager. The Squire package deliberately requires an OS-managed broker. A Docker attempt with a read-only cgroup tree also failed; tracing showed the manager could not create its cgroup. A private writable cgroup tree supports the real manager. Fly already provides its own writable guest cgroup tree.

### Passing hosted installation path

The image now includes a real systemd user manager, dbus, Chrome, Xvfb, noVNC, cloudflared and the published Squire package (1.1.37). Boot starts only the user manager. When hosted installation is requested, Beeline starts the one image-owned broker and waits for both of its sockets before invoking connect. This also avoids Squire's shorter cold-start deadline. Owners' own computers keep their existing path.

A disposable Fly VM (`8045e9c66232d8`, one shared CPU, 2048 MiB) started from the production image with no owner/bootstrap environment. Installing the new image dependencies and exact broker unit there, then running a bundle of the modified Beeline `installSquire`, returned `status: installing`, `hasSignIn: true`, `placement: virtual`. The streamed result exposed the provider sign-in in the hosted Chrome page. A local Squire session opened that remote page for human control. This is a real Fly install and browser handoff, but not a fresh Beeline test account or a completed provider login.

Reproducible build: `docker build --target hosted-services -t hosted-squire-proof -f infra/free-agent/Dockerfile .`. Bundle `infra/free-agent/hosted-install-proof.mjs` with esbuild and copy it into a disposable VM/container. Start `/opt/beeline/hosted-services.sh` with the image's runtime environment, then run the bundle with `BEELINE_HOSTED_SERVICES=1`. Docker requires a private writable cgroup namespace; ordinary read-only Docker cgroups do not model Fly. The proof prints only status/step metadata, never the sign-in URL or browser password.

### Isolation and resources

Each free agent gets a separate Fly VM and private persistent rootfs (`FlyMachines.create`), without shared profile volumes. The image copies only executable packages and helper artifacts, never Squire accounts, cookies or sessions. A marker written inside the proof VM's Chrome profile was absent from a second fresh VM (`82e0d0a7e95658`) using the same base image. The peer VM was deleted after that assertion. This verifies guest filesystem separation, not a completed two-account vault exercise.

During the hosted sign-in page: available memory (1061 MiB), anonymous pages (635 MiB), OOM kills (zero). Disk used (1635 MiB of 7964 MiB); Chrome (446 MiB), Squire package (135 MiB), browser/profile state (79 MiB), noVNC assets (2 MiB). The VM did not also run a free-agent model turn, so peak combined memory remains unverified.

The main proof VM remains temporary while its provider sign-in awaits human completion; delete it when the handoff finishes. No production user machine or another user's profile/vault was opened. Fresh Beeline account setup, completed phone login, Shopify connection and full account-level isolation remain outstanding.

## Browser observation

Trusty Squire drove the live web app through Settings > Connectors > Trusty Squire in an existing owner session. The computer list was visible. This was not the GitHub reviewer bypass account and not a local/preview build, so it does not prove the modified helper list or the phone-only story. The browser session was closed.

## Completed local checks

- `npm run corner:prepare` passed.
- Root `npm run typecheck` passed, including mobile and scripts.
- App connections and Workbench integration suites passed (160 tests; one pre-existing skip).
- Built `scripts/prove-connect-flow.mjs` passed, including the phone-visible Squire offer.
- `git diff --check` passed.

- Hosted body connector tests passed (52), including real socket-readiness coverage.
- Hosted-services image stage built successfully; shellcheck passed for both entrypoint scripts.
