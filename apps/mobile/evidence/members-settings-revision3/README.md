# Members and Workspace settings: revision 3

Design review only. Merge hold remains; no merge or release.

## Capture sources

Production web metadata fetched from https://web.usebeeline.app on 2026-10-21 identifies v0.1.94, commit `703bbdbf5f8c3523c9dd5aaa8644179550b30735`. Main is `6069adc3b51baf360d687a38fe5f58ea47ef7383`. Main has a later search field implementation and personal Settings changes. Normal unexpanded Room-list chrome is the same. Both main and production already have the desktop Direct Messages section +.

The before images named `00-*-before-production` render channels, sidebar and toolbar from that production commit inside the full local app. They are reconstructed production-source views, not screenshots of a production account. `01-mobile-before-main` and `03-desktop-before-main` provide the main baseline. The prototype uses main components. No production data or credentials were used.

All native images are unedited API 36 Android emulator captures of the full signed-in app. Desktop images are the full Expo web app at 1279 × 936. Both use the isolated authenticated in-memory server documented in ../members-settings-prototype/README.md. No standalone UI fixture, invented Settings controls, server indexing, or production mutation is involved.

## Images

- 00-mobile-before-production.png / 00-desktop-before-production.png: deployed revision source baseline.
- 01-mobile-before-main.png / 03-desktop-before-main.png: main baseline.
- 02-mobile-after.png / 04-desktop-after.png: revision 3. Members replaces overflow; mobile top + removed; section creation actions; original filters/search/Tray retained.
- 05-admin-settings-top.png / 06-admin-settings-bottom.png: Workspace owner Settings, showing the reused Workspace section between Connectors and Device. Owner-only Delete remains owner-only.
- 06a-non-admin-settings.png: actual member role returned by the isolated server; Connectors flows straight into Device without a Workspace section.
- 07-members.png / 07a-invite.png / 07b-connect.png: existing Members page and its existing Invite/share and Connect command paths. The test connect code belongs only to the ephemeral local server.
- 08-switcher.png: Join alongside Add in the mobile switcher.
- 09-mobile-obsidian.png: revised Room list in Obsidian.

## Demonstrated paths

The Android Members glyph opens the existing Members page. Add people opens the existing native share sheet; Add agents opens the existing connect-command sheet. Rooms + opens New Room; Direct Messages + opens the existing people/agent message picker. Switcher Join closes the drawer and opens the existing join flow. XML receipts record the New Room, message-picker and Join results. No Room, DM or Workspace was created to exercise those actions.

Workspace owner and member screenshots use real role DTOs. Renderer tests additionally cover admin/owner/member gating. Empty section headers remain available in the unfiltered list so the first DM can be started.

## Review questions

The MembersAgentsGlyph wraps the existing Members mark as an explicitly authorized placeholder. Which final glyph should replace it? The reused Workspace controls fill more than one Android screen; the two admin captures show the complete section and its transition into Device. No other layout changes were made.

This is not a defect report. Revision 2 screenshots are superseded by this directory.
