# Production monolith cutover hooks

These scripts implement every site-specific hook required by
`apps/server/docs/cutover-monolith.md`. They are operator tools, not CI jobs.
Nothing here should be run during review against production.

1. Copy `cutover.env.template` to a protected path, replace every placeholder,
   and `chmod 0600` it and every referenced credential/config file.
2. Build `@beeline/server` from the exact deployed release checkout, then run
   `generate-daemon-manifest.sh` before maintenance. It calls that release's
   `TokenAuth.createDaemonExchange` once per checked runtime and writes only a
   mode-0600 manifest.
3. The cut OTA is a beta candidate built at `CUTOVER_CUT_SHA` with
   the checked-in `buzzyMonolithEnabled = true` production switch plus the
   stated release version/SHA. `ota-flip` rejects any SHA without that exact
   source fact and uses the existing
   `ota-release.mjs promote` path to republish that exact group to production;
   `ota-verify` requires a matching physical owner-device receipt.
4. Source the protected environment and run `scripts/cutover-monolith.sh`.

`phone-auth-verify`, the systemd lifecycle actions, nginx reload, EAS
promotion/rollback, owner-device receipt, and production E2E probe are live-only
proofs. Review validation is limited to syntax, ShellCheck, unit tests, nginx
configuration parsing with a temporary local harness, and OTA dry-run tests.

The old-stack freeze is reversible before reopen: rollback restores daemon
runtimes, republishes the ledger's previous production OTA group, removes the
nginx freeze, and proves the old RoomView and bounded signed write both work.
After reopen, `cutover-monolith.sh` refuses rollback.
