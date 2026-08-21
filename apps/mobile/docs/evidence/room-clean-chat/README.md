# Room and Corner Grok Build alignment

Historical capture from the signed pre-rename release APK on Android API 36 (`emulator-5554`) against the relay-backed `Corners UX Review` fixture. Rerun it before treating it as evidence for `app.usebeeline.mobile`.

## Measured authority

The alignment source is the live Grok Build 1.0.3 capture supplied in `grok-tui-block.html` and `grok-tui.ansi`. The mobile tokens use its measured roles exactly:

- ground `#121212`
- primary `#e4e4e4`
- body `#c9ccd1`
- dim `#767676`
- faint `#585858` / `#6c6c6c`
- 1px rules `#4e4e4e`
- one muted-gold accent `#d7af5f`

## Release screens

- [Room](./room-aligned.png): clean conversation, `#121212` chrome, 1px grey rules, and one gold live-work signal.
- [Corner](./corner-aligned.png): mono throughout, thin activity rules, a rounded terminal composer with inline status, and one bordered gold approval action.
- [Rendered Grok Build reference](./grok-tui-reference.png)

## Side-by-side alignment proof

- [Room beside Grok Build](./room-aligned-v-grok.png)
- [Corner beside Grok Build](./corner-aligned-v-grok.png)

The remaining differences are functional, not token drift: mobile retains Android safe areas and navigation, the Corner includes the real file-review and approval boundary, and the Room remains conversational rather than becoming a terminal.
