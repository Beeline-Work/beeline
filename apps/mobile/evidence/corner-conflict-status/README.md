# CONFLICT-STATUS-1

The historical PR head on #2862 has been superseded, so a controlled GitHub
provider and isolated database reproduce the same conflict → server projection →
phone read → status render path. No production data or credentials are used.

The regression in `apps/server/src/github-operations.test.ts` starts with a stored
clean verdict, receives a completed check event while the live provider reports
`dirty`, reads `PhoneService.readRoom`, validates it with `readRoomView`, and runs
the phone's status formatter. Before the fix it fails with `all 1 test passed`
instead of `merge conflict`. After the fix it passes, then confirms that a live
clean verdict clears the conflict. Existing head and base fences remain in place.
The component regression in `CornerStatusLine.test.tsx` verifies the rendered text
also clears when a new server response arrives.

`responses.json` contains those captured phone responses, with unrelated transcript
and member arrays emptied. The screenshots build the actual `CornerStatusLine`
using React Native Web and the Bone theme; this is a component browser proof,
not an authenticated production phone session.

- `before.png`: old refresh skips the clean record despite the live conflict.
- `conflict.png`: the fixed server projects `dirty`; the phone says merge conflict.
- `resolved.png`: a subsequent live clean verdict restores the passing tests line.

Run from the repository root:

```sh
npm run test -w @beeline/server -- src/github-operations.test.ts -t CONFLICT-STATUS-1
npm run test --prefix apps/mobile -- run sources/components/buzz/CornerStatusLine.test.tsx
node apps/mobile/evidence/corner-conflict-status/proof.mjs
```

Open `http://127.0.0.1:19249/?state=conflict&theme=bone` (also `before` and
`resolved`). The script bundles the checked-in responses and shipped component;
its Unistyles adapter supplies the repository's theme tokens and native styles.
