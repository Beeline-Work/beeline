# Current candidate on historical-source Android runtime 40

This is a **historical-source locally built APK**, not the Play-distributed binary. Firstmate instruction036 authorizes this cohort substitute when the retained release artifact has expired. No production account, Workspace, service or provider was used.

The matching [release run](https://github.com/Beeline-Work/beeline/actions/runs/40028613502) built native runtime40 at commit `62a2695724540f2a300bb2f06fd9994fd72ab713`, published Android versionCode138, and uploaded artifact12533408754 with one-day retention. Its exact artifact lookup now returns404. The existing historical-source APK hash is recorded in [provenance](provenance.json).

Current checkout `b1b8ea125` supplied the production JavaScript modules. The candidate launched seven times with runtime40, no emergency/embedded fallback, and zero failed native launches. Delivery was through the isolated emulator's local updates database; this is not an OTA-delivery proof. The first cache probe encountered disconnected guest Wi-Fi; after connecting the guest to its private emulator network, a separate launch passed. No application retry was introduced.

[Measurements](measurements.json) contain the actual native events and browser-server trace. Assertions passed for one shared download across three consumers, local cold restore and image rendering, maximum four concurrent byte requests, disk residency below128MiB, oversized-entry refusal, eviction, cancellation without staging files, offset views, and independent SHA-256 comparison. The25MiB read took460ms and digest83ms. Measured frame gaps were270ms cold and22ms warm; these are emulator observations, not physical-phone latency acceptance.

The inert document rendered with zero forbidden endpoint requests. PDF rendering signaled completion. The offscreen mounted browser card opened no connection; visibility opened one preview, explicit entry handed off to one full viewer, and closing/hiding left zero active streams. Peak active browser streams was one. The control scenario also uses the inert wrapper and is not an unsafe-document positive control.

The source map includes the actual store, digest, shared cache and viewer modules. **It does not include `artifact-byte-owner.ts`**, so this proof establishes no higher-level admission-owner coverage. Complete negotiated family/command/rollback/cohort and workload proofs remain open. No whole audit finding closes here.

Reproduction inputs are archived in [fixture-source.md](fixture-source.md); isolation and local update delivery follow the [parent fixture instructions](../fixture-source.md). The temporary Metro adapters and fixture entry were removed after bundling; no app entry, native library or production configuration changed. Screenshots record [disk completion](disk.png), [inert markup](sandbox.png), [PDF](pdf.png), [full browser](computer-open.png), and [hidden browser](computer-hidden.png).
