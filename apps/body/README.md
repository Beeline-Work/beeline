# @beeline/body

The Beeline helper is a thin client that turns Room mentions into agent replies.

It keeps only four responsibilities:

1. connect an app-authorized agent and store its monolith daemon credential;
2. supervise one read-only Room loop per active Room;
3. run the selected ACP harness with isolated home/sandbox state;
4. self-update with a functional session-and-turn probe.

Room data and writes go through `DaemonApiClient`. The helper has no relay transport, pairing-code
redemption, corner/action tools, approval or mandate engine, work calendar, repository lifecycle,
or GitHub event consumer.

## Commands

- `beeline connect [code]`
- `beeline connect-finish <grant>`
- `beeline start [--agent <pubkey>]`
- `beeline stop --agent <pubkey>`
- `beeline daemon --config <runtime.json>`
- `beeline update ...`
- `beeline --version`

## Development

```sh
npm run typecheck -w @beeline/body
npm run build -w @beeline/body
npm test -w @beeline/body
```

The end-to-end monolith proof is `src/daemon-api-client.integration.test.ts`. It starts the real
server surface, completes device pairing, exchanges the daemon credential, delivers a human
mention, and verifies the agent reply in the Room read model.
