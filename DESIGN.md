# Buzzy visual language — the Obsidian Ledger

The phone is a single slab of obsidian. Beeline's output is logged across it.

That is the whole idea; everything below is what it costs to hold it. The
interface recedes to almost nothing, so the agent's output *is* the screen. No
cards, no bubbles, no per-message frames, no rules between turns — on any
surface. One shape family, one voice, one accent used twice on purpose.

It should read like an alien prophecy inscribed on a slab, not like a chat app.
The single governing rule of the transcript follows from that: **weight goes
down; tone and indentation do all the work.** Nothing in the ledger is loud by
being fat. Things are loud by being bright.

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
`#4e4e4e`, with `#767676` reserved for focus/selection. Chrome text runs
`#e4e4e4` → `#c9ccd1` → `#767676` → `#6c6c6c`. One accent, `#d7af5f` (gold), and
one sanctioned chroma exception, git-standard diff green/red inside diff views.

The transcript runs its own four-step ladder on top of that, and it is the
ledger's *only* hierarchy — `ledgerBright` `#f4f4f4` (live agent output, the
prophecy), `ledgerBody` `#b0b0b0` (ordinary text), `ledgerQuiet` `#7c7c7c`
(handles; also the 4.5:1 readable floor on the slab), `ledgerGhost` `#6c6c6c`
(right-gutter marginalia and collapsed machine noise). `ledgerGhost` sits below
4.5:1 deliberately — it is the ghosted register, it reuses the shipped
`textDisabled` value rather than inventing a dimmer one, and everything it
carries is redundant with copy the reader can reach another way.

## Shape

One corner radius, `groknight.radius = 3`, everywhere a box appears. No other
radius value ships. Nothing renders as a circle or a soft pill.

A box (border + fill + radius) appears only around:
- something the user must find and act on (an input, a button), or
- a small number of genuinely distinct, non-repeating regions of a screen
  (the merge-approval panel, a safety/policy notice).

A box never appears around a unit of content — a message, a list row, an
attachment, a fenced code block, an avatar. Those are separated by whitespace,
tone, and a leading glyph. **Per-message cards are retired.** They were the last
chat-app convention left in the product and they are gone from Rooms and Corners
alike.

A rule is not a box: one edge, no fill, no radius. It divides an *index* — the
Room list, the member list — and nothing else. **The transcript has no
delimiters at all:** no hairline between turns, none above a human's steer, none
under a system row. Inside the ledger, separation is vertical rhythm, and only
vertical rhythm.

## The ledger

A Room transcript and a Corner transcript are the same thing, rendered by the
same primitive: `apps/mobile/sources/components/buzz/Ledger.tsx`. Not a Room
version and a Corner version that resemble each other — one component, fed by
one branch in `buzz/chat/[channelId].tsx`. If a future change needs a shape only
one surface has, that is a real design fork and needs its own pass, not a quiet
second implementation.

**One weight, one size, one face.** Every word of the transcript is IBM Plex
Mono regular at 16/26 (`Typography.ledger()`) — agent output, a person's steer,
a handle, all of it. Bold is banned outright: it fought the inscribed feel, and
on a black slab a heavier cut reads as a smear rather than as importance. Even
markdown `**strong**` and headings resolve to a luminance step instead of a
weight (`MonoMarkdown`). Regular is also the readable floor here; there is no
lighter cut to reach for, and there must not be.

**An agent turn is the luminous layer.** Plain flowing text on bare obsidian: no
frame, no rule, no fill, no speaker glyph. It takes `ledgerBright` and a wide,
low-alpha symmetric halo — a zero-offset text shadow of its own tone
(`groknight.ledgerGlow`) — so it reads as lit from within rather than printed on
top. A whisper of bloom, never neon; it must never cost legibility. Rhythm alone
separates one paragraph from the next.

**A human turn is found by geometry, not by volume.** Your own steer pulls to
the right margin and drops one luminance step to `ledgerBody`. That is the whole
signal. There is no "YOU" caption, no signature, and no rule above it — on a
linear log, "the block that is inset and dim is mine" is learned once and never
has to be restated. A steer never out-glows the output it interrupts, so the
ledger keeps the light.

**A voice states its handle inline, once.** A speaker's turn begins with its
handle set *into* the first line — dim, uppercase, immediately followed by the
words, which wrap beneath it. A log line, never a name on its own row. It repeats
only on a speaker change: consecutive entries by the same voice inherit the
announcement, and anything else (another person, a corner card) ends the run
(`buzz/ledger-attribution.ts`).

The two surfaces differ here, and only here, because they genuinely differ:

- **A Corner carries no handle at all** — pure flowing prophecy. Its identity is
  already in the top bar. This is derived from the surface, never from a lookup:
  a Corner is one administering agent plus you, so *anything that is not your own
  steer is that agent*. Deriving it any other way is a real bug, not a style
  choice — `isAgent` depends on the roster, and a Corner that trusted it printed
  the signer's bare npub as a handle and dropped the agent's own words to the
  ordinary grey tier the moment the roster was empty or still loading.
- **A Room holds several voices, so each keeps one whisper-dim inline handle**,
  quiet enough to recede and legible enough to tell agents apart.

