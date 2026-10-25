# FIC-1 proof

The isolated PGlite Room is seeded by `FIC-1: seeded Room projects live red repair and scheduled corners on every surface` in `corner-attention.integration.test.ts`. It calls the real PhoneService reads, live projection and daemon inspection, verifies client validation, and checks one commander alert across repeated refreshes.

`seed.json` is that Room's actual Corners response: red checks older than the repair window with a live worker, alongside an active scheduled corner. `bone.png` and `obsidian.png` render it through the production RoomCornersList, cornerDisplayState, StateCircle and IdentityMark with production theme tokens and fonts.

This is an isolated render harness, not a production screenshot. Router, reduced-motion animation, unused controls/loaders and the unchanged objective text component are stand-ins; no display-state or row-label code is mocked. Production verification after release remains outstanding.

Reproduce from the repository root:

```sh
FIC_PROOF_OUTPUT="$PWD/proof/false-idle-corners/seed.json" npx vitest run apps/server/src/corner-attention.integration.test.ts -t 'FIC-1: seeded'
node proof/false-idle-corners/build.mjs
python3 -m http.server 8847 --bind 127.0.0.1
# In another terminal (capture.mjs uses the local squire Chromium installation):
node proof/false-idle-corners/capture.mjs
```
