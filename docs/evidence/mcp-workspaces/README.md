# Workspace consent evidence

Feature request, not a defect report. Brief revision 1 requests a checklist of the person's Workspaces, all selected by default. Human command: “It should be a checklist of users workspaces, defaulting to everything selected” (message `5ed8bf86fb4bfe3ea3a1ab53ec4cf034890dcab5a9561bfc9e478e541e892f41`). Patch manifest object: `abf527e1-5b21-4867-875f-a92bbd2c9472`; SHA-256 `32b66044b5d42497ca2879d4e04464b618b34b6e51950719cb49ec9b81b873d8`.

## Rendered proof

The screenshots use the actual consent route, rendered by headless Chrome against the isolated synthetic account in `scripts/prove-rooms-mcp.mjs --serve`. The upstream GitHub provider is a local double; no production account is accessed. Before uses the parent commit's OAuth module transpiled with TypeScript alongside the built server; after uses the patched built OAuth module. Both follow Register → Authorize → Continue with GitHub → consent.

Phone viewport: 390 × 1000. Desktop viewport: 1440 × 1000. Full-page captures include the unchanged starter text. Chrome's light and dark color schemes select Bone and Obsidian respectively.

| Theme / viewport | Before | After |
| --- | --- | --- |
| Bone / phone | [Before](before-bone-phone.png) | [After](after-bone-phone.png) |
| Obsidian / phone | [Before](before-obsidian-phone.png) | [After](after-obsidian-phone.png) |
| Bone / desktop | [Before](before-bone-desktop.png) | [After](after-bone-desktop.png) |
| Obsidian / desktop | [Before](before-obsidian-desktop.png) | [After](after-obsidian-desktop.png) |

Browser assertions passed: one checkbox for the fixture's one Workspace, checked initially; unchecking disables Allow; rechecking enables it; clicking Allow submits the real form and returns a successful OAuth redirect (302).

`rooms-mcp.test.ts` separately exercises two eligible Workspaces through HTTP consent: submitting the default checked fields joins both; submitting a subset excludes the unticked Workspace through token exchange and refresh; reconnect deselection preserves existing memberships. Foreign, departed, malformed and duplicate Workspace selections are refused. `rooms-mcp-consent-ui.test.ts` checks one initially checked control per supplied Workspace.

## Scope trimming

The imported format-patch keeps its original author metadata. One Jellybean follow-up removes the starter-instruction rewrite and its assertions, restores the starter text's existing markup, styles and clipboard behavior, and removes the reconnect membership-revocation rule and its corresponding expectations. The reconnect regression now verifies existing memberships and Room reads remain available after deselection. These removals follow Ruby's explicit order and the brief's visual scope and existing-membership non-goal.
