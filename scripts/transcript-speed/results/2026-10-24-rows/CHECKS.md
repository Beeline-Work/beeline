# Validation and remaining acceptance

Passed on the profiling/tooling tree:

- Root `npm run typecheck` (workspaces, mobile and scripts).
- `npm run dead-code`: four existing findings, zero introduced; baseline unchanged.
- Transcript measurement and transition tests: seven passed.
- Syntax checks for the capture drivers and row-profile symbolicator.
- `git diff --check`.
- Complete Android release suite: three trials per scenario including older
  history, both visually verified concurrent drafts and server-settled sends;
  twenty-one active and twenty-one inactive-sampler keypaint samples; all
  Room-open variants completed. Separate diagnostic profiles never qualify as
  acceptance timing.
- Chrome narrow/desktop hover and packaged Tauri real-pointer capture paths.

## Mobile suite limitation reproduced on the clean base

The full mobile suite completed with 613 files passed, five skipped and one
failed: 5412 tests passed, six skipped and one failed. The only failing test is
`sources/config/nativeFingerprint.test.ts` →
`accepts this tree and rejects a real native edit, end to end`.

The gate reports native fingerprints differing from the committed record while
the runtime pins remain unchanged. A fresh detached checkout of the exact base
`4b8f8feffeef308bbdb56c0007f36e5454623277`, using the same installed dependencies,
also fails `node apps/mobile/scripts/native-fingerprint.mjs` with the same class
of error. Its hashes differ from this instrumented worktree's hashes; this is a
reproduced clean-base failure, not a claim of identical fingerprints.

The current work has no tracked diff under `apps/mobile` from that base.
Runtime pins, native dependencies, plugins and the fingerprint record remain
unchanged, as the brief requires. The mobile suite is **not** reported as fully
passing. Prior benchmark notes also document this local gate failure; the fresh
base run is retained here rather than relying on that history.

Browser tests regenerated unrelated committed evidence screenshots. Those
outputs were preserved locally under `.local/mobile-generated-screens`, then
only those test-generated screenshots were restored to the committed originals;
they are outside this profiling assignment.

[Full check logs and clean-base fingerprint output](checks/manifest.json) are
retained with uncompressed SHA-256 hashes.

## Acceptance remains unmet

There is no product optimization and no claimed before/after win. The profiles
do not rank the proposed row caches or hover rewrite as a demonstrated cause of
the measured stalls. The row/gesture changes owned by the swipe corner remain
unchanged. The PR stays draft pending the commander's decision on a profiling-only
result and the next native tree investigation. The local fingerprint limitation
also remains explicit; it has not been hidden with a runtime bump or a skipped test.
