# Tool ledger Android verification

Captured on 2026-08-24 from an isolated Pixel 6 / Android API 36 emulator
(`1080x2400`) using this branch's release APK. Expo Updates was disabled in the
generated native manifest for the capture, so the after images use the local
bundle rather than a cached OTA.

- `tool-ledger-before-expanded.png` — the pre-change stacked activity treatment
  (copied from the repository's API 36 corner evidence).
- `tool-ledger-after-collapsed.png` — mixed seven-step runs collapsed by default;
  the brass cross and failure count are visible while agent prose remains primary.
- `tool-ledger-after-expanded.png` — individual one-line rows, including file,
  shell, search, thought, verdict, hairline, and the real 51-second duration.
- `tool-ledger-after-failure.png` — the same expanded device state retained under
  a requirement-specific filename; `command not found: pnpm` is visible inline.
- `tool-ledger-after-raw-sheet.png` — tap-open `HullActionSheet` with selectable
  raw command output and the transcript collapsed behind the modal.
- `tool-ledger-after-landing.png` — fixture-reachable landing stages rendered by
  the same ledger: verify owner approval, sync target branch, land approved change.

`provision-tool-ledger.ts` accepts `PROOF_AGENT_NSEC` and `PROOF_CORNER_ID` from
`scripts/provision-smoke.ts`. It publishes only relay fixtures; it contains no
committed identity or secret.
