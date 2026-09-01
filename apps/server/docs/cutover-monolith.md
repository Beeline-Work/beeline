# Monolith production cut runbook

This is the operator companion to `scripts/cutover-monolith.sh`. The script is the execution authority: every phase is a function, every mutation is followed by a verification command, and any failed check stops the cut. Re-running it against the same target resumes recorded idempotent actions and repeats the safety checks.

## Inputs

Use a protected shell and files with mode `0600`. Do not paste exchange, phone, database, or device tokens into logs or the PR.

Required base values:

```bash
export DATABASE_URL='postgresql://...target-neon...'
export OLD_DATABASE_URL='postgresql://...frozen-old-postgres...'
export OLD_PUSH_REGISTRY_JSON='/secure/registrations.json'
export DAEMON_EXCHANGE_MANIFEST='/secure/daemon-exchanges.json'
export CUTOVER_ACK='FORWARD_ONLY_AFTER_REOPEN'
```

The deployed monolith must set `PHONE_GITHUB_EXCHANGE_ENDPOINT` to the deployed auth service's `POST /auth/github/phone-exchange` route. That route consumes the existing one-use GitHub ticket; the phone and monolith must never exchange a raw GitHub token.

The daemon manifest is an array of `{ "agentId", "runtimePath", "exchangeToken" }`. Each exchange is generated before maintenance with `TokenAuth.createDaemonExchange(agentId)`. The staging phase verifies the runtime's stored public key, writes the single `transport.kind = "monolith"` switch atomically, and never logs a token. On restart, Body exchanges `bde_` once and atomically persists `bdt_` in that same runtime record.

Set these site-specific commands. Each verify command must exit nonzero until the stated fact is true:

| Variable                            | Exact responsibility                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CUTOVER_PHONE_AUTH_VERIFY_COMMAND` | Mint a bounded test ticket at the deployed auth service, exchange it through monolith `POST /v1/auth/github/exchange`, and prove ticket reuse fails. Also verify the deployment's `PHONE_GITHUB_EXCHANGE_ENDPOINT` names the production auth origin. |
| `CUTOVER_DRAIN_COMMAND`             | Stop admission of new old-stack turns and gracefully drain daemons.                                                                                                                                                                                  |
| `CUTOVER_DRAIN_VERIFY_COMMAND`      | Query old supervision and exit zero only when active turns are zero.                                                                                                                                                                                 |
| `CUTOVER_FREEZE_COMMAND`            | Put the old write API in maintenance/read-only mode.                                                                                                                                                                                                 |
| `CUTOVER_FREEZE_VERIFY_COMMAND`     | Prove an old write is rejected while an old read still succeeds.                                                                                                                                                                                     |
| `CUTOVER_DAEMON_RESTART_COMMAND`    | Gracefully restart every staged daemon runtime.                                                                                                                                                                                                      |
| `CUTOVER_DAEMON_VERIFY_COMMAND`     | Verify every manifest runtime contains `transport.daemonToken`, contains no `exchangeToken`, and can call `getDaemonBootstrap`.                                                                                                                      |
| `CUTOVER_OTA_FLIP_COMMAND`          | Promote the already-built cut OTA from the mobile lane.                                                                                                                                                                                              |
| `CUTOVER_OTA_VERIFY_COMMAND`        | Require the owner device's production-delivery receipt for that exact OTA.                                                                                                                                                                           |
| `CUTOVER_E2E_VERIFY_COMMAND`        | Run one real production flow: phone send, daemon working receipt, daemon reply, authenticated Room read containing both messages, WebSocket invalidation, and a delivered `push_delivery_claims` row for the test device.                            |
| `CUTOVER_REOPEN_COMMAND`            | Enable writes on the monolith only.                                                                                                                                                                                                                  |
| `CUTOVER_REOPEN_VERIFY_COMMAND`     | Prove a bounded monolith write succeeds and the old API remains read-only.                                                                                                                                                                           |

The production implementations live in `scripts/cutover-hooks/`. Copy
`cutover.env.template` to a mode-0600 file outside the repository, replace its
placeholders, and source it from the protected operator shell. Before the cut,
build `@beeline/server` from the deployed release checkout and run
`scripts/cutover-hooks/generate-daemon-manifest.sh`; it validates both v2
runtimes before calling `TokenAuth.createDaemonExchange` and refuses to replace
an existing protected manifest.

The import calls `npm run import -w @beeline/server` with `DATABASE_URL` as the target. It deliberately does not pass `--include-media`; the report must say `mediaBytes: 0` and fit the Neon limit.

## Execute

```bash
scripts/cutover-monolith.sh --execute --target-origin https://server.usebeeline.app
```

The ordered phases are fixed: preflight, drain, freeze, final repeatable-read snapshot/import, daemon token and OTA flip, production end-to-end verification, then reopen. Do not manually skip ahead. The script records only phase names under `.cutover-state/`; credentials and command output are never written there.

The production default and enforced execute target is `https://server.usebeeline.app`. A different origin is accepted only by `--rehearse`; this keeps scratch targets explicit without permitting a production cut toward the retired Fly hostname.

## Rehearse

Point the same script at a scratch server and scratch `DATABASE_URL`. The target origin is always explicit, so a rehearsal cannot silently fall back to production:

```bash
export DATABASE_URL='postgresql:///beeline_cutover_rehearsal'
export CUTOVER_IMPORT_COMMAND='npm test -w @beeline/server -- --run src/importer.test.ts'
# Set every lifecycle hook to the local harness command documented by the rehearsal.
scripts/cutover-monolith.sh --rehearse --target-origin http://127.0.0.1:43123
```

Keep the complete transcript as PR evidence. A valid rehearsal reaches the final `rehearse completed` line, imports zero media, promotes a real one-use daemon exchange against the local server harness, and passes the end-to-end operation test.

## Rollback boundary

Before `reopen`, rollback may re-point daemon runtime records and the phone OTA to the old stack:

```bash
scripts/cutover-monolith.sh --rollback --target-origin https://server.usebeeline.app
```

Set `CUTOVER_ROLLBACK_DAEMONS_COMMAND`, `CUTOVER_ROLLBACK_OTA_COMMAND`, and `CUTOVER_ROLLBACK_VERIFY_COMMAND` first. The daemon rollback command removes the staged `transport` object; it never invents or reuses a consumed exchange token.

**After writes reopen, rollback is forward-only. Never point a writer at the old snapshot. Doing so creates two histories and loses acknowledged user work. Fix or redeploy the monolith instead.**
