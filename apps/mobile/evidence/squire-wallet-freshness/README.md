# Squire Disconnect and fresh Wallet / key screens

Chrome captures at **390 × 844**, using the real React Native Web screens,
SettingsRow and HullActionSheet, in Obsidian and Bone. No production account or
helper lifecycle was used.

| Frames (each theme) | Before | After |
| --- | --- | --- |
| `squire-*` | Connected Status sheet offers Manage in Trusty Squire | Connected Status sheet offers Disconnect |
| `wallet-*` | Held $100 balance and no transactions | Server $60 balance and -40 USDC transaction |
| `connection-*` | Held grant and empty activity | Updated empty grants and @bee deploy receipt |

The render fixture seeds the held surface cache with old answers and supplies
new server answers. `before=1` disables focus refresh to reproduce the old
cache-only behavior. Wallet and connection captures exercise the real shared
surface hooks. The Squire action-sheet frame composes the real sheet primitives
with the before/after action; `service.test.tsx` separately opens the actual
screen's Status sheet, presses Disconnect, checks `squire:machine-one`, and
verifies the refreshed status.

Reproduce:

```sh
node apps/mobile/scripts/render-squire-wallet-freshness-proof.mjs
CHROME_DEVTOOLS_AXI_SESSION=squire-freshness chrome-devtools-axi open 'http://127.0.0.1:18487/?screen=wallet&before=1&theme=obsidian'
CHROME_DEVTOOLS_AXI_SESSION=squire-freshness chrome-devtools-axi resize 390 844
CHROME_DEVTOOLS_AXI_SESSION=squire-freshness chrome-devtools-axi screenshot /absolute/path/wallet-before.png
```

Use `screen=wallet|connection|squire`, `before=1|0`, and `theme=obsidian|bone`.
Set `WORKBENCH_PROOF_PORT` if the default port is occupied.

Behavior coverage: `buzz/workbench-freshness.test.tsx` checks reopening,
refocusing, Workbench events and reconnect for all three data reads, subscription
cleanup and Workspace cache isolation. Server `workbench.integration.test.ts`
checks owner unpair, existing other-owner refusal, cleared connections and grants,
no legacy connector rows, ignored late broker reports, and explicit re-pair.
