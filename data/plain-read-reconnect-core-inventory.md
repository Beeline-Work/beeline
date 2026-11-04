# Plain read socket inventory

The final `live-connection.ts` has **557 lines**. `apps/server/src/phone-operations.ts` has **328 lines**. Counts include comments and whitespace.

| Lines | Count | Section | Job |
| --- | ---: | --- | --- |
| 1–82 | 82 | Wire types and connection status | Describe requests and pushed events and expose connection state to status UI. |
| 83–124 | 42 | Connection ownership and identity | Hold one pending connection and attach foreground and sign-in/out callbacks. |
| 125–153 | 29 | Subscriptions | Tell the server which open Rooms receive pushes and release their subscriptions. |
| 154–175 | 22 | The read loop | Send a read, reconnect after failure, and stop after three attempts. |
| 176–206 | 31 | Write envelopes | Preserve immutable command identities and send each write once. |
| 207–276 | 70 | Request/reply exchange | Send requests, match replies by ID, and settle cancellation and the existing reply deadline. |
| 277–352 | 76 | Connection opening | Authorize and open the one socket, install its callbacks, and send pending requests. |
| 353–383 | 31 | Connection failure and Retry | Reject stranded requests and let the screen read own recovery without another retry allowance. |
| 384–410 | 27 | Foreground heartbeat | Ping after 30 seconds of foreground inactivity and detect a missing pong or already-closed native socket. |
| 411–467 | 57 | Open views and push listeners | Refcount open Rooms, prevent stale view releases, and register direct push/read observers. |
| 468–523 | 56 | Push switch | Deliver full pushed events and paint acknowledgements to the matching open screens. |
| 524–537 | 14 | Diagnostics and disposal | Report socket state and cancel owner-held work and listeners on disposal. |
| 538–557 | 20 | Shared production owner | Create one connection from the existing auth source and expose Retry/reset. |

Removed: the refresh scheduler and its queue, resource backoff/failure budgets, separate auth/handshake/open-socket recovery allowances, phone and server stream resumption, replay cursors and frame sequence deduplication, the network-change reconnect trigger, the timed draft/thought cache, recent-message cache/cap, paint-before-read barrier and subscription-read timer. A subscription reads current full draft state from the server; no transport draft cache or append reconstruction remains.

The one owner-held connection promise is necessary for the brief’s single-socket requirement when screens read concurrently; it has no retry budget. The identity counter prevents old authorization from opening a socket after sign-out. `viewEpoch` is retained solely because it is the check preventing an old screen release from hiding a new identity’s view of the same Room. Existing immutable write envelopes remain under the explicit instruction to preserve commands/writes.

The committed journal schema remains only for the separately authenticated MCP member stream (`apps/server/src/committed-journal-schema.ts`); phones no longer write or resume those streams. Shared membership locks also protect current helper effects and that MCP trust boundary. No phone read uses a certificate or authority epoch.
