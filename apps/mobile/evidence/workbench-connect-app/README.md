# Workbench — one Connect an app action, one row per app

Frames are this branch's Expo web client against the disposable design-audit
fixture (`.verification/design-audit/fixture-server.mts` with
`AUDIT_WORKBENCH_APPS=1`, an in-process PGlite database; no production or
captain account). Phone frames are 390×844 at 2×, desktop frames 1440×900.
Obsidian Refined unless the name says Bone.

| Frame | What it shows |
| --- | --- |
| `phone-dark-linear-open.png` | Tools, then **Apps**: the one brass **Connect an app** row, then one row per app whatever serves it — Linear (official MCP server), Resend (Trusty Squire · API key), Hacker News (Squire · browser, connecting), Notion (error, the provider's reason in danger ink). Linear expanded: `Official MCP server · on Niglet · used 3 times` and Disconnect. No Composio row, no route picker. |
| `phone-dark-stripe.png` | After Connect an app → **Stripe** on Niglet: the server searched the live MCP Registry, chose the official hosted `com.stripe/mcp@0.2.4` (route `registry-mcp`, logged by the fixture as `connectApp: … route=registry-mcp …`), and Stripe is one `connecting` row. Resend's vault key is folded into its app row; Keys lists only the unrelated vercel key. |
| `phone-dark-connect-app.png` | Workbench / **Connect an app**: one field (the only box on the page), one quiet line saying Beeline picks the route and Squire handles sign-in, and the machine picker; offline helpers cannot connect. |
| `phone-dark-dm-handoff.png` | The same tap's hand-off: the viewer's own request in their DM with the chosen machine's agent, which completes the sign-in through Trusty Squire. |
| `phone-bone-workbench.png` | The Apps section in Bone. |
| `desktop-dark-workbench.png`, `desktop-bone-workbench.png` | The same Workbench in the desktop pane, both canvases. |
| `desktop-dark-connect-app.png` | Connect an app on desktop, before an app is named (machine rows stay disabled). |

Not shown: a live Trusty Squire ceremony. No Squire account or helper daemon
ran here, so the sign-in the agent would drive after the hand-off was not
exercised; the route decision, row states, key folding and hand-off message
are real.

## Repeat

```
AUDIT_WORKBENCH_APPS=1 AUDIT_WEB_ORIGIN=http://localhost:8083 AUDIT_SERVER_PORT=4310 \
  node --import tsx .verification/design-audit/fixture-server.mts
cd apps/mobile
EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:4310 npx expo start --web --port 8083
# sign in at /review/design-audit-review-secret-0001, then /beeline/settings/workbench
```
