# Composer auto-growth evidence

## Reproduced

At `c1197a60`, the shared `ConversationComposer` applies its measured `height`
and `maxHeight` to the multiline `TextInput` on every platform. Restoring that
unconditional style makes the focused iOS regression test fail because the
input receives `{ height: 40, maxHeight: 120 }` instead of native intrinsic
sizing.

The first fix removed that override on every platform. Review identified the
corresponding web regression: React Native Web reports content size but does not
apply it, so the desktop composer still needs the measured style.

## Demonstrated

`demonstrated-desktop-three-lines.png` was captured in headless Chrome from the
actual shared `ConversationComposer` rendered through React Native Web. All
three newline-delimited lines are visible. The production web branch receives
the measured `{ height: 80, maxHeight: 120 }` style.

The component regression test separately switches the mocked native platform
to iOS and verifies that the same three-line value is multiline, has no
`numberOfLines`, and receives no measured height style. This Linux environment
cannot produce an iOS Simulator capture.
