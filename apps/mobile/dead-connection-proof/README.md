# Dead pooled connection proof (R1, R2)

Reproduces a phone whose open connections went silently dead. After a lost NAT
mapping (sleep, a network change), packets on the old connections vanish and
nothing closes them. New connections still work.

    phone → relay.mjs :8444 → front.mjs :8443 (TLS, HTTP/2) → local monolith :8080

- `front.mjs` serves the local monolith the way Fly serves the phone: TLS with
  HTTP/2, and HTTP/1.1 for the WebSocket upgrade.
- `relay.mjs` is the phone's network path. `POST :8445/silence` stops every open
  connection in both directions without closing it. `POST :8445/silence?down`
  drops only the server's replies, so the request still reaches the server.
- `build.sh` builds a release APK that points at `https://10.0.2.2:8444` and
  trusts one throwaway CA. It is never a store build.
- `ui.py` finds, taps and screenshots controls over adb.

## Setup

1. Put `ca.pem`, `server.pem` and `server.key` in `.local/`. The server
   certificate needs `subjectAltName=IP:10.0.2.2,IP:127.0.0.1`.
2. Start the local monolith with `scripts/latency-rig/run-local.sh` and a local
   review secret.
3. Run `node front.mjs` and `node relay.mjs`, then `bash build.sh`.
4. Install the APK and open `beeline://review/<secret>`.

## Reproduction R1: Retry stuck

On the Room list, `curl -XPOST 127.0.0.1:8445/silence`, pull to refresh, and
tap Retry on "Couldn't reach Beeline".

- **Before:** the row is still there 60 s later. The server receives no HTTP
  request after the silence, even after the live socket reconnects.
- **After:** HTTP/2 pings close the dead connection, and the refresh answers on
  a fresh one about 7.5 s after the silence. No error row appears. With the
  server stopped and then restarted, Retry dims while it reads and clears the
  row within 2.5 s.

## Reproduction R2: a stored message shown as not sent

In a Room, `curl -XPOST '127.0.0.1:8445/silence?down'`, send a message, then
go back to the Room list.

- **Before:** "Message not sent" opens on the Room list 12 s later, although
  the database already holds the message.
- **After:** the send repeats on a fresh connection about 2 s later. The server
  deduplicates it by message id, so the database holds exactly one row and no
  alert appears.

Screenshots are in `docs/evidence/phone-dead-connection/`.
