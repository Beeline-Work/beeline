# Buzzy visual language — Obsidian Refined

The phone is a single slab of obsidian. Beeline's output is logged across it.

That is the whole idea; everything below is what it costs to hold it. The
interface recedes to almost nothing, so the agent's output *is* the screen. No
cards, no bubbles, no per-message frames, no rules between turns — on any
surface. One shape family, one voice, one accent used twice on purpose.

It should read like a focused technical conversation, not like a chat app. The
governing readability rule is **content near-white, chrome dim — never the
reverse**. Prose hierarchy uses weight: a semibold lead sentence or summary,
then a regular body with tight line-height and visible space between turns.

## The slab

The default Buzz surface is near-black (`#070708`), edge to edge, with no
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

Source of truth: `apps/mobile/sources/buzz/groknight.ts`. It exports one
semantic token shape and three sets: Obsidian Refined (default), Editorial Ink
(warm near-black and IBM Plex Serif prose), and Ledger (dense IBM Plex Mono).
Theme choice is device-local and app-wide. Obsidian content runs `#f0f0f3` /
`#c9c9d1`; `#83838d` and `#6c6c76` are reserved for chrome, labels, timestamps,
and redundant machine noise. Gold is `#c9a24b`; diff green/red remains the one
domain-color exception.

## Shape

One corner radius, `groknight.radius = 3`, everywhere a box appears. No other
radius value ships. No *box* renders as a circle or a soft pill.

The identity marks are the one deliberate exception, and it is a shape
*vocabulary*, not a softening: a mark's silhouette is what states its type, and
three silhouettes that a person can tell apart before reading anything need a
curve among them. See "Identity" below.

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
horizontal delimiters:** no hairline between turns, none above a human's steer,
none under a system row. A hairline left speaker rail is the exception: gold
for the viewer, neutral for agents (Ledger uses its blue/green speaker pair).
Vertical rhythm still does the primary separation.

## The ledger

A Room transcript and a Corner transcript are the same thing, rendered by the
same primitive: `apps/mobile/sources/components/buzz/Ledger.tsx`. Not a Room
version and a Corner version that resemble each other — one component, fed by
one branch in `buzz/chat/[channelId].tsx`. If a future change needs a shape only
one surface has, that is a real design fork and needs its own pass, not a quiet
second implementation.

**Type follows content kind.** Agent narration and human messages use the active
theme's prose family: IBM Plex Sans in Obsidian, IBM Plex Serif in Editorial,
and IBM Plex Mono in Ledger. Commands, handles, file paths, hashes, diffs, tool
rows, and corner names always use IBM Plex Mono. The first sentence of a turn
uses the semibold prose cut; remaining paragraphs use regular. Content stays
near-white on both sides of the conversation.

**A turn is found by rail and rhythm.** Plain flowing text stays boxless. The
viewer rail is gold and an agent rail is neutral; the dense Ledger theme uses
its explicit human-blue and agent-green rails. There is no "YOU" caption and no
dim-content trick. Tighter space within paragraphs and more space between turns
make the transcript scannable without weakening the words.

**A voice states its handle inline, once.** A speaker's turn begins with its
handle set *into* the first line — dim, uppercase, immediately followed by the
words, which wrap beneath it. A log line, never a name on its own row. It repeats
only on a speaker change: consecutive entries by the same voice inherit the
announcement, and anything else (another person, a merge summary) ends the run
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
"enter this corner" vocabulary the product has, shared by
`WritePermissionOutcome` and the pinned corner line below the transcript.

**A corner's status is never stamped into the transcript.** Not while it runs,
not after it ends. A note inscribed the moment a corner opened scrolls away and
then lies — still saying "open" long after the corner merged — and a terminal
stamp (`Alden ✕ FAILED`, `◇ OPEN`) interrupts a live conversation with a dead
record while duplicating the pinned line above the composer. So a Room has
exactly **one** active-corner affordance, the pinned line, and exactly one place
a finished corner is recorded, the Room's corners view. The transcript keeps the
conversation and nothing else.

