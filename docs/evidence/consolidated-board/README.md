# Consolidated board render proof

Production React Native Web components with explicitly synthetic transport data. Profile and Manage use the real Members controller for management, including permission filtering. The index fixture composes the real rail, toolbar and conversation rows; its small header and sample transcript are fixture context, not a full authenticated application session.

Captured at 390×844 (phone), 1440×1000 (desktop index/profile) and 1000×1000 (desktop Manage), in dark and light themes. Browser checks found no document overflow in the index/profile matrix and exercised Show all conversations, unread clearing, profile dismissal and owner-only control exclusion for admins. Component tests separately cover real navigation callbacks, writes, retries and failure rollback.

Reproduce with `node apps/mobile/scripts/render-consolidated-board-proof.mjs`; see [agent profiles](../../agent-profiles.md) for query parameters. All data and links shown are illustrative. No authenticated user content is included.

Visual review was performed in-thread because no independent visual reviewer tool was available. The final correction pass resolved the rail fixture sizing, destructive-action placement, switch coloring and low-contrast management labels. Existing assigned-animal identities and permission restrictions are intentional adaptations of the illustrative mock.

Native Android/iOS rendering and Back/scroll restoration are **not verified**: no emulator or device is available in this environment. Responsive browser captures must not be presented as native-device evidence.
