# SCROLL-01 signed Android proof

Captured on the installed `app.usebeeline` development APK on Android API 30.
The package reports versionName `0.2.20`, versionCode `27`, signature token
`51ed3f60`, and `lastUpdateTime=2026-09-20 20:44:31`. That installation
predates #1555 (`18dfef94`, committed 2026-09-21 15:05:25 -0400).

The proof entry used the production React Native `FlatList` physics with an
inverted, virtualized list and measured variable-height rows (54–126 px). It
was removed after capture. The before pass applied #1555's follow-from-history
rule; the after pass applied this change's pinned-tail decision and native
visible-child anchoring.

## Frames

- `before-history-jump.png`: a history reader is pulled from rows 11–19 to the
  tail, rows 35–41, when one row arrives.
- `after-history-hold.png`: the same arrival is queued and the measured visible
  range remains rows 12–20.
- `before-tail-follow.png` / `after-tail-follow.png`: a pinned reader reaches
  the new row 41 in both builds.
- `before-finger-held.png` / `after-finger-held.png`: the arrival occurs while
  the Android drag is active and remains queued; neither pass issues a jump
  under the finger.

## Why the anchor holds

Native `maintainVisibleContentPosition` records the first eligible visible
child's real frame and compensates for that child's measured movement after an
insert. `minIndexForVisible: 1` excludes the replaceable streaming/optimistic
tail row. This works with natural row heights and native virtualization; there
is no `getItemLayout`, fixed-height estimate, or eager native full-list render.

Boundary landings use `scrollToIndex`. If the target is outside the measured
window, `onScrollToIndexFailed` makes one estimate from React Native's observed
`averageItemLength`, lets that window measure, and retries the exact index.
Programmatic landing is withheld for the complete drag/momentum interval.