**A turn in progress and an open corner are two different facts, and they get
two different lines.** A question being answered is transient and has nowhere
to go, so it shows as one unpressable `beebee thinking…` line that disappears
when the reply lands. A corner is a place that exists, so the pinned line names
it and opens it. They may show together, separately, or not at all, and neither
is ever derived from the other: an agent busy on a plain Room reply must not
light the corner line, and a corner line must never name a corner that has
merged, failed, or closed — a tappable dead channel is worse than no line at
all. Both gates are enforced in code (`buzz/room-indicators.ts`), because this
rule was once held by care alone and did not hold.

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
faceted mark. Line one is the name; line two is one human-readable activity
line — an uppercase mono author label, the same "who" the ledger's attribution
carries, then the preview.

**The index reads on three tones and nothing else**, the ledger's ladder at
index scale: the name is the brightest thing on the row (`textPrimary`), the
activity line sits a step down on `ledgerQuiet` exactly as an inline handle
does, and everything the gutter carries is `ledgerGhost`. So a row previews the
voice the transcript will show when it is opened.

**Metadata hangs in the right gutter, as it does in the transcript.** The age
stamp, and under it a Room's open-corner count, sit in a fixed 46px column that
is *absolutely positioned over* the row rather than laid out inside it — so
nothing hanging there can reflow the copy beside it, and every row reserves the
column whether or not it has a count. Same marginalia rhythm, same ghosted
register, one straight right edge down the whole screen.

Preview text is sanitized where it is stored, not rewritten where it is drawn:
fenced code, markdown syntax, git and tool plumbing, bare 40-hex shas, and a
lone ref pointer (`remote/1a2b3c4`, `refs/heads/…`, `origin/main`) never reach
a row (`roomPreviewText`, `apps/mobile/sources/buzz/room-list-summary.ts`). A
row applies one reader-side floor and no more — `isMachinePreview` declines a
preview that a cache entry from an older build already holds, rather than
re-deriving it.

Unread is weight plus one luminance step, in two places, plus a `NEW` mono
label. It is deliberately not gold — see the accent rule below. The index is
the one surface that still spends weight, and unread is the only thing it
spends weight on: it is scanned, not read, and the ledger's no-weight rule
governs the transcript.

**Gold on the index means one thing: an agent is working in this Room right
now.** A Room with a live corner takes the accent on its `◆` and on its corner
count, and the `◆` breathes on `HullLivePulse` — the single-mark form of the
corner's own `HullWaveSignal`, on the same clock, mounted only where there is
life. Nothing else on the screen takes it: `needs-attention` is the most
action-worthy state here and it escalates to the brightest *grey* instead,
precisely so gold keeps meaning exactly one thing. Every row-level decision —
which glyph, whether it is live, which corners count — is derived once in
`apps/mobile/sources/buzz/room-list-row.ts`, so the heading's LIVE tally and the
rows beneath it can never disagree.

A Room's corner count and its expanded dropdown are the same set: only `live`,
`needs-attention`, and `open` corners (`roomListCorners`). `merged`, `archived`,
and `failed` corners are excluded outright rather than dimmed, so the count
always equals what expanding reveals; they stay reachable through the
`ALL CORNERS` link the dropdown ends with, which is the one place in the product
a finished corner is recorded.
Expanded corners hang off a 1px rail, not a nested container.

The Room-list header is the Workspace name and nothing louder: the name is the
anchor, and `⌬ MEMBERS` / `＋ ROOM` sit beside it as quiet named affordances on
the same mono tier as the index's own section labels.

The Workspace rail is the same slab with one hairline edge. Selection reads
three redundant ways and none of them is a box or a fill: an edge bar (never a
floating bracket), the mark's own heavier frame, and tone — the Workspaces you
are *not* in recede a step rather than the one you are in lighting up. Every
rail command is *named* by a mono micro-label rather than framed in a box — the
affordance is named, not outlined — and its glyph sits on the chrome's quiet
tier, because the label already carries the meaning.

