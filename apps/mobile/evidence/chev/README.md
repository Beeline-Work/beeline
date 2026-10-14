# Unread disc and arrival flash evidence

The jump disc, unread badge, and arrival flash remain separate transcript
features. Their executable regressions are in
`sources/buzz/room-new-message-boundary.test.ts` and
`sources/buzz/use-new-message-control.test.tsx`. The current Android unread
proof is in `evidence/unread-controls/README.md`.

The earlier Android API 30 fixture mounted the production unread hook and
controls with stand-in row bodies. `05-disc-tap-lands-at-newest.png` records
an ordinary press landing on the tail.

## The arrival flash

Frames `10`–`14` come from a second pass of the same proof entry, mounting the
production row cell (`buzz/room-message-cell.tsx`), the production flash rule
and timing (`buzz/room-arrival-flash.ts`), and the production
landing-completion shape: the flash is raised from the viewability report that
confirms the row is on screen, exactly as `completePendingNewMessageLanding`
raises it. Only the row bodies and the two landing buttons are stand-ins.

`10-arrival-flash-on-landing.png` — a notification landing on `seed-8`
completes and the row it pointed at carries a `bgHighlight` ground fill:
`landed: seed-8 · flashing: seed-8`. Area, no stroke, and the row's own layout
is untouched — the fill is behind its content.

`11-arrival-flash-cleared.png` — one cycle later the fill is gone, with no
repeat.

`12-ordinary-landing-no-flash.png` — an ordinary landing on `seed-16`
completes with no anchor behind it: `landed: seed-16 · flashing: none`. A
highlight on every Room open would be wallpaper, and the NEW MESSAGES divider
already says where the unread run starts.

`13-arrival-flash-reduce-motion-hold.png` /
`14-arrival-flash-reduce-motion-cleared.png` — the same landing with
`animator_duration_scale 0` (what Android reports to
`AccessibilityInfo.isReduceMotionEnabled`). The fill still HOLDS — degrading to
no flash at all would take the pointer from the readers most likely to need it
— and then clears outright instead of fading. The device setting was restored
after capture.