**Metadata hangs in the right gutter as ghosted marginalia.** A fixed-width 24h
stamp, and for a Room speaker the six discriminating characters of its npub
(`ledgerFingerprint`), set at `ledgerGhost` in a 36px margin and absolutely
positioned so they can never reflow the prose. Editor line numbers, verse
numbers — there so the centre column stays clean, not there to be read.

**Machine noise collapses to one ghost line.** `⋯ <what happened> · tap to
expand`, dimmest tier, on both surfaces. Two things feed it: a turn's tool run
(`ActivityTimeline` — commands, inputs, raw output, objective checklists, all of
it behind that one disclosure), and any wall of git/CLI output an agent pasted
into its own narration, which `buzz/ledger-text.ts` lifts out of the prose
around it. A `git push` rejection dump never prints down the slab.

The unit there is a **run of consecutive machine lines**, not a
blank-line-delimited block — a dump is usually written directly under the
sentence introducing it, and a block rule would either swallow that sentence or
miss the dump. The summary truncates; the disclosure copy beside it never does,
because the affordance is the reason the line exists. A fenced code block marks
itself with one hairline gutter and an indent, never a panel.

**A status is inscribed, never framed.** A status is not something the reader
must find and act on, so it earns no box: one dim line in `ledgerQuiet`, at the
same left margin as the prose above it. Only its affordance lifts — `view →`
hangs in the same right gutter the timestamps do, one tonal step brighter, with
a faint tonal flash on press and no border at any point. `◇` means corner (the
lifecycle glyph family) and `→` means enterable, and that pairing is the one
"enter this corner" vocabulary the transcript has: `WritePermissionOutcome` and
the Room's own corner card both use it.

**There is no reply echo under an agent turn.** Body threads every Room/DM reply
to the request that triggered it, so the quoted block was always the message
directly above — pure noise on a linear log. A person's own reply is a
deliberate reach back up the transcript, so it keeps its quote, on one dim line
with no bar beside it.

**Text is decoded before it is inscribed.** Percent escapes (`%3F`) are
transport, not content, and are resolved at the single projection funnel every
surface reads through (`buzz-event-projection.ts` → `decodePercentEncoding`), so
the transcript and the Room-list preview can never disagree.

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
label. It is deliberately not gold — see the accent rule below. The index is
the one surface that still spends weight: it is scanned, not read, and the
ledger's no-weight rule governs the transcript. Its *tones* are the ledger's,
though — the preview and its author label sit on `ledgerQuiet`, exactly as an
inline handle does, so a row previews the voice the transcript will show.

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

An agent's *name* is human-authored and never guessed twice. Every surface
resolves it through `resolveAgentDisplayIdentity` — validated soul overlay, then
the agent's own registered `displayName`, then the seed-derived placeholder —
and that resolution is only as good as the roster it is handed. An empty or
wrong-Workspace roster does not degrade the name; it replaces it with a
confident fake.

Both halves of an agent's registration are community-scoped: the identity record
is published into the community channel (`#h`) and the soul overlay is keyed
`communityId:agentPubkey`. So the transcript reads **every** Workspace the viewer
belongs to, channel's own first, then the viewer's selection, then the rest
(`agentRosterCommunityIds` + `mergeAgentRosters`) — because reading exactly one
and guessing wrong shows a placeholder rather than nothing. A Room and the
Members screen must never name the same key differently; if they do, one of them
is reading an empty roster, not a different name.

Vocabulary: "Room," never "Channel." "Members," never "People." No `#` prefix on
names — that's someone else's product's convention.

## Type

Three seams, one family in practice.

`Typography.ledger()` is the **inscription voice**: IBM Plex Mono regular, and
the transcript's whole type system. It takes no weight argument, because the
ledger has no weight axis to spend — emphasis is the luminance ladder and the
indent, and regular is the readable floor for light type on black. It is set at
16/26 throughout, one size for agent output, human steers, and handles alike.
The size is deliberately generous for a phone: mono at 16px gives roughly 34
characters to the line, which is short measure by the desktop rule and exactly
right for an inscription read at arm's length.

`Typography.mono()` stays the marker for deliberate machine identifiers
(commands, handles, roles, status, gutter stamps), enforced by an allowlist in
`components/buzz/Typography.test.ts`. It resolves to the same family as
`ledger()` — it is a semantic label, not a font switch, and the two must stay
separate seams so "this is a machine identifier" and "this is inscribed prose"
never collapse into one claim.

`Typography.default()` is everything outside the transcript, and the seam that
carries the rest of the app onto one family the moment `FontFamilies.default`
points at Plex Mono (the Plex Terminal Ledger change). Until that lands it is
still IBM Plex Sans. Bricolage Grotesque is the logo lockup only.

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
   not a third exception: it is `ledgerBright` at low alpha, luminance with no
   hue. That is deliberate — this "better Matrix" is monochrome, never green.
2. **Diff green/red** (`#3FB950`/`#F85149`, `groknight.diffAdded`/
   `diffRemoved`) exist only inside diff/change-review views, redundant with
   `+`/`−` prefixes and `A`/`M`/`D` status letters. This was a deliberate
   captain override of the zero-chroma rule for one universally-understood
   convention — it is not an opening to add more domain-convention colors
   elsewhere without the same explicit sign-off.
