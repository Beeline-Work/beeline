# Workbench title hierarchy — before and after

**Before** frames are the live release/OTA install on `emulator-5554`
(AVD `buzzy_api36`). That binary cannot load this branch.

**After** frames are this branch’s Expo web client at **390×844**, dark
appearance, signed in through `/review/design-audit-review-secret-0001` to
the isolated design-audit fixture Workspace named **Beeline** (not a
production or captain Workspace). Server: `.verification/design-audit/fixture-server.mts`
on `127.0.0.1:4310`.

## Pairing

| Screen | Before | After |
| --- | --- | --- |
| Workbench list | `before-workbench.png` — small stack title `< Workbench`; Google Workspace had no mark | `after-workbench.png` — small **Settings** over large **Workbench**; Google Workspace wears the same company mark + trailing column as the other tools |
| Wallet | `before-wallet.png` — small stack title `< Wallet` | `after-wallet.png` — small **Workbench** over large **Wallet** |
| Trusty Squire | same stack-title pattern as Wallet (no separate live before; Settings navigation on the release image failed) | `after-squire.png` — Workbench / **Trusty Squire** |
| Tailscale | same | `after-tailscale.png` — Workbench / **Tailscale** |
| Google Workspace | same | `after-google.png` — Workbench / **Google Workspace** |
| Composio | same | `after-composio.png` — Workbench / **Composio** |
| Wallet Send | (no live before; was stack or in-page without the ladder) | `after-wallet-send.png` — Wallet / **Send** |
| Wallet Receive | same | `after-wallet-receive.png` — Wallet / **Receive** |
| Key detail | no key on the release Workspace | `after-key-detail.png` — Workbench / **Key** |
| Sign-in overlay | 40×40 raw ✕ header | `after-signin.png` — Workbench / **Sign in to Trusty Squire** |

## Repeat

```
AUDIT_WEB_ORIGIN=http://127.0.0.1:8083 AUDIT_SERVER_PORT=4310 \
  node --import tsx .verification/design-audit/fixture-server.mts
cd apps/mobile
EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:4310 npx expo start --web --port 8083
# then /review/design-audit-review-secret-0001 at 390×844
```
