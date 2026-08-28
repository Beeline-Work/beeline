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

The default Buzz surface is the Speakeasy brand canvas, a very dark aubergine
(`#14091A`, mapped at the token level in `groknight.ts` so every screen
inherits it), edge to edge, with no second surface laid over it. Chrome — the
Room-list header, the transcript header, the Workspace rail — carries no
background, texture, or plate of its own: it is the same canvas as the content
it introduces, held apart by one hairline and by type weight. Press and hover
are the only luminance steps above the slab; every elevation stop keeps its
pre-canvas offset from the base, so contrast relationships are unchanged.

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
and redundant machine noise. Brass is `#b08a4a` in Obsidian (the Editorial
direction's single accent; the older gold `#c9a24b` is retired); diff green/red
remains the one domain-color exception.

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
Room list, the member list — and nothing else. **Turns separate by one hairline
divider** (`turnDivider`, `#0e0e12`) at the top of each opening turn, plus
generous vertical padding; continuations of the same voice flow with no divider.
The only other edges in the transcript are the quiet 2px left rules shared by
code blocks, tool readouts, and system lines. No speaker rails anywhere.

## The ledger

A Room transcript and a Corner transcript are the same thing, rendered by the
same primitive: `apps/mobile/sources/components/buzz/Ledger.tsx`. Not a Room
version and a Corner version that resemble each other — one component, fed by
one branch in `buzz/chat/[channelId].tsx`. If a future change needs a shape only
one surface has, that is a real design fork and needs its own pass, not a quiet
second implementation.

**Type follows content kind — at ONE size.** Every message renders at the same
size (Space Grotesk 16 / lh ~1.55 in Obsidian); hierarchy on a long agent turn
comes from weight and brightness, never size: the first line takes the medium
weight at the primary tone, following paragraphs take regular at one step down.
A human message is plain body text — regular weight, primary tone, same size as
everything. It is NEVER bolded or enlarged; an earlier mockup auto-bolded user
messages into headlines and was explicitly corrected by the captain. Commands,
bylines, file paths, hashes, diffs, tool rows, and corner names always use IBM
Plex Mono.

**A turn is announced by its byline.** Each run opens with one mono line — a
small square dot, NAME · role · HH:MM, uppercase and letterspaced. Brass
(#b08a4a) dot and name mark the viewer alone: that accent is the ONLY thing
distinguishing your own message, never weight, size, or geometry. Everyone else
gets a steel dot. There is no "YOU" caption and no dim-content trick. Tighter space within paragraphs and more space between turns
make the transcript scannable without weakening the words.

**A voice states its name once per run, above the words.** A run's opening turn
carries the byline; consecutive entries by the same voice inherit it, and
anything else (another person, a merge summary) ends the run
(`buzz/ledger-attribution.ts`).

The two surfaces differ here, and only here, because they genuinely differ:

- **A Corner carries no byline name at all** — the dot-and-stamp rhythm only. Its
  identity is already in the top bar. This is derived from the surface, never
  from a lookup: a Corner is one administering agent plus you, so *anything that
  is not your own steer is that agent*. Deriving it any other way is a real bug,
  not a style choice — `isAgent` depends on the roster, and a Corner that trusted
  it printed the signer's bare npub as a handle and dropped the agent's own words
  to the ordinary grey tier the moment the roster was empty or still loading.
- **A Room holds several voices, so each run opens with its full byline** —
  name, quiet `agent` role tag where applicable, stamp.

**Prose turns carry their stamp inside the byline.** A folded machine run keeps
its fixed-width 24h stamp in the same row as its labels, pinned to the right edge
with tabular numerals. The middle summary truncates before the stamp moves or
wraps. The disclosure starts at the transcript content edge with no extra indent
gutter.

**Machine steps form a one-line ledger.** Every run of agent machine work,
including a single file edit, landing stage, or thought receipt, defaults to one
compact mono disclosure: attribution, distinct step labels, thought duration
when known, and the right-edge stamp all share one baseline. File edits are
ordinary machine steps, never a separate file card or title block; real user
attachments keep their attachment rows. Expanding reveals every tool call and
thought as the existing 44pt row with its restrained kind glyph, verb-object
label, quiet verdict, inline distilled failure reason when needed, and tabular
duration when supplied. Tapping a step opens its complete, selectable raw output
in `HullActionSheet`, never as inline multiline content. There are no tool
counters, file-count badges, title/body stacks, or failure chips; brass is spent
only on the failure cross.

A wall of git/CLI output an agent pasted into its own narration remains a
separate ghost line, projected by `buzz/ledger-text.ts`; this rendering change
does not rewrite narrative messages. A `git push` rejection dump never prints
down the slab.

The unit there is a **run of consecutive machine lines**, not a
blank-line-delimited block — a dump is usually written directly under the
sentence introducing it, and a block rule would either swallow that sentence or
miss the dump. The summary truncates; the disclosure copy beside it never does,
because the affordance is the reason the line exists. A fenced code block marks
itself with a 2px left rule in the theme's peak steel — the same vocabulary tool
readouts use — never a panel.

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

Unread is weight, plus one luminance step in two places — the whole row's
ground (`bgUnread`, an area fill, never a stroke) and the preview line rising
with the semibold name — plus a solid unread-count chip that takes the gutter's
age slot (near-white fill, dark mono numeral, radius 3; uncountable reads
`NEW`, exact counts cap at `9+`). The corner count keeps its own gutter slot in
both states, so a read row is age + corner count and an unread row is chip +
corner count. Unread never reorders: needs-you clustering and `meaningfulAt`
recency stay the only sorting inputs. It is deliberately not gold — see the
accent rule below. The index is
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

An identity mark answers five questions at once, on five independent axes, so
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
near-identical purples. The array is stored scrambled rather than in hue
order, hue, fill, and cypher draw from independent PRNG streams, and a third
luminance register helps two identities that do land on one hue. The hue
anchors are not a uniqueness claim: the closest measured agent pair is 100° /
120° at ΔE00 4.31, and exact hue repeats become likely in ordinary rosters.

Saturation stays low so every mark sits inside the obsidian world rather than
on top of it, and each type carries a temperament as a quiet second reading of
what the shape already states: agents warmer and a step more saturated, people
cooler and greyer.

**Workspace exception — the house brass.** A Workspace is not someone to
remember; it is the house itself. Every `▢` mark therefore renders in ONE hue
family — the Speakeasy brass (`WORKSPACE_BRASS_HUE`, ≈40°, matched to the
theme accents) — regardless of its seed. Per-Workspace distinction rides the
fill, cypher, and luminance-register axes only; no green/lavender/other-hued
workspace glyph may exist anywhere. Humans (○) and agents (△) keep their full
deterministic wheel.

**3 · Fill is the nameable collision axis.** Each identity is **solid**,
**hollow**, or **half-filled**, chosen from its seed on a stream independent of
colour and kept forever across Workspaces. The treatment occupies the full
interior field, so it survives at the shipped 26dp floor and can be said aloud:
“the solid amber one” versus “the hollow amber one.” It never rotates or
deforms the silhouette, and it stays inside the outer frame, away from the gold
live ring. All three states are complete mark treatments rather than contextual
decoration; a non-colliding identity therefore never changes appearance when a
roster changes.

**4 · The cypher is the tiebreak.** Inside the silhouette, a hashed
nine-cell primitive grid drawn in tones of the signature colour (`void` /
`mid` / `bright`, where a void shows the mark's own deep tone rather than a
hole in the slab). One geometry per shape, all nine cells, so no type is a
weaker tiebreak than another: a **triangular mesh** for `△`, **radial rings ×
sectors** for `○`, and speakeasy's **3×3 block/slot/cut/void plate** for `▢`
(the FNV-1a + primitive-grid method is adopted from that product's `RoomMark`;
the tones are ours). Every cell is cut back from its neighbours — left
edge-to-edge, two adjacent same-tone cells fuse and the cypher stops being one.

The cypher is deliberately coarse, and below `CYPHER_MIN_SIZE` (24px) both the
cypher and fill axis are dropped: at handle and presence-dot scale the mark goes
solid, because there the colour and silhouette *are* the identity and nine
cells of ~4px would only mud them. That is the design, not a degradation; all
shipped identity surfaces are currently 26dp or larger.

**5 · A gold ring means alive.** An agent working right now takes a gold ring
plus a wider low-alpha halo *outside* its silhouette, breathing on the shared
live clock (`HullLivePulse`). It never touches the identity colour: who this is
and what it is doing stay two separate reads, and a gold *fill* would have
destroyed the first to say the second. The ring is drawn in the mark's own
shape — a circular halo around a triangle would blunt exactly the shape read
the system is built on — and it is mounted only where something is genuinely
live, so a quiet row pays for no clock.

For humans and agents, a relay `picture` field never overrides any of this:
`groknight.photoIdentityMarksEnabled` and `PHOTO_OVERRIDES_ENABLED` both ship
`false`. Their picture-setting surfaces stay hidden and stored photos remain
inert data. **Workspace pictures are the sole exception (captain decision,
2026-08-28):** owners and admins may set or clear one in Workspace Settings;
the picture renders through the same `IdentityMark` primitive in the rail,
header, and switcher, falling back to the generated Workspace mark when absent
or unavailable. `apps/mobile/sources/buzz/photo-overrides.ts` owns both gates.

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

Vocabulary: "Room," never "Channel." "Members," never "People." Room and corner
names carry the `#` channel mark everywhere a surface EXPOSES them — chat
headers (`#<room>`, corners as `#<room>/<corner>`), push-notification titles
(gateway `mapping.ts` owns those), Room index rows, the pinned-corner line, the
Room-list corner dropdown, the standalone corners list, Workspace-settings room
lists, and Members references — all added at render through one
presentation-only derivation pair (`displayRoomIndexTitle` /
`displayCornerTitle`, `buzz/room-list-row.ts`). The mark is strictly
display-only: stored names, search keys, cache entries, navigation params,
route hints, and rename drafts never see it, a name already carrying the mark
is never double-prefixed, and the generic ROOM_LABEL fallback gains no mark (a
label is not a name). A corner whose parent Room name has not resolved yet
degrades to the honest `#<corner>` rather than blocking on another read.
Captain decision 2026-08, superseding the earlier no-`#` rule and the later
"two surfaces only" narrowing.

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

1. **Brass (`#b08a4a` in Obsidian)** marks the viewer's byline dot and name,
   a tagged `@handle` in prose (`MonoMarkdown`'s mention gloss — the Speakeasy
   chat effect), and
   the moment you act on agent work: the ring around a working agent's identity
   mark, live/online presence (the Corner's LIVE wave, a presence dot, the
   pinned corner line, and a Room on the index with a live corner), owner role,
   and the merge-approval action. It is never the *only* signal for any of
   these — each is redundantly encoded by shape, glyph, or copy. Note what brass
   is *not*: identity itself. An agent's mark carries its own signature colour,
   and brass only rings it — a brass-filled mark would spend the one accent on
   something that is true of every agent all the time, which is how an accent
   stops meaning anything. Do not add a second hue; do not let a further meaning
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