**Settings is one entry, not two.** The rail's `YOU` command opens the account
hub (`buzz/settings/`), which is itself an index in this same vocabulary —
boxless rows, one hairline between them, the three tones, the trailing mark in
the gutter. Every screen that mounts the rail routes there. Jumping past it
straight into `settings/identity` is what stranded the hub, and the product's
only sign-out with it.

## Identity

An identity mark answers four questions at once, on four independent axes, so
that recognising someone never depends on reading a name. Source of truth:
`apps/mobile/sources/buzz/identity-mark.ts` (pure, testable, no React Native)
drawn by `components/buzz/IdentityMark.tsx`, the **one** identity component in
the product. Every avatar, transcript handle mark, Members row, Workspace rail
tile, presence-sized dot and Corner top bar renders that primitive. A second
`SomethingAvatar` component is the drift this system replaced, and a test
enforces that none comes back.

**1 · Shape is the type.** `△` agent, `○` human, `▢` workspace. Agents are
angular and engineered, people are organic, Workspaces are structural — read
pre-verbally, at any size, before colour or detail resolves. This is why the
circle exists in a product that otherwise has no curves: the type distinction
is worth more than the purity, and it is contained to the marks alone.

**2 · Colour is the memory.** "beebee is the amber one." Each identity gets one
deterministic signature colour from its seed — a pubkey for a person or agent,
the community id for a Workspace — and keeps it forever, everywhere.

The palette is **curated, never hashed**. Sixteen hand-placed hues span the
whole wheel with a hard 20° floor between neighbours; a raw `hash % 360` was
tried and it clusters, putting three identities in one list on three
near-identical purples. Here two identities are either the *same* signature or
a clearly readable distance apart — "almost the same colour" is not a state
this system can produce. The array is stored scrambled rather than in hue
order, hue and cypher draw from independent PRNG streams, and a third
luminance register separates two identities that do land on one hue.

Saturation stays low so every mark sits inside the obsidian world rather than
on top of it, and each type carries a temperament as a quiet second reading of
what the shape already states: agents warmer and a step more saturated, people
cooler and greyer, Workspaces most neutral of all — structure should not
compete with the people inside it.

**3 · The cypher is the tiebreak.** Inside the silhouette, a hashed
nine-cell primitive grid drawn in tones of the signature colour (`void` /
`mid` / `bright`, where a void shows the mark's own deep tone rather than a
hole in the slab). One geometry per shape, all nine cells, so no type is a
weaker tiebreak than another: a **triangular mesh** for `△`, **radial rings ×
sectors** for `○`, and speakeasy's **3×3 block/slot/cut/void plate** for `▢`
(the FNV-1a + primitive-grid method is adopted from that product's `RoomMark`;
the tones are ours). Every cell is cut back from its neighbours — left
edge-to-edge, two adjacent same-tone cells fuse and the cypher stops being one.

The cypher is deliberately coarse, and below `CYPHER_MIN_SIZE` (24px) it is
dropped entirely: at handle and presence-dot scale the mark goes solid, because
there the colour and silhouette *are* the identity and nine cells of ~4px would
only mud them. That is the design, not a degradation.

**4 · A gold ring means alive.** An agent working right now takes a gold ring
plus a wider low-alpha halo *outside* its silhouette, breathing on the shared
live clock (`HullLivePulse`). It never touches the identity colour: who this is
and what it is doing stay two separate reads, and a gold *fill* would have
destroyed the first to say the second. The ring is drawn in the mark's own
shape — a circular halo around a triangle would blunt exactly the shape read
the system is built on — and it is mounted only where something is genuinely
live, so a quiet row pays for no clock.

