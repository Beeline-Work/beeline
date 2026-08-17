# Buzzy visual language — the Obsidian Ledger

The phone is a single slab of obsidian. Beeline's output is logged across it.

That is the whole idea; everything below is what it costs to hold it. The
interface recedes to almost nothing, so the agent's output *is* the screen. No
cards, no bubbles, no per-message frames — on any surface. One shape family, one
voice, one accent used twice on purpose.

## The slab

Every Buzz surface is the same near-black (`#121212`), edge to edge, with no
second surface laid over it. Chrome — the Room-list header, the transcript
header, the Workspace rail — carries no background, texture, or plate of its
own: it is the same obsidian as the content it introduces, held apart by one
hairline and by type weight. Press and hover are the only luminance steps above
the slab (`#181818`, `#1e1e1e`).

A lifted surface (`HullSurface`, with its faint scratch texture) is reserved for
something that genuinely floats *over* the slab and does not repeat: a modal
sheet, the merge-approval panel, the write-permission card. Persistent chrome
never qualifies — if two adjacent regions of a screen are both permanent, they
are one slab.

Source of truth: `apps/mobile/sources/buzz/groknight.ts`. Borders run a single
`#4e4e4e`, with `#767676` reserved for focus/selection. Text runs `#e4e4e4` →
`#c9ccd1` → `#767676` → `#6c6c6c`. One accent, `#d7af5f` (gold), and one
sanctioned chroma exception, git-standard diff green/red inside diff views.

## Shape

One corner radius, `groknight.radius = 3`, everywhere a box appears. No other
radius value ships. Nothing renders as a circle or a soft pill.

A box (border + fill + radius) appears only around:
- something the user must find and act on (an input, a button), or
- a small number of genuinely distinct, non-repeating regions of a screen
  (the merge-approval panel, a safety/policy notice).

A box never appears around a unit of content — a message, a list row, an
attachment, a fenced code block, an avatar. Those are separated by whitespace,
weight, a leading glyph, and hairline rules. **Per-message cards are retired.**
They were the last chat-app convention left in the product and they are gone
from Rooms and Corners alike.

A rule is not a box: one edge, no fill, no radius. It is the sanctioned way to
divide a list or mark an interruption, and it is the only separator that repeats.

## The ledger

A Room transcript and a Corner transcript are the same thing, rendered by the
same primitive: `apps/mobile/sources/components/buzz/Ledger.tsx`. Not a Room
version and a Corner version that resemble each other — one component, fed by
one branch in `buzz/chat/[channelId].tsx`. If a future change needs a shape only
one surface has, that is a real design fork and needs its own pass, not a quiet
second implementation.

**An agent turn is the luminous layer.** Plain flowing text on bare obsidian: no
frame, no rule, no fill, no speaker glyph. It takes the brightest tone
(`textPrimary`) and a faint symmetric halo — a zero-offset text shadow of its own
tone (`groknight.ledgerGlow`) — so it reads as lit from within rather than
printed on top. Rhythm alone separates one paragraph from the next.

**A human turn is the loudest voice, and still boxless.** A person steering is
the one thing that must stay findable while scrolling a long ledger, so it
inverts every axis at once: a hairline rule interrupts the page above it, the
block pulls to the right margin, the type goes semibold, and a signature names
who. Four redundant signals, zero boxes. A steer never out-glows the output it
interrupts — it is found by weight and position, so the ledger keeps the light.

**Attribution is per voice, per run.** A Room holds several agents, so each
agent's entries carry a quiet inline mark and name: small, dim, mono, set above
the prose. A Corner has exactly one administering agent, named once in its top
bar, so a Corner attributes nothing per message. Inside a Room a voice announces
itself once and then keeps writing — consecutive entries by the same agent
inherit that announcement, and anything else (a person, a corner card) ends the
run so the next entry re-announces (`buzz/ledger-attribution.ts`).

**Machine noise collapses.** A turn's whole tool run — commands, inputs, raw
output, mid-run notes — folds into one dim line with its own disclosure, on both
surfaces (`ActivityTimeline`). Nothing the tools said ever prints as a wall down
the slab. A fenced code block marks itself with one hairline gutter and an
indent, never a panel.

The header names the surface honestly or names nothing. A Corner shows its own
kind:9007 slug, never the word "Room"; while either the channel kind or its name
is still resolving, a skeleton stands in rather than a guess. The approval panel
and diff review exist only in a Corner — that is a difference in content, not in
shape language.

## Index rows

The Room list is the screen the product opens on, and it is an index: one
leading column, one right edge, no boxes and no row surfaces. Every row — Room
or DM — hangs its copy off the same 30px leading unit and reserves the same
trailing disclosure column, so the age stamps read down a single straight edge
whether or not a row has corners. Rows are parted by the shared
`hairlineDivider` and nothing else, so the slab shows through each one.

