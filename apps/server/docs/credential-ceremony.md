# Phone and daemon token ceremony

This document defines Phase C's credential transition. Phase B implements and tests the boundaries but does not run the ceremony.

## Phone

1. The cutover OTA keeps the existing signed identity long enough to complete the existing GitHub identity flow.
2. The phone gives the resulting one-use GitHub bind ticket to `POST /v1/auth/github/exchange`. The monolith uses the mounted `@beeline/auth` verifier to atomically consume the short-lived ticket from its own database. No raw GitHub token crosses or is stored by the phone or monolith. The phone receives a 15-minute access token plus a rotating 30-day refresh token.
3. The refresh token is stored in SecureStore. Access tokens remain memory-only. Each refresh consumes the previous refresh token; reuse invalidates the whole token family.
4. The owner-device OTA receipt must show the cutover build before the maintenance cut proceeds. A phone without a refresh token sees one GitHub sign-in, not an empty Room list.
5. Only after the complete final-import smoke flow passes may the old phone key be retired. This is a forward-only data-format cut; the old snapshot is forensic recovery, not a post-cut write target.

The new server must receive the same GitHub OAuth client secret used by the old auth service for the first cutover boot. Imported GitHub user tokens use the existing AES-GCM envelope derived from that secret; changing it first would make personal-repository creation and installation ownership checks unreadable until every owner reauthorizes.

## Daemon

1. Before maintenance, an owner-authorized operator creates one short-lived exchange token for each existing agent ID with `TokenAuth.createDaemonExchange`.
2. The daemon calls `POST /v1/auth/daemon/exchange` once. The server atomically consumes the exchange and returns one opaque `bdt_` token.
3. The runtime writes `{agentId, token}` only after the exchange response is durable. A repeated exchange is rejected. Restarting the daemon reuses the opaque token and proves persistence without either old Nostr secret.
4. Server storage contains only SHA-256 token digests. Revocation sets `daemon_tokens.revoked_at`; stale or revoked tokens return 401 and never expose partial operation results.
5. Every daemon operation verifies that any input `agentId` equals the token's agent. Room operations separately require current room membership.

## Push

The importer joins registry pubkeys to the same stable identity IDs and inserts devices plus OTA receipts into PostgreSQL. A phone may re-register the same device token: the unique token row moves atomically to the current identity. Push delivery claims are unique by `(message_id, device_token)`, so advisory-lock failover cannot duplicate a delivery attempt.

## Phase C verification

Before writes reopen, prove: phone refresh, daemon restart, one phone send, daemon receipt/prompt/reply, WebSocket paint, one push claim, one media open, and one bounded GitHub room token. No endpoint accepts an old signed event after the cut.
