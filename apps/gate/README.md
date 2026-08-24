# `@beeline/gate`

Phase-0 merge-gate library and the signed-approval worker. Talks to a real
Buzz relay (see `relay-stack/` at the repo root) — no fake backend.

## Layout

| Path                              | Role                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/approval.ts`                 | Schnorr-signed merge-approval events + exact-binding verify                                      |
| `src/worker.ts`                   | Durable Room gate: discovers feature branches and lands only exact-tip human-admin approvals     |
| `src/agent-identity.ts`           | Identity-level lookup: a self-declared agent key can never approve a merge, regardless of role   |
| `src/buzz.ts`                     | Channel/community create, role set, repo announce (kind 9007 / 9000 / 30617)                     |
| `src/provisioning.ts`             | **Provisioning check** — agent must never be in push-allowed on the protected branch             |
| `src/push-rights.live.test.ts`    | Live security suite (relay-enforced push rejection + provisioning check)                         |
| `src/agent-identity.live.test.ts` | Money-shot #2: registered agent approval refused; human admin approval for the same tip accepted |
| `src/approval.test.ts`            | Hermetic unit tests for the approval gate                                                        |

## Scripts

```sh
# From apps/gate (or via turbo filters):
npm test              # hermetic unit tests only (no relay required)
npm run test:live     # live security suite against the real relay
                      # (pretest:live builds @beeline/nostr so a fresh clone works)
npm run typecheck
npm run worker -- <config.json>
```

The worker config is repository/Room-scoped, never change-scoped:

```json
{
  "workerSecretKeyHex": "...",
  "ownerHex": "...",
  "repo": "project",
  "channelId": "room-uuid",
  "targetBranch": "main"
}
```

It runs until stopped, discovers agent-authored `body-control` change records,
and delegates every approval to the same exact-tip, human-admin, agent-refusal
enforcement used by `attemptMerge`.

From the **repo root**, the one-shot end-to-end proof is still:

```sh
npm run stack:up      # start the isolated Buzz relay on 127.0.0.1:3010
npm run prove         # scripts/money-shot.ts — full gate composition
```

## Live security suite

The two tests the product spec mandates under
**Failure modes → each needs a test → "Agent in push-rights"**:

1. An unauthorized agent push to protected `main` is **rejected by the relay**,
   and `main`'s tip is byte-identical before/after (`ls-remote`).
2. The provisioning check passes on a correctly provisioned channel+repo
   (agent = member) and **fails** when the agent is deliberately mis-granted
   admin.
3. A registered agent key is deliberately configured as channel admin and
   trusted reviewer; its corner approval is **refused by identity**, then a
   human admin approval for the same feature tip is accepted.

```sh
# 1. Start the relay stack (once) from the monorepo root:
npm run stack:up

# 2. Run the live suite:
cd apps/gate && npm run test:live
```

If the relay is unreachable, `test:live` soft-skips with a clear message and
exits 0. When the relay **is** reachable the suite always runs for real — it
never auto-skips a green path.

The community live proof uses the same relay conventions: a community is a
kind:9007 stream group whose `community` tag self-references its `h` UUID, its
owner/member roles project through kind:39002, and contained channels point to
that UUID with the same tag. The suite proves invite mint and redemption with
two independent Nostr identities.

### Provisioning check (library + CLI)

```ts
import { checkAgentNotPushAllowed, createRelayClient } from '@beeline/gate';

const result = await checkAgentNotPushAllowed({
  ownerHex,
  repo,
  agentPubkey,
  relay: createRelayClient(agentIdentity),
});
// result.ok === true  → agent cannot push the protected branch
// result.ok === false → MISCONFIG; do not trust this channel+repo
```

CLI (exit 0 pass / 1 fail):

```sh
BUZZY_QUERY_NSEC=nsec1... node --import tsx src/provisioning.ts <ownerHex> <repo> <agentPubkey>
```

## Env

| Variable             | Default                | Meaning                                                       |
| -------------------- | ---------------------- | ------------------------------------------------------------- |
| `BUZZY_RELAY_HOST`   | `usebeeline.app` | Relay Host header + authority; `relay.buzzrouter.com` stays an alias and live tests pin the local stack |
| `BUZZY_RELAY_SCHEME` | `https`                | Relay HTTP scheme; live tests pin `http`                      |
| `BUZZY_QUERY_NSEC`   | —                      | Signing key for provisioning CLI NIP-98 relay reads           |