The leading unit reports the row's kind: a Room shows one state glyph (`◆` live
corner, `▲` needs attention, `›` spoken in, `·` quiet); a DM shows its peer's
faceted mark. Line one is the name, then any flag, then the age in mono. Line
two is one human-readable line: an uppercase mono author label — the same "who"
the ledger's attribution carries — and the preview. Preview text is sanitized
where it is stored, not where it is drawn: fenced code, markdown syntax, git and
tool plumbing, and bare 40-hex shas never reach a row (`roomPreviewText`,
`apps/mobile/sources/buzz/room-list-summary.ts`).

Unread is weight plus one luminance step, in two places, plus a `NEW` mono
label. It is deliberately not gold — see the accent rule below.

A Room's corner count and its expanded dropdown are the same set: only `live`,
`needs-attention`, and `open` corners (`roomListCorners`). `merged`, `archived`,
and `failed` corners are excluded outright rather than dimmed, so the count
always equals what expanding reveals; they stay reachable through the Room
transcript's durable cards and the `ALL CORNERS` link the dropdown ends with.
Expanded corners hang off a 1px rail, not a nested container.

The Workspace rail is the same slab with one hairline edge. Selection is an edge
bar, never a floating bracket, and every rail command is *named* by a mono
micro-label rather than framed in a box — the affordance is named, not outlined.

## Identity

Every identity — agent, workspace, person — renders as a deterministic,
seed-derived, faceted polygon mark. No curves, no illustration assets, no photo
dependency. Agents get an angular drone-like frame with gold accent strokes;
workspaces get hex plating; people get a faceted mark distinct in silhouette
from an agent's but built from the same stroke system (`avatarInk`/`avatarSoft`/
`avatarDim`, `strokeLinejoin: 'miter'`, no `Circle`/`Ellipse`).

One concept gets one glyph, product-wide. Members are `⌬` everywhere the members
screen is reachable — the Room-list header, the Workspace settings section, the
empty-state entry, the screen's own title (`MEMBERS_GLYPH`,
`buzz/vocabulary.ts`) — and that mark stays visually distinct from the corner
lifecycle glyphs (`◆ ◇ ▲ ✕ ✓ □`, `buzz/corners.ts`), because a diamond on any
Buzz surface means live corner work, never people.

Vocabulary: "Room," never "Channel." "Members," never "People." No `#` prefix on
names — that's someone else's product's convention.

## Type

One family: IBM Plex Mono, for prose and machine labels alike — the full
terminal ledger. Body text asks for it by calling `Typography.default()`, which
is the seam that carries the whole app onto one family the moment
`FontFamilies.default` points at Plex Mono (the Plex Terminal Ledger change) —
so nothing in the ledger hardcodes a family of its own. Until that lands,
`Typography.default()` is still IBM Plex Sans and prose renders in it.

`Typography.mono()` stays the marker for deliberate machine identifiers
(commands, handles, roles, status) even once both resolve to the same family,
enforced by an allowlist in `components/buzz/Typography.test.ts` — it is a
semantic label, not a font switch. Bricolage Grotesque is the logo lockup only.

## Motion

Primitives live in `apps/mobile/sources/components/buzz/MonoHull.tsx`:
`HullSurface` (the lifted-region texture), `BrittlePress` (70ms in / 110ms out
press), `MonoButton`, `PixelLoader` (four-frame, ~7.5fps), `HullWaveSignal`
(9-segment sin² live wave), `StatusGlyph`, `PixelGateReveal` (176ms strip
reveal), `NewMessageMaterialize` (140ms fade+rise). All reduced-motion aware via
`ReduceMotion.System`. No primitive exceeds ~240ms except the two continuous,
low-duty-cycle loops (`PixelLoader`, `HullWaveSignal`), and no more than two of
those run on-screen at once.

## The two color exceptions, stated so no one re-litigates them

1. **Gold (`#d7af5f`)** marks: agent identity, live/online presence, owner role,
   and the merge-approval action. It is never the *only* signal for any of these
   — each is redundantly encoded by shape, glyph, or copy. Do not add a second
   hue; do not let a fifth meaning attach to gold without checking whether it
   still needs to be redundant with something else first. The ledger's glow is
   not a third exception: it is `textPrimary` at low alpha, luminance with no
   hue. That is deliberate — this "better Matrix" is monochrome, never green.
2. **Diff green/red** (`#3FB950`/`#F85149`, `groknight.diffAdded`/
   `diffRemoved`) exist only inside diff/change-review views, redundant with
   `+`/`−` prefixes and `A`/`M`/`D` status letters. This was a deliberate
   captain override of the zero-chroma rule for one universally-understood
   convention — it is not an opening to add more domain-convention colors
   elsewhere without the same explicit sign-off.
