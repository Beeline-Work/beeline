# Workbench title hierarchy — impeccable native audit

Captured on `emulator-5554` (AVD `buzzy_api36`, 1080×2400) from the one
fixed signed-in Workspace. The installed `app.usebeeline` binary is a
release/OTA image (`versionCode=101`, not debuggable), so it will not
load this branch's Metro. Before frames are that live release UI. After
frames of the new Workbench header are the same `PageHeader` already
shipping on Bookmarks and Members (the component this PR now uses on
every Workbench screen).

## Audit health

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | Sign-in overlay close was 40×40 with a raw ✕; now `PageHeader`'s 44pt back |
| 2 | Performance | 4 | Workbench lists stay small; no virtualization gap on these screens |
| 3 | Appearance & Theming | 3 | Receive/send/QR placeholder used raw colors; QR modules stay high-contrast for scanners |
| 4 | Platform Conformance | 3 | Stack header was a second, smaller title; `headerShown: false` + `PageHeader` |
| 5 | Adaptivity | 3 | Phone safe-area + desktop omits back, same as Bookmarks |
| **Total** | | **16/20** | **Good** |

## Presentation findings (fixed in this PR)

| Finding | Before | After |
| --- | --- | --- |
| Workbench used a small stack title, not Settings / Workbench | `before-workbench.png` | `reference-bookmarks.png` / `reference-members.png` (same `PageHeader`: small parent over large noun) |
| Wallet used a small stack title, not Workbench / Wallet | `before-wallet.png` | Same ladder; Wallet also keeps the CDP meta line |
| Connect / key / send / receive / sign-in used a stack title or a custom 40×40 ✕ header | same stack pattern as Wallet | `PageHeader` (Workbench / tool or key; Wallet / Send or Receive; Workbench / Sign in to {tool}) |
| Receive + send placeholder + QR empty frame used raw hex | code | hull tokens (`textMuted` / type roles). QR *modules* stay `#ffffff` / `#171310` so scanners can read them |

## Behaviour not built

- There is no Beeline key-edit screen. Key detail is `connection.tsx`. Listed only.
- The stale keys-list-after-edit refresh is a separate task. Not implemented here.
- Keys live on the Workbench list (no separate keys-list route). Empty on this Workspace (`None yet`), so no live key-detail before frame.
- Tailscale / Google Workspace / Composio are the same `connect.tsx` as Trusty Squire (title = connector name). Composio remains `soon`.
- Settings opened from the Members self-row currently errors on this release image (`undefined is not a function`). Not a presentation change; not investigated here.

## Frames

| file | shows |
| --- | --- |
| `before-workbench.png` | Release Workbench: `< Workbench` stack title, no Settings eyebrow |
| `before-wallet.png` | Release Wallet: `< Wallet` stack title + CDP subtitle |
| `reference-bookmarks.png` | Live Bookmarks: small workspace name over large **Bookmarks** |
| `reference-members.png` | Live Members: small workspace name over large **Members** |
