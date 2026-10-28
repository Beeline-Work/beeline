# Onboarding connect proof (28 October 2026)

This work is incomplete: the hosted Squire install is not fixed. The pull request stays draft until the hosted install, phone sign-in, app connection, isolation and resource proofs pass.

## Reproduction onboarding-connect-1

The closest isolated stand-in uses the built HTTP service, PGlite storage and fixture providers. Run `npm run build -w @beeline/server`, then `node --import tsx scripts/prove-connect-flow.mjs`.

Before the change, the HTTP `connect` operation for `grok` creates a `squire-api` app and returns unavailable with a Squire instruction. The proof fails because the result's app is `grok`, rather than `Beeline Rooms`.

After the change, the same HTTP path for Grok and Meta Muse returns the Beeline Rooms URL and consent/member steps, without an app row. TikTok returns unavailable pending approval without a sign-in card. Repeated Shopify setup returns one Trusty Squire offer, which is also visible through the built phone Room reader. The existing Link sign-in, callback and request-resumption proof still passes. Providers are fixtures; no real TikTok approval or Shopify sign-in is claimed.

The integration suites cover all assistant aliases, real app names, Shopify before and after a fixture Squire install and vault report, and hosted helper visibility. YouTube/Stripe official-publisher regressions remain in the app suite.

## Reproduction hosted-squire-install-1 (still failing)

Read-only production inspection found Luna's machine `185d270c3191e8` suspended with a shared CPU and (2048 MiB) memory. The Beeline machine ID is `1f633752-09ef-425d-875c-b958e5e51c6c`. Its Squire work generation (5) records helper reached, install failed, and `run_failed`; its broker report is `not-added`.

Fly's per-instance logs for the reported period show dead Squire connect-session claims at 17:25:01, 17:27:09 and 17:27:29 UTC. The logs do not contain the underlying installer exception. The GraphQL App object has no `logs` field; the working read route is the Fly REST per-app logs endpoint with the instance filter. No production install or account changes were made.

The isolated hosted-image stand-in invokes the published Squire package's actual `installBrokerService`, which `connect --json` calls before opening sign-in. The current package is `@trusty-squire/mcp` (1.1.37). Its source was inspected before invocation. With dependencies installed in a private container capped to the hosted memory/CPU size, it fails:

```
Broker user service failed (systemctl --user show --type=service --all
--no-pager -p Id -p ActiveState -p Environment -p ExecStart):
spawnSync systemctl ENOENT. A working systemctl user manager is required;
no direct broker fallback was attempted
```

The repository's hosted image installs neither systemd nor a user manager. The Squire package deliberately requires an OS-managed broker; changing Beeline routing cannot repair that requirement. A second disposable container installed systemd and dbus-user-session, but starting a user manager did not produce a usable session bus. Installing the binary alone is insufficient. This is the first locally reproduced blocker, not a claim that production exposed that exact exception.

The disposable containers and the derived dependency image were removed. No other user's Squire profile, cookies or vault was opened. A successful hosted Chrome run, its memory/disk footprint, fresh-account phone sign-in, Shopify connection and cross-owner isolation proof have not been obtained.

## Browser observation

Trusty Squire drove the live web app through Settings > Connectors > Trusty Squire in an existing owner session. The computer list was visible. This was not the GitHub reviewer bypass account and not a local/preview build, so it does not prove the modified helper list or the phone-only story. The browser session was closed.

## Completed local checks

- `npm run corner:prepare` passed.
- Root `npm run typecheck` passed, including mobile and scripts.
- App connections and Workbench integration suites passed (160 tests; one pre-existing skip).
- Built `scripts/prove-connect-flow.mjs` passed, including the phone-visible Squire offer.
- `git diff --check` passed.
