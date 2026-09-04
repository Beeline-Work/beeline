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
semantic token shape and one set: Obsidian Refined. There is no theme picker;
the app ships this one visual language everywhere (the former Editorial Ink and
Ledger sets are retired). Obsidian content runs `#f0f0f3` /
`#c9c9d1`; `#83838d` and `#6c6c76` are reserved for chrome, labels, timestamps,
and redundant machine noise. Brass is `#b08a4a` in Obsidian (the Editorial
direction's single accent; the older gold `#c9a24b` is retired); diff green/red
remains the one domain-color exception.

## Shape

One corner radius, `groknight.radius = 3`, everywhere a box appears. No other
radius value ships. No *box* renders as a circle or a soft pill.

The identity tiles are the one place a box holds a drawing: a person or an
agent is one of Speakeasy's twelve creatures on a square plate at the house
radius, and the plate's polarity — coloured creature on ink, ink creature on
colour — is what states the type. See "Identity" below.

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

**A turn is announced by its byline, and the byline says who is talking.**
Each run opens with the speaker's 26px face tile, then the name in the
speaker's own signature hue — sentence case, medium weight, at body size — a
quiet mono `agent` tag where applicable, and the mono HH:MM stamp pinned to
the right. The name is never set in the 10px mono uppercase the design
reserves for things it wants you to ignore: for a long time it was, and four
voices read as one grey caption. Brass (#b08a4a) on the name marks the viewer
alone: that accent is the ONLY thing distinguishing your own message, never
weight, size, or geometry. There is no "YOU" caption and no dim-content trick.
Tighter space within paragraphs and more space between turns make the
transcript scannable without weakening the words.

**A voice states its name once per run, above the words.** A run's opening turn
carries the byline; consecutive entries by the same voice inherit it, and
anything else (another person, a merge summary) ends the run
(`buzz/ledger-attribution.ts`).

The two surfaces differ here, and only here, because they genuinely differ:

- **A Corner carries no byline name at all** — the tile-and-stamp rhythm only. Its
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

**A system notification is one sentence in one voice.** The server phrases
every one of them — a join, a leave, a yolo flip, a grant answer, a failed
turn, a pull request, a check, a scheduled prompt — as `<subject> <verb>
[ <object>][ · <consequence>]`: a name, a plain past-tense verb, the thing, one
short clause. No colon, no em dash, no trailing period, no URL in the text.
The phone has one renderer for it (`LedgerSystemLine`): the `meta` role in
`ledgerQuiet`, no avatar, the stamp in the right gutter, names in brass and
tappable, the object linked when it has a URL. Consecutive lines that share a
verb fold into one sentence — "Candy, Terra and Codex joined" — because three
identical captions in a row are noise, not record. A card is only for what a
tap must settle (a grant request, a permission ask, the merge summary), and
its header sentence is the same grammar.

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
right edge, no boxes and no row surfaces. Every row — Room or DM — is 64 tall
and reserves the same trailing column, so the age stamps read down a single
straight edge whether or not a row has corners. Only a DM row also carries a
leading 40px tile; a Room row's copy starts at the row's own left padding —
the two row kinds do not share a leading column, so nothing sits between the
row edge and a Room's name. Rows are parted by the shared `hairlineDivider`
and nothing else, so the slab shows through each one.

**The row leads with the name, and the name leads with its sigil.** The first
glyph of the name reports the row's kind, in brass: a DM row reads `@peer`, a
Room row reads `#room`; the rest of the name follows in the primary tone at one
size (18) and one weight. Corners keep `◇`; Workspaces on the rail carry no
sigil at all. **Only a DM row wears a tile** — its peer's own `IdentityMark`
leading its copy. A Room is many voices, so no one picture stands for it: a
Room row wears no tile and no leading spacer, and its `#name` sigil is the
row's mark. State no longer lives in the leading column: there is no state
glyph, no ring, no dot beside the name.

Line two is one preview line, single, truncated, in the quiet tone, with its
attribution in front: the viewer's own last message reads `you: ` in the muted
tone, anyone else's — a person or an agent alike — reads `@handle: ` in brass,
and an empty Room reads `No messages yet` with no attribution. So a row
previews the voice the transcript will show when it is opened.

**The index reads on three tones and nothing else**, the ledger's ladder at
index scale: the name is the brightest thing on the row (`textPrimary`), the
preview sits a step down on `ledgerQuiet` exactly as an inline handle does, and
everything the gutter carries is `ledgerGhost`.

**Metadata hangs in the right gutter, as it does in the transcript.** The age
stamp is one terse unit (`1h`, `3d`, `1w`), and under it sits the one brass
square's reserved slot. **Unread is a 7×7 brass square, and only that**: no
count, no weight, no `NEW` label, no row fill. The slot's width is reserved on
every row so the age stamp above it never shifts; a read row draws nothing in
it at all, and the square itself paints only when the row wants the viewer.
The same square lights when the Room wants the viewer for any reason — a
message past their read mark or a corner waiting on a human — and stays absent
while an agent merely works. Unread never reorders: needs-you clustering and
`meaningfulAt` recency stay the only sorting inputs. Every row-level decision — sigil, name, tile
seed, attribution, whether the square is lit — is derived once in
`apps/mobile/sources/buzz/room-list-row.ts` (`roomRowName`, `roomRowPreview`,
`roomRowNeedsAttention`), so the screen renders answers and never re-derives.

Preview text is sanitized where it is stored, not rewritten where it is drawn:
fenced code, markdown syntax, git and tool plumbing, bare 40-hex shas, and a
lone ref pointer (`remote/1a2b3c4`, `refs/heads/…`, `origin/main`) never reach
a row (`roomPreviewText`, `apps/mobile/sources/buzz/room-list-summary.ts`). A
row applies one reader-side floor and no more — `isMachinePreview` declines a
preview that a cache entry from an older build already holds, rather than
re-deriving it.

**Brass on the index means the row is talking to you.** The sigil, the
`@handle:` attribution, the attention square, and the compose square all take
the accent; nothing on the index pulses or spins. The Room's own corner life
is reachable through the reserved `⌄` slot at the row's right edge, which
expands the same set the corner count reports: only `live`, `needs-attention`,
and `open` corners (`roomListCorners`). `merged`, `archived`, and `failed`
corners are excluded outright rather than dimmed, so the count always equals
what expanding reveals; they stay reachable through the `ALL CORNERS` link the
dropdown ends with, which is the one place in the product a finished corner is
recorded. Expanded corners hang off a 1px rail, not a nested container.

**The plus is a brass square.** Compose is one 44pt brass square floating at
the bottom right of the list — ink `+`, no shadow, no rounding, contrast with
the slab its only affordance — opening the compose sheet. The header carries
no plus: it is the Workspace name and nothing louder, with `⌬ MEMBERS` beside
it as a quiet named affordance on the same mono tier as the index's own
section labels.

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

A person or an agent is one of Speakeasy's twelve creatures — fox, owl,
pigeon, hare, stag, whale, moth, octopus, heron, bear, cat, bat — on a square
plate. Source of truth: `apps/mobile/sources/buzz/faces/` (the twelve static
renders, Speakeasy's edge layer, the seed → face default) and
`apps/mobile/sources/buzz/identity-mark.ts` (the hue palette, the Workspace
plate), drawn by `components/buzz/IdentityMark.tsx`, the **one** identity
component in the product. Every avatar, transcript byline tile, Members row,
Workspace rail tile, picker row and Corner top bar renders that primitive; no
other file composes `buzz/faces`. A second `SomethingAvatar` component is the
drift this system replaced, and a test enforces that none comes back.

**1 · Species is the face.** The drawings are Speakeasy's originals, path for
path; nothing was redrawn. A person chooses their creature at onboarding
(`RoomViewIdentity.face`, server column `identities.face_id`); an identity
with no choice wears `defaultFaceForSeed(pubkey)` — Speakeasy's FNV-1a into
twelve — so every device draws the same animal for the same key. The old rule
that *shape is the type* (△ agent, ○ human) is retired: at the 8px it actually
shipped in the transcript no shape ever resolved, and a creature is a memory
hook in a way a triangle never was.

**2 · Plate polarity is the type.** A **person** is a coloured creature on an
ink plate: the drawing with Speakeasy's BRASS swapped for the identity's hue,
BONE and INK kept. An **agent** is the same creature inverted — figure entirely
INK on a plate filled with the agent's hue, the two eyes replaced by one BONE
lens band across where they were. The class reads from the plate before the
species resolves, which is why it survives at 26px where a silhouette did not.
A Workspace keeps its own plate (below).

**3 · Colour is the memory.** "beebee is the amber one." Each identity gets one
deterministic signature hue from its seed — a pubkey for a person or agent, the
community id for a Workspace — and keeps it forever, everywhere: on the
person's creature, on the agent's plate, and on the name in the byline.

The palette is **curated, never hashed**. Sixteen hand-placed hues span the
whole wheel with a hard 20° floor between neighbours; a raw `hash % 360` was
tried and it clusters, putting three identities in one list on three
near-identical purples. The array is stored scrambled rather than in hue
order, and a third luminance register helps two identities that do land on one
hue. The hue anchors are not a uniqueness claim; exact hue repeats become
likely in ordinary rosters, and the species and the name break the tie.

Saturation stays low so every tile sits inside the obsidian world rather than
on top of it, and each type carries a temperament as a quiet second reading:
agents warmer and a step more saturated, people cooler and greyer.

**4 · The edge layer is Speakeasy's, ported exactly.** BONE shapes vanish on a
light plate and INK shapes on a dark one, so a person's creature is drawn
twice: a second copy BEHIND it in which only the shapes painted the vanishing
tone are recoloured to the contrast tone and grown by three units
(`recolorEdge`, `EDGE_GROW`). The hairline shows only where such a shape is
the outer silhouette — bear, cat, bat, whale and pigeon on a dark plate; hare,
heron, moth and owl on a light one; never the hue-bodied fox, octopus and
stag. An agent needs no edge: ink on colour always contrasts. The shipped
themes are all dark; the light treatment exists so the same tile is correct
anywhere a light ground appears.

**5 · A gold ring means working.** An agent with a live turn or a live corner
right now takes a gold ring plus a wider low-alpha halo drawn *around* its
plate, breathing on the shared live clock (`HullLivePulse`). Its proof is the
server-indexed working receipt or the corner's canonical `working` state
(`selectWorkingAgents`), the same signal as the thinking line — never the
presence lease: a helper whose every turn fails still renews its lease, so
"alive" said nothing about whether the agent could answer (C77). It never touches the identity colour or the
creature: who this is and what it is doing stay two separate reads, and a
gold *fill* would have destroyed the first to say the second. It is mounted
only where something is genuinely live, so a quiet row pays for no clock.

**Workspace exception — the house brass plate.** A Workspace is not someone to
remember; it is the house itself. Every `▢` mark renders in ONE hue family —
the Speakeasy brass (`WORKSPACE_BRASS_HUE`, ≈40°, matched to the theme
accents) — regardless of its seed, as speakeasy's **3×3 block/slot/cut/void
plate** in tones of that brass. Per-Workspace distinction rides the fill axis
(solid / hollow / half), the nine-cell cypher and the luminance register only;
no green/lavender/other-hued workspace glyph may exist anywhere. Below
`CYPHER_MIN_SIZE` (24px) the plate goes solid. Fill and cypher live on the
Workspace plate alone now; people and agents no longer carry them.

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

Four sizes, one mono role, held by a lint. The roles live in
`apps/mobile/sources/buzz/groknight.ts` (`typeRoles`, on every theme as
`theme.buzz.type`); each carries family, size, line height (1.45×, rounded)
and tracking. A screen spreads a role; it never sets a raw size.

| role          | face                     | size | use                                              |
| ------------- | ------------------------ | ---- | ------------------------------------------------ |
| `hero`        | Space Grotesk Medium     | 22   | a screen's one big line, index row names (-0.3)  |
| `body`        | Space Grotesk Regular    | 16   | body text, row titles, buttons (sentence case)   |
| `bodyStrong`  | Space Grotesk SemiBold   | 16   | the emphasised cut of `body`                     |
| `meta`        | Space Grotesk Regular    | 13   | everything secondary: previews, captions, stamps, counts |
| `sectionHead` | Space Grotesk Medium     | 10   | section heads ONLY (tracking 2, uppercase)       |
| `machine`     | IBM Plex Mono            | 13   | literal machine output: commands, paths, hashes, code, tool rows |

Space Grotesk is the one reading face: names, rows, buttons, labels, bylines,
stamps. Mono is for strings a machine produced, never for a byline or a label.
Small tracked capitals exist only to divide a list into sections. The spacing
scale beside the roles is `space` (4 · 8 · 16 · 24 · 32 · 48) and `layout`
(rows 64 tall, sections 24 apart, screens start 24 below the header).

`calm-lint.design.test.ts` scans every `sources/**/*.tsx` for raw `fontSize:`
outside {22, 16, 13, 10} and `letterSpacing:` outside {-0.3, 0, 2}, and holds
each file to the count in `apps/mobile/design/calm-baseline.json`. A count may
only shrink: a surface PR that removes raw values regenerates the baseline
with `CALM_BASELINE_WRITE=1 npx vitest run sources/buzz/calm-lint`.

`Typography.mono()` still marks the deliberate machine identifiers, enforced by
the allowlist in `components/buzz/Typography.test.ts`; `Typography.ledger()`
is the transcript seam. Bricolage Grotesque is the logo lockup only.

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

The one drawn exception is the thinking line's glyph, `BeelineMarkSpinner`: a
brass stroke draws the Beeline mark's outline from nothing, lingers complete,
unwinds and redraws, on a 2s ping-pong. It is allowed because the loop returns
to nothing every cycle — it never fills up towards a finish — and because the
mark sits in a fixed 18px cell so nothing around it moves. Reduced motion, a
backgrounded app, and the settled row all show the same completed static mark.

## Color exceptions, stated so no one re-litigates them

1. **Brass (`#b08a4a` in Obsidian)** marks the viewer's byline name,
   a tagged `@handle` in prose (`MonoMarkdown`'s mention gloss — the Speakeasy
   chat effect), and
   the moment you act on agent work: the ring around a working agent's identity
   mark (working means a live turn or corner, never presence alone), live work
   elsewhere (the Corner's LIVE wave, the pinned corner line, and a Room on
   the index with a live corner), owner role,
   and the merge-approval action. It is never the *only* signal for any of
   these — each is redundantly encoded by shape, glyph, or copy. Note what brass
   is *not*: identity itself. An agent's plate carries its own signature colour,
   and brass only rings it — a brass-filled plate would spend the one accent on
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
