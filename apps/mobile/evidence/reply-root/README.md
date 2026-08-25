# Production threaded-reply proof

Captured on 2026-08-25 with the logged-in `buzzy_api36` Android emulator in the production Room `release-proof-mt8tnim3` on `relay.usebeeline.app`.

The thread was created as `release history 238` → `Prefixtest-parent` → `prefixtest-child`. An unrelated live message, `prefixtest-noise`, then reproduced the incremental read-model update that lost the child's original root.

- `production-before-400.png`: the existing production build attempts `prefixtest-grandchild-before` as a reply to `prefixtest-child`; the relay rejects it with `HTTP 400 {"error":"invalid: root tag does not match thread ancestry"}`.
- `production-after-sent.png`: after rebuilding the root SDK packages and installing the fixed release APK, the same reply gesture against `prefixtest-child` publishes `prefixtest-grandchild-after` and `prefixtest-grandchild-after2`. The awaited publish completed without a send alert or any `publishEvent kind=9`, `HTTP 400`, `root tag`, or `Send failed` log.

The regression test in `buzz-rig-transport.test.ts` asserts the exact NIP-10 proof: a reply to message B in the existing R → A → B thread publishes `root = R` and `reply = B`.
