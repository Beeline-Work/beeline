# Reconnect consent

Reproduction MCP-WORKSPACE-RECONNECT: connect to two Workspaces, reconnect with a crafted subset submission (existing memberships stay), then open consent again. Before this fix, the existing Workspace omitted from the saved selection appeared unchecked and both checkboxes remained editable despite continued access.

The production target was not used: this is an unreleased PR. The closest stand-in uses the actual OAuth HTTP handlers and isolated migrated database in `rooms-mcp.test.ts`, followed by Chrome rendering that handler's complete HTML response. No production accounts or credentials are used. Before is PR head `646f4c777e24`; after is this fix. Both show the same reconnect path. Upstream sign-in is synthetic.

After, both existing memberships appear checked, disabled and labelled “already connected”. Chrome confirms neither checkbox can be deselected, the bulk toggle is hidden when there are no editable Workspaces, and form submission includes both IDs through hidden fields. The HTTP test submits those fields and verifies both memberships remain. The UI regression separately checks that bulk deselection only changes newly available Workspaces and leaves Allow enabled for existing access.

| Theme / viewport | Before | After |
| --- | --- | --- |
| Bone / phone | [Before](before-bone-phone.png) | [After](after-bone-phone.png) |
| Obsidian / phone | [Before](before-obsidian-phone.png) | [After](after-obsidian-phone.png) |
| Bone / desktop | [Before](before-bone-desktop.png) | [After](after-bone-desktop.png) |
| Obsidian / desktop | [Before](before-obsidian-desktop.png) | [After](after-obsidian-desktop.png) |

Phone viewport (390 × 1000); desktop (1280 × 1000). Full-page screenshots retain the surrounding page and unchanged starter text.

Regression: `npm test -w @beeline/server -- src/rooms-mcp.test.ts src/rooms-mcp-consent-ui.test.ts --silent`.
