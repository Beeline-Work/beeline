# Room leave local frames

Run `node --import tsx proof/admin-leave-room/server.mts`, then open the printed URL. The page calls the real `PhoneService` over a loopback HTTP server backed by an isolated PGlite database. Its confirmation text and retry path import the production `leaveRoomWithConfirmation`; the visual shell is a proof fixture, not the shipped Room screen.

- `ordinary-confirm.png`: an admin sees that others retain access.
- `ordinary-left.png`: that admin leaves and the Room still exists for its other admin and member.
- `last-admin-confirm.png`: the last admin sees the explicit delete consequence and “Leave and delete.”
- `last-admin-deleted.png`: the Room row is gone from the local database after confirmation.
