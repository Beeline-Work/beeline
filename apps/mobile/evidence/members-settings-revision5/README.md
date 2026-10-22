# Revision 5: one shared header

Design review only; no merge or release. Not a defect report.

All four sections already render `apps/mobile/sources/components/buzz/RoomListSectionHeader.tsx`: ROOMS and DIRECT MESSAGES on mobile/desktop, PEOPLE and AGENTS on Members. The shared component is identical to production v0.1.94 (`703bbdbf`). There is no remaining duplicate header/+ implementation to delete. No product code change was needed and there is no visible Members change in this revision. The stale Members design-test description that claimed chevron-edge alignment is replaced with a shared-header contract check.

Members supplies 16 px through its existing content container and uses `inset="content"`; room lists use the component's 16 px screen inset. Thus all four action boxes end 16 px before their surface's right edge. The glyph box inset is 30 px; action center inset 38 px. Different parent widths do not change the inset. Members retains its existing flush vertical spacing.

Fresh full-app desktop and Android Members screenshots and true 1:1 crops accompany this note. Android is a native mdpi 412×915 capture; desktop is 1279×936 at device scale 1. No resampling is used for the crops. Surface bounds and action bounds are in measurements.json. Desktop Members occupies the right pane, while room-list controls are measured against the left sidebar edge.

Revision 4 captures remain current for all unchanged requirements: room lists mobile/desktop, production-source/current pixel-identical ROOMS crop, switchers without separate Join, Settings owner row, Workspace screen and Back to Settings, public-link copy before/after, actual non-admin Settings. These captures are included again in the combined revision 5 review gallery. Their source details and limitations are documented in ../members-settings-revision4/README.md. All use the isolated authenticated in-memory server; no production account or database is involved.

Validation: 84 focused Members tests pass, including existing Invite/Connect behavior and permission gating. No new component, duplicate action, layout override, or spacing change was introduced.
