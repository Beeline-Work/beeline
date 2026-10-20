# @beeline/buzz-client

Signing helpers, shared contracts and mobile client utilities for Beeline.
The app's `MonolithRigTransport` implements the compatibility `BuzzClient` type;
app commands and live updates use the authenticated Beeline server.

- `identity.ts` and the permission modules construct and verify signed data with
  `@beeline/nostr`.
- `room-view.ts` provides validated server-backed surface reads. DTOs and guards
  come from `@beeline/api-contract/phone`.
- Surface caches hold committed responses; live events invalidate surfaces or
  deliver committed deltas. They never reconstruct durable state on the client.
- `signed-event-outbox.ts` preserves exact signed requests across retries.
- `channel.ts`, `room-repository.ts`, `query.ts` and the read-only HTTP helper
  retain the signed compatibility reads used by the auth service's Room-token
  authority. The mobile app does not use these as a write transport.

The package name and signed wire tags retain their historical `buzz` spelling.

```sh
npm run build
npm run typecheck
npm test
```

The test suite is hermetic. The removed development stack has no live-test path.
