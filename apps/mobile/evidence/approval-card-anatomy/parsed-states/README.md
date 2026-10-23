# Parsed approval state matrix

Every case renders a server-shaped payload through `readRoomViewMessage`, then `displayRoomMessage`, then the production card. The Android harness uses the real active theme. `cases.json` lists the complete supported matrix.

Once and Always are command-grant scopes. Squire approvals, connector setup, edit/spending permission and target proposals have no Always wire state; their Allowed/Denied outcomes are covered without inventing a scope. Squire expiry and permission expiry/failure are also covered. Connecting connector setup is covered by the original gallery.

Red parser head: `e1a6ab5801c52caa33fd050328a6684d26997ad0`. See `red-output.txt` and the complete `red-tests.json` output. `green-tests.json` records the repaired-parser result. The new matrix fails its Squire, permission and target regressions (90 tests). Grant and connector baseline cases already pass (34), as they should; no failure was fabricated for unaffected behavior. The repaired parser passes the full theme suite (197 tests). The final green commit SHA and its rerun output are posted with the delivery report.

| Request | State | Bone | Obsidian |
| --- | --- | --- | --- |
| grant-legacy | pending | [Bone](bone/grant-legacy--pending.png) | [Obsidian](obsidian/grant-legacy--pending.png) |
| grant-legacy | once | [Bone](bone/grant-legacy--once.png) | [Obsidian](obsidian/grant-legacy--once.png) |
| grant-legacy | always | [Bone](bone/grant-legacy--always.png) | [Obsidian](obsidian/grant-legacy--always.png) |
| grant-legacy | denied | [Bone](bone/grant-legacy--denied.png) | [Obsidian](obsidian/grant-legacy--denied.png) |
| grant-purpose | pending | [Bone](bone/grant-purpose--pending.png) | [Obsidian](obsidian/grant-purpose--pending.png) |
| grant-purpose | once | [Bone](bone/grant-purpose--once.png) | [Obsidian](obsidian/grant-purpose--once.png) |
| grant-purpose | always | [Bone](bone/grant-purpose--always.png) | [Obsidian](obsidian/grant-purpose--always.png) |
| grant-purpose | denied | [Bone](bone/grant-purpose--denied.png) | [Obsidian](obsidian/grant-purpose--denied.png) |
| squire-key | pending | [Bone](bone/squire-key--pending.png) | [Obsidian](obsidian/squire-key--pending.png) |
| squire-key | allowed | [Bone](bone/squire-key--allowed.png) | [Obsidian](obsidian/squire-key--allowed.png) |
| squire-key | denied | [Bone](bone/squire-key--denied.png) | [Obsidian](obsidian/squire-key--denied.png) |
| squire-key | expired | [Bone](bone/squire-key--expired.png) | [Obsidian](obsidian/squire-key--expired.png) |
| squire-purchase | pending | [Bone](bone/squire-purchase--pending.png) | [Obsidian](obsidian/squire-purchase--pending.png) |
| squire-purchase | allowed | [Bone](bone/squire-purchase--allowed.png) | [Obsidian](obsidian/squire-purchase--allowed.png) |
| squire-purchase | denied | [Bone](bone/squire-purchase--denied.png) | [Obsidian](obsidian/squire-purchase--denied.png) |
| squire-purchase | expired | [Bone](bone/squire-purchase--expired.png) | [Obsidian](obsidian/squire-purchase--expired.png) |
| squire-login | pending | [Bone](bone/squire-login--pending.png) | [Obsidian](obsidian/squire-login--pending.png) |
| squire-login | allowed | [Bone](bone/squire-login--allowed.png) | [Obsidian](obsidian/squire-login--allowed.png) |
| squire-login | denied | [Bone](bone/squire-login--denied.png) | [Obsidian](obsidian/squire-login--denied.png) |
| squire-login | expired | [Bone](bone/squire-login--expired.png) | [Obsidian](obsidian/squire-login--expired.png) |
| squire-edit-key | pending | [Bone](bone/squire-edit-key--pending.png) | [Obsidian](obsidian/squire-edit-key--pending.png) |
| squire-edit-key | allowed | [Bone](bone/squire-edit-key--allowed.png) | [Obsidian](obsidian/squire-edit-key--allowed.png) |
| squire-edit-key | denied | [Bone](bone/squire-edit-key--denied.png) | [Obsidian](obsidian/squire-edit-key--denied.png) |
| squire-edit-key | expired | [Bone](bone/squire-edit-key--expired.png) | [Obsidian](obsidian/squire-edit-key--expired.png) |
| squire-delete-key | pending | [Bone](bone/squire-delete-key--pending.png) | [Obsidian](obsidian/squire-delete-key--pending.png) |
| squire-delete-key | allowed | [Bone](bone/squire-delete-key--allowed.png) | [Obsidian](obsidian/squire-delete-key--allowed.png) |
| squire-delete-key | denied | [Bone](bone/squire-delete-key--denied.png) | [Obsidian](obsidian/squire-delete-key--denied.png) |
| squire-delete-key | expired | [Bone](bone/squire-delete-key--expired.png) | [Obsidian](obsidian/squire-delete-key--expired.png) |
| squire-edit-card | pending | [Bone](bone/squire-edit-card--pending.png) | [Obsidian](obsidian/squire-edit-card--pending.png) |
| squire-edit-card | allowed | [Bone](bone/squire-edit-card--allowed.png) | [Obsidian](obsidian/squire-edit-card--allowed.png) |
| squire-edit-card | denied | [Bone](bone/squire-edit-card--denied.png) | [Obsidian](obsidian/squire-edit-card--denied.png) |
| squire-edit-card | expired | [Bone](bone/squire-edit-card--expired.png) | [Obsidian](obsidian/squire-edit-card--expired.png) |
| squire-vouch | pending | [Bone](bone/squire-vouch--pending.png) | [Obsidian](obsidian/squire-vouch--pending.png) |
| squire-vouch | allowed | [Bone](bone/squire-vouch--allowed.png) | [Obsidian](obsidian/squire-vouch--allowed.png) |
| squire-vouch | denied | [Bone](bone/squire-vouch--denied.png) | [Obsidian](obsidian/squire-vouch--denied.png) |
| squire-vouch | expired | [Bone](bone/squire-vouch--expired.png) | [Obsidian](obsidian/squire-vouch--expired.png) |
| squire-passkey | pending | [Bone](bone/squire-passkey--pending.png) | [Obsidian](obsidian/squire-passkey--pending.png) |
| squire-passkey | allowed | [Bone](bone/squire-passkey--allowed.png) | [Obsidian](obsidian/squire-passkey--allowed.png) |
| squire-passkey | denied | [Bone](bone/squire-passkey--denied.png) | [Obsidian](obsidian/squire-passkey--denied.png) |
| squire-passkey | expired | [Bone](bone/squire-passkey--expired.png) | [Obsidian](obsidian/squire-passkey--expired.png) |
| spending | pending | [Bone](bone/spending--pending.png) | [Obsidian](obsidian/spending--pending.png) |
| spending | allowed | [Bone](bone/spending--allowed.png) | [Obsidian](obsidian/spending--allowed.png) |
| spending | denied | [Bone](bone/spending--denied.png) | [Obsidian](obsidian/spending--denied.png) |
| spending | expired | [Bone](bone/spending--expired.png) | [Obsidian](obsidian/spending--expired.png) |
| spending | failed | [Bone](bone/spending--failed.png) | [Obsidian](obsidian/spending--failed.png) |
| edit-corner | pending | [Bone](bone/edit-corner--pending.png) | [Obsidian](obsidian/edit-corner--pending.png) |
| edit-corner | allowed | [Bone](bone/edit-corner--allowed.png) | [Obsidian](obsidian/edit-corner--allowed.png) |
| edit-corner | denied | [Bone](bone/edit-corner--denied.png) | [Obsidian](obsidian/edit-corner--denied.png) |
| edit-corner | expired | [Bone](bone/edit-corner--expired.png) | [Obsidian](obsidian/edit-corner--expired.png) |
| edit-corner | failed | [Bone](bone/edit-corner--failed.png) | [Obsidian](obsidian/edit-corner--failed.png) |
| target-branch | pending | [Bone](bone/target-branch--pending.png) | [Obsidian](obsidian/target-branch--pending.png) |
| target-branch | allowed | [Bone](bone/target-branch--allowed.png) | [Obsidian](obsidian/target-branch--allowed.png) |
| target-branch | denied | [Bone](bone/target-branch--denied.png) | [Obsidian](obsidian/target-branch--denied.png) |
| connector-add | pending | [Bone](bone/connector-add--pending.png) | [Obsidian](obsidian/connector-add--pending.png) |
| connector-add | allowed | [Bone](bone/connector-add--allowed.png) | [Obsidian](obsidian/connector-add--allowed.png) |
| connector-add | denied | [Bone](bone/connector-add--denied.png) | [Obsidian](obsidian/connector-add--denied.png) |
| connector-switch | pending | [Bone](bone/connector-switch--pending.png) | [Obsidian](obsidian/connector-switch--pending.png) |
| connector-switch | allowed | [Bone](bone/connector-switch--allowed.png) | [Obsidian](obsidian/connector-switch--allowed.png) |
| connector-switch | denied | [Bone](bone/connector-switch--denied.png) | [Obsidian](obsidian/connector-switch--denied.png) |
| connector-reconnect | pending | [Bone](bone/connector-reconnect--pending.png) | [Obsidian](obsidian/connector-reconnect--pending.png) |
| connector-reconnect | allowed | [Bone](bone/connector-reconnect--allowed.png) | [Obsidian](obsidian/connector-reconnect--allowed.png) |
| connector-reconnect | denied | [Bone](bone/connector-reconnect--denied.png) | [Obsidian](obsidian/connector-reconnect--denied.png) |
