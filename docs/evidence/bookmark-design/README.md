# Bookmark design

This evidence mock specifies private, Workspace-scoped message bookmarks for
mobile and desktop.

## Interaction contract

- Mobile adds **Bookmark** or **Remove bookmark** to the existing long-press
  message action sheet.
- Desktop adds the same toggle to the existing hover and keyboard-focus action
  strip.
- A saved message carries a small brass bookmark marker beside its timestamp.
  The marker is status, not a separate control.
- The Workspace navigation gains a **Bookmarks** destination. Mobile uses a
  chronological index; desktop uses a master-detail view that preserves list
  position.
- Opening an item returns to the exact source message in its Room or Corner.
- Bookmarks belong to one viewer, are invisible to other members, and never
  grant access to source content.

## States

Save and removal are optimistic and announced to assistive technology. Removal
offers a short undo action. If the source is deleted or no longer accessible,
the index keeps a muted unavailable row with a remove action rather than
revealing cached message content.

Open [the self-contained visual mock](./mock.html) to review the mobile action,
message marker, mobile index, and desktop retrieval layouts.
