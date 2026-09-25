# System DM logo proof

These Chrome screenshots render the mobile app's `ConversationRow` and `IdentityMark` through React Native Web with a fixed System DM fixture. `IdentityMark` draws the canonical path from `beeline-mark.json`. They verify the list mark and the header mark at their shipped sizes. The installed Android build was older than this change, so these are component screenshots rather than a native end-to-end capture.

- `list.png`: 390 × 844 list view, System row at the top.
- `header.png`: 1200 × 780 desktop list and System DM header.

Regenerate from the repository root after installing the mobile dependencies and building `@beeline/nostr`, `@beeline/api-contract`, and `@beeline/buzz-client`:

```sh
node apps/mobile/scripts/render-room-list-proof.mjs
TMPDIR=/var/tmp google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --virtual-time-budget=3000 --window-size=390,844 --screenshot=apps/mobile/evidence/system-dm-logo/list.png "file://$PWD/.verification/room-list/index.html?system=1"
TMPDIR=/var/tmp google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --virtual-time-budget=3000 --window-size=1200,780 --screenshot=apps/mobile/evidence/system-dm-logo/header.png "file://$PWD/.verification/room-list/index.html?system=1"
```
