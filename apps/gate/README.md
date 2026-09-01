# `@beeline/gate`

Shared relay, repository, provisioning, and factory-permission primitives for
Beeline services. It talks to the Beeline relay (see `relay-stack/` at the repo
root); it does not own corner review or landing.

## Layout

| Path                        | Role                                                                |
| --------------------------- | ------------------------------------------------------------------- |
| `src/buzz.ts`               | Channel/community creation, roles, and repository announcements     |
| `src/git.ts`                | Bounded Git process helpers used by daemon-side repository code     |
| `src/provisioning.ts`       | Agent and Room provisioning checks                                  |
| `src/human-authority.ts`    | Human custody and current-role verification for factory permissions |
| `src/permission-request.ts` | Signed factory-permission requests and receipts                     |
| `src/relay.ts`              | Signed HTTP relay reader and publisher                              |

Corner agents receive a Room-scoped GitHub App installation token from Body and
use ordinary `git` and `gh` commands. GitHub branch and pull-request state is the
lifecycle authority; this package has no approval worker or protected-ref
landing engine.

## Scripts

```sh
# From apps/gate (or via turbo filters):
npm test
npm run test:live
npm run typecheck
```

The live suite uses the isolated stack on `127.0.0.1:3010`. If that relay is
unreachable it soft-skips with a clear message; when reachable it always runs.

```sh
npm run stack:up
cd apps/gate && npm run test:live
```

## Environment

| Variable             | Default          | Meaning                                       |
| -------------------- | ---------------- | --------------------------------------------- |
| `BUZZY_RELAY_HOST`   | `usebeeline.app` | Relay Host header and HTTP/WS authority       |
| `BUZZY_RELAY_SCHEME` | `https`          | Relay HTTP scheme                             |
| `BUZZY_QUERY_NSEC`   | —                | Signing key for authenticated CLI relay reads |

Set `BUZZY_RELAY_HOST=127.0.0.1:3010`, `BUZZY_RELAY_SCHEME=http`,
`BUZZY_RELAY_URL=http://127.0.0.1:3010`, and
`BUZZ_RELAY_URL=ws://127.0.0.1:3010` before importing the package for local
stack work.
