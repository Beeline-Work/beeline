# Buzzy visual language — Grok Mono Hull

One shape family. One accent, used twice, on purpose. Two transcript layouts,
because a Room and a Corner are not the same conversation.

## Palette

Source of truth: `apps/mobile/sources/buzz/groknight.ts`. Backgrounds run a single
near-black (`#121212`) with two press/hover steps above it (`#181818`, `#1e1e1e`).
Borders run a single `#4e4e4e`, with `#767676` reserved for focus/selection.
Text runs `#e4e4e4` → `#c9ccd1` → `#767676` → `#6c6c6c`. There is one accent color,
`#d7af5f` (gold), and one sanctioned exception, git-standard diff green/red
(`#3FB950`/`#F85149`), inside diff views only.

## Shape

One corner radius, `groknight.radius = 3`, everywhere a box appears. No other
radius value ships. Nothing renders as a circle or a soft pill.

A box (border + fill + radius) appears only around:
- something the user must find and act on (an input, a button), or
- a small number of genuinely distinct, non-repeating regions of a screen
  (the merge-approval panel, a safety/policy notice).

A box never appears around a repeating content unit — a chat message, a list
row, an avatar. Those are separated by whitespace, a leading glyph, and (for
list rows only) a single hairline divider — never a filled, bordered, rounded
container.

## Identity

Every identity — agent, workspace, person — renders as a deterministic,
seed-derived, faceted polygon mark. No curves, no illustration assets, no
photo dependency. Agents get an angular drone-like frame with gold accent
strokes; workspaces get hex plating; people get a faceted mark distinct in
silhouette from an agent's but built from the same stroke system
(`avatarInk`/`avatarSoft`/`avatarDim`, `strokeLinejoin: 'miter'`, no
`Circle`/`Ellipse`).

## Rooms and Corners

One material, two layouts. A Room is many voices; a Corner is one agent
working. They share every primitive — tokens, faceted marks, MonoHull, the one
radius, the no-box rule — and deliberately diverge in layout, because the two
surfaces answer different questions.

**A Room transcript** renders every message through one row component
(`TranscriptRow`, in `buzz/chat/[channelId].tsx`): a small faceted avatar, a
`›`/`·` glyph, an uppercase mono label naming who, and body text. Many
participants, so every message names its author. A human's own short message is
the one layout exception — right-aligned and inset, carried by alignment.

**A Corner transcript is a ledger written by one hand**
(`components/buzz/CornerLedger.tsx`). A corner has exactly one administering
agent, so that agent's faceted mark and name sit in the top bar once and never
repeat: its turns render as plain flowing text — no avatar, no label, no glyph,
a lot of quiet. A whole turn's tool run folds into one collapsible line
(`ActivityTimeline`); a corner never prints a wall of output. A human's steer is
the one thing that must be findable while scrolling a long ledger, so it inverts
every axis the ledger uses at once: a hairline rule interrupts the page above
it, the block pulls to the right margin, the type goes semibold in the brightest
text tone, and a signature names who.

Neither surface boxes a message. The divergence is layout and density, never
shape language: same palette, same radius, same marks, same motion primitives.
The approval panel and diff review exist only in a Corner.

The header names the surface honestly or names nothing. A Corner shows its own
kind:9007 slug, never the word "Room"; while either the channel kind or its name
is still resolving, a skeleton stands in rather than a guess.

Vocabulary: "Room," never "Channel." No `#` prefix on names — that's someone
else's product's convention.

## Motion

Primitives live in `apps/mobile/sources/components/buzz/MonoHull.tsx`:
`HullSurface` (quiet/raised/code texture), `BrittlePress` (70ms in / 110ms out
press), `MonoButton`, `PixelLoader` (four-frame, ~7.5fps), `HullWaveSignal`
(9-segment sin² live wave), `StatusGlyph`, `PixelGateReveal` (176ms strip
reveal), `NewMessageMaterialize` (140ms fade+rise). All reduced-motion aware
via `ReduceMotion.System`. No primitive exceeds ~240ms except the two
continuous, low-duty-cycle loops (`PixelLoader`, `HullWaveSignal`), and no
more than two of those run on-screen at once.

## The two color exceptions, stated so no one re-litigates them

1. **Gold (`#d7af5f`)** marks: agent identity, live/online presence, owner
   role, and the merge-approval action. It is never the *only* signal for any
   of these — each is redundantly encoded by shape, glyph, or copy. Do not
   add a second hue; do not let a fifth meaning attach to gold without
   checking whether it still needs to be redundant with something else first.
2. **Diff green/red** (`#3FB950`/`#F85149`, `groknight.diffAdded`/
   `diffRemoved`) exist only inside diff/change-review views, redundant with
   `+`/`−` prefixes and `A`/`M`/`D` status letters. This was a deliberate
   captain override of the zero-chroma rule for one universally-understood
   convention — it is not an opening to add more domain-convention colors
   elsewhere without the same explicit sign-off.
