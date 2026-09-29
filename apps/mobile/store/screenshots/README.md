# Welcome cards: store screenshot manifest

These are full-size renders of the merged `WelcomeCards` app component in cards
1 → 4 order. The Room conversation and Corner review shown in cards 1 and 2
are **synthetic app fixtures** from `WelcomeCards.tsx`; the displayed PR number,
check result, participants, and messages do not attest to real activity. The
component renders the actual `LedgerEntry`, identity, model, and tool UI. No
production account or store listing was used to capture them.

Capture used a temporary Expo Web route mounting `WelcomeCards`, removed after
capture, and `chrome-devtools-axi` device emulation at each canvas. Fonts came
from the app's root layout. Each PNG is an 8-bit RGB render without alpha:

| Set             | CSS viewport × device scale | Output      | Store target                |
| --------------- | --------------------------- | ----------- | --------------------------- |
| Play phone      | 390 × 780 × 2.769230769     | 1080 × 2160 | `en-US/phoneScreenshots`    |
| iPhone 6.9-inch | 420 × 912 × 3               | 1260 × 2736 | `APP_IPHONE_69`             |
| iPad 13-inch    | 1032 × 1376 × 2             | 2064 × 2752 | 13-inch iPad screenshot set |

The 13-inch iPad frames use the app's wider welcome-card layout, centered at
600 CSS px with a scene height appropriate to each card. The Play set keeps the
existing 1:2 canvas. It meets Play's size and aspect-ratio limit, although
Google recommends 9:16 for some large-format promotion placements.

## Full-size frames

| Card       | Play phone           | iPhone 6.9-inch                     | iPad 13-inch                     |
| ---------- | -------------------- | ----------------------------------- | -------------------------------- |
| 1 · Room   | [PNG](01-room.png)   | [PNG](ios/iphone-6.9/01-room.png)   | [PNG](ios/ipad-13/01-room.png)   |
| 2 · Corner | [PNG](02-corner.png) | [PNG](ios/iphone-6.9/02-corner.png) | [PNG](ios/ipad-13/02-corner.png) |
| 3 · Models | [PNG](03-models.png) | [PNG](ios/iphone-6.9/03-models.png) | [PNG](ios/ipad-13/03-models.png) |
| 4 · Tools  | [PNG](04-tools.png)  | [PNG](ios/iphone-6.9/04-tools.png)  | [PNG](ios/ipad-13/04-tools.png)  |

Reviewed at full resolution for order, scene crop, legible text, marks, and
footer. The Play copies under
`apps/mobile/fastlane/metadata/android/en-US/images/phoneScreenshots/` are
byte-identical to the four Play source PNGs here.

## SHA-256

| Set             | Card 1                                                             | Card 2                                                             | Card 3                                                             | Card 4                                                             |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Play phone      | `5801ba93e2e5ffe195009c040ffaa5e72007d145ce0b24b324015c8e2fede748` | `184f0bc1d4c8f28e93613d99a5df8631547badae67b5427cb1b47dfb174238eb` | `35010160414558149441b6a711b875f6fb7832cfb19da6b411876d299e390ec4` | `0b361388b091b49b22a8ae4e5e657e1344b36dfef20b45b93ccb37370526320a` |
| iPhone 6.9-inch | `dc417491a0a67f7ccf0c5760d99eeedbc64d4a88afd3adaf1e1d1a2880474545` | `87d64b3ef2457f1d656798789271303c16e5c26fac122c9e2e7b9092cab3e843` | `d192c8bbb2152f70d8ac8c1b5528137ca738c00f3c1023021a8c938db0b94161` | `3890bb9f7dcc16b19d56768aa4dac3d9e5a9472602985f559126748ed3b369f6` |
| iPad 13-inch    | `be261b08d37d6bfccf3fbd59025cbf782b392828f5a0f0d332b52d433e30fead` | `91e2df8a9e48cc109acb95ca3c22fc1425b3b5b9c7ce27b98ec93fa7817dc5c0` | `29a391b2686e4ff43e85ea01fcdaa7d4f1f252fd136e8e3ed3b8367180362b9d` | `df67676556c0d2e1bd3153992262fa30957bee09429f47b7b9843162ebf328fd` |

## API upload handoff after this asset PR lands

No live store was mutated for this asset package. Runtime Play and App Store
Connect credentials were unavailable in this worktree, so current locales,
Apple version state, and existing display targets still require read-only API
inventory. For Play, inspect the listing and use a screenshot-only edit for the
English phone set; the broad `play-publish-listing.sh` also rewrites text,
icon, and feature graphic. For Apple app `6803948500` (`app.usebeeline.mobile`),
inspect versions, localizations, and screenshot sets first. Attach the iPhone
and iPad sets to an editable version, order 1 → 4, and verify processing and
membership before removing superseded assets. If there is no editable version,
report the exact new-version submission needed before submitting anything.

Public listings: [Google Play](https://play.google.com/store/apps/details?id=app.usebeeline)
and [App Store](https://apps.apple.com/app/id6803948500). These links do not
prove the new images are live; API readback is required in the upload phase.