A relay `picture` field never overrides any of this: `groknight
.photoIdentityMarksEnabled` gates the photo path for all three types in one
place and ships `false`. A photo would defeat every axis above at once.

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

Three semantic seams, with theme-selected prose.

`Typography.ledger()` is the semantic transcript seam and defaults to IBM Plex
Sans. Theme-aware transcript styles select Sans, Serif, or Mono from the token
set and select the regular/semibold cut by hierarchy.

`Typography.mono()` marks deliberate machine identifiers (commands, handles,
roles, status, gutter stamps), enforced by an allowlist in
`components/buzz/Typography.test.ts`. It always resolves to IBM Plex Mono,
independent of theme.

`Typography.default()` is IBM Plex Sans for prose outside theme-aware Buzz
surfaces. IBM Plex Sans, Mono, and Serif are bundled and loaded explicitly;
Bricolage Grotesque is the logo lockup only.

## Motion

Primitives live in `apps/mobile/sources/components/buzz/MonoHull.tsx`:
`HullSurface` (the lifted-region texture), `BrittlePress` (70ms in / 110ms out
press), `MonoButton`, `PixelLoader` (four-frame, ~7.5fps), `HullWaveSignal`
(9-segment sin² live wave), `HullLivePulse` (the same wave reduced to one
mark), `StatusGlyph`, `PixelGateReveal` (176ms strip reveal),
`NewMessageMaterialize` (140ms fade+rise). All reduced-motion aware via
`ReduceMotion.System`, and all of the continuous ones also stop when the app
backgrounds. No primitive exceeds ~240ms except the continuous, low-duty-cycle
loops, which share one clock (`motionTokens.liveCycle`).

At most two of `PixelLoader` / `HullWaveSignal` run on-screen at once.
`HullLivePulse` is deliberately outside that count: it is a single opacity
breath — no geometry, no layout, one animated style — mounted *only* where
something is genuinely live, so its instance count is bounded by real concurrent
agent work rather than by decoration. On the Room list that means one per live
Room, and if several Rooms are working at once the index is supposed to look
like it. A quiet row must never pay for a clock it does not use: mount the
primitive conditionally, do not pass it `active={false}`.

It is also **the only motion "live" is allowed to have.** The pinned corner line
and a working agent's gold ring both breathe on it — a calm heartbeat, on the
one clock. Live state must never be reported by something that *travels*: a
sweeping band, a moving crest, a progress bar, or a row of dashes all read as
"something is filling up towards a finish", which is a claim the product cannot
make about an agent's turn, and at rest they read as broken chrome. Breathing
says "still going" and claims nothing else.

## Color exceptions, stated so no one re-litigates them

1. **Gold (`#c9a24b` in Obsidian)** marks the viewer's transcript rail and the
   moment you act on agent work: the ring around a working agent's identity mark,
   live/online presence (the Corner's LIVE wave, a presence dot, the pinned
   corner line, and a Room on the index with a live corner), owner role, and the
   merge-approval action. It is never the *only* signal for any of these — each
   is redundantly encoded by shape, glyph, or copy. Note what gold is *not*:
   identity itself. An agent's mark carries its own signature colour, and gold
   only rings it — a gold-filled mark would spend the one accent on something
   that is true of every agent all the time, which is how an accent stops
   meaning anything. Do not add a second hue; do not let a further meaning
   attach to gold without checking whether it still needs to be redundant with
   something else first.
2. **Diff green/red** (`#3FB950`/`#F85149`, `groknight.diffAdded`/
   `diffRemoved`) exist only inside diff/change-review views, redundant with
   `+`/`−` prefixes and `A`/`M`/`D` status letters. This was a deliberate
   captain override of the zero-chroma rule for one universally-understood
   convention — it is not an opening to add more domain-convention colors
   elsewhere without the same explicit sign-off.
3. **Ledger speaker rails** use human blue and agent green only in the dense
   Ledger theme. They are redundant with speaker position/identity and do not
   authorize colored prose, chrome, or status decoration.
