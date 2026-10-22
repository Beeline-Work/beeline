# Reproduction R1 — restore the working line

The owner's Android screenshot establishes the real Room defect: the live label
starts at the bar edge without the mark. This fresh emulator has no signed-in
Beeline installation; the closest native stand-in is `../../turn-line-proof`,
which mounts the shipped TurnProgressLine/TurnBandSlot and fonts on Android 36.
Its README records the adapters and reproduction steps.

Before: `before-obsidian.png` shows no mark and the label at 8dp.
After: `after-obsidian.png` and `after-bone.png` show the mark cell, label, elapsed
time and STOP in the original layout (label at 34dp: 8 + 18 + 8).
The production component matches 137fbfa71^ except the intentionally retained
TurnBandSlot onLayout formatting. The tests are restored verbatim from that parent.

Restored regression run on the broken component: four failures for the absent
mark. Fixed run: all fourteen TurnProgressLine tests pass. Room-bottom chrome,
calm and design checks also pass (forty-two tests total). Root typecheck and
UI component policy pass without baseline changes.
