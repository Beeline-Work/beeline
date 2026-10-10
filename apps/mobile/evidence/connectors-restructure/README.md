# Connectors approval frames

Phone-width React Native Web frames rendered with the app's `PageHeader`,
`SettingsRow`, `ToolDetailsCell`, `ServiceMark`, and `HullActionSheet` components.

| Frame | View |
| --- | --- |
| `01-home.png` | Trusty Squire never connected; recommended connections |
| `01b-home-connected.png` | One row per key service alongside sign-ins |
| `01c-home-squire-offline.png` | Known key services remain visible while Squire is offline |
| `02-search-stripe.png` | Official Stripe sign-in first, other routes collapsed |
| `03-openrouter-keys.png` | Plain read-only key rows and one Manage in Trusty Squire link |
| `04-gmail-signin.png` | Sign-in detail and status |
| `04b-gmail-status-actions.png` | Connected status sheet |
| `05-trusty-squire.png` | Squire's purpose and tappable status, without a vault list |
| `06-coinbase-wallet.png` | Wallet detail linking to its dashboard |
| `07-openrouter-squire-offline.png` | Read-only keys remain visible while Squire is offline |
| `07b-openrouter-offline-actions.png` | Offline status offers Reconnect |

The captain approved the read-only vault flow after these frames: keys do not
open a sheet, and Beeline does not add, edit, delete, or reveal secrets.
`Manage in Trusty Squire` opens `https://trustysquire.ai/vault`. Trusty Squire's
own page shows its purpose and status only. A Squire key service appears once
per distinct vault reference; Squire-backed app pointers are listed as keys.

The home recommendations use direct Link and official Linear, plus Composio
for Instagram, Slack, Calendar, Drive, Jira, and TikTok. Search prioritizes an
existing connection, then an official Registry MCP, then Composio, then Trusty
Squire. Stripe's official MCP uses OAuth consent. The visible choice of another
route is folded under `Other sign-in or Trusty Squire`.

Render with `WORKBENCH_PROOF_NAME=connectors-restructure-frames WORKBENCH_PROOF_PORT=4195 node apps/mobile/scripts/render-workbench-keys-proof.mjs`.
Capture `?frame=home`, `homeconnected`, `homeoffline`, `search`, `key`,
`signin`, `signinactions`, `squire`, `wallet`, `offlinekey`, and
`offlinekeyactions` at 393 CSS px width. The home frames are 1,320 px tall;
detail frames are 1,050 px tall.
