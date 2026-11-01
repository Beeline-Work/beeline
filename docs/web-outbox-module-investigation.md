# Web outbox module startup

[Sentry BEELINE-MOBILE-V (7822661032)](https://beeline-bt.sentry.io/issues/7822661032/)
reported an unhandled rejection while the corner route was open. The affected
release is `fd32b59f44757677d78190529557517a4acec582`.

## Failed boundary

The exact release artifact, downloaded from Sentry's uploaded artifact bundle
`82d56f72-e719-5dba-87d8-03f966624586`, identifies module `3446` as
`message-outbox-runtime`. The signed-in root layout (module `1944`) starts it
with a dynamic import in its mount effect. Its dependency map points to
`message-outbox-runtime-1055faba7e9a6807d1dc3ac73a9232dc.js`.
The separate chunk defines module `3446`; the entry bundle does not.

Expo's async require waits for the script loader and then calls Metro
`importAll(3446)`. The reported stack fails at that latter step: the module
has not registered. This is the outbox startup boundary, not NetInfo or a
corner-specific route module. The event does not identify why registration
failed or establish whether a deployment, cache, or script execution caused it.

A read of the old chunk URL on the current canonical origin returned the HTML
app shell rather than JavaScript. The old entry URL also returned HTML. This
shows that the current origin cannot supply those old chunks; it does not prove
what the originating browser received. The existing stale-chunk recovery and
asset guard have separate coverage and are unchanged here.

## Reproduction WEB-OUTBOX-3446

The originating browser/cache is unavailable. A read-only browser attempt at
the corner route rendered its Corners screen and empty state, without a visible
missing-module failure. Current production identifies itself as `v0.1.129`,
source `73678f627f5632dfb93825f0f24b96de564788db`, rather than the affected release.

The isolated exported-bundle stand-in mounts the affected layout using the
actual release factory and Metro runtime. React effects and transport/storage
are bounded substitutes. It lets a lazy script load settle without registering
the requested module, reproducing the recorded boundary:

- Affected layout: one lazy request, unhandled `Requiring unknown module "3446".`,
  and no persisted outbox restoration.
- Control with the exact valid chunk: outbox restoration succeeds.
- Current source layout: outbox restoration succeeds with no lazy request and
  no unhandled rejection under the same unavailable-lazy-chunk condition.

The fix imports the required delivery runtime statically, while keeping startup
in the same mount effect. This includes the runtime in the boot dependency
graph, removing the unnecessary split-bundle failure boundary for every
signed-in route. It does not suppress an error or change global chunk loading.

Run from the repository root, with the downloaded entry/chunk and runtime:

```sh
node apps/mobile/scripts/outbox-startup-bundle-proof.mjs \
  /tmp/beeline-exact-release/index-c867085eeacaa12912221cd27b64b686.js \
  /tmp/beeline-exact-release/message-outbox-runtime-1055faba7e9a6807d1dc3ac73a9232dc.js \
  /tmp/beeline-bundles/__expo-metro-runtime-1f8f5d3ca6b7f58204d51e14506d73fb.js
```

These private artifact downloads are not committed. Their SHA-256 values are:

| File | SHA-256 |
| --- | --- |
| Affected entry | `48583a1eb028df14623e541cf649ae6c34369b156a13fd3031600ecdeaf6ccd2` |
| Affected outbox chunk | `e4eeec93ccaf999e696e7b5dfa83c828e65e9f7f376c67d268eb9fecfd39cbdf` |
| Metro runtime (same hashed filename as affected release) | `590c633c0c8089c19dfbecca7c68e91156d04b80391eaa845d47e76441ed9821` |

Sentry's default API credential lacked project scope; the owner-provisioned
alert credential read the event and artifact metadata. The sealed API route
could not return binary artifact downloads (`unsupported_response_type`).
The signed-in browser downloaded the exact JavaScript instead. No credential
was exposed, and no release or Sentry issue state was changed.

## Validation

- `WEB-OUTBOX-3446` passes for the changed layout. Supplying the original layout
  as the script's optional fourth argument fails the fixed-path assertion:
  restoration remains absent and the same unknown-module rejection returns.
- `npx expo export --platform web --output-dir /tmp/beeline-outbox-web --max-workers 2`
  succeeds. Its boot entry `index-5f367b451cb5589dc811be585f4168f5.js` defines the
  outbox as module `2259`, and root layout `1944` depends on it synchronously.
  There is no outbox entry in the layout's split paths and no separate outbox
  chunk in this export.
- Mobile typecheck passes. The persisted outbox and runtime reconnect suites
  pass (seven tests). The first concurrent runtime test hit its default timeout;
  a single-worker rerun with a longer timeout passed in under four seconds.
