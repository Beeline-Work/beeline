# Buzzy visual language — Obsidian Refined

The phone is a single slab of obsidian. Beeline's output is logged across it.

That is the whole idea; everything below is what it costs to hold it. The
interface recedes to almost nothing, so the agent's output _is_ the screen. No
bubbles or ordinary per-message frames. Structured system records and asks use
the one `TranscriptCard` anatomy; everything else stays on the slab.

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
something that genuinely floats _over_ the slab and does not repeat, such as a
modal sheet or merge-approval panel. Transcript asks use `TranscriptCard`'s
raised fill without the HullSurface texture; transcript records have no fill.

Source of truth: `apps/mobile/sources/buzz/groknight.ts`. It exports one
semantic token shape and two sets built from it: Obsidian Refined (dark) and
Bone (light), picked from a Settings → Appearance toggle (the former Editorial
Ink and Ledger sets are still retired — this is not their return, just a
light/dark pair of the one Speakeasy language). Obsidian content runs
`#f0f0f3` / `#c9c9d1`. The ledger's quiet tier (`ledgerQuiet`) carries the
ledger's own reading matter — previews, stamps, system lines, quoted
reply/forward excerpts — so it holds a WCAG-AA floor (≥4.5:1) on every resting
ground: `#90909B` in Obsidian, `#6F6455` in Bone (pinned in
`groknight.test.ts`; never re-dim it). `#83838d` and `#6c6c76` remain
reserved for chrome, muted labels, and the gutter's ghost tier. Brass is
`#b08a4a` in Obsidian (the Editorial direction's single accent; the older
gold `#c9a24b` is retired); diff green/red remains a domain-color
exception, and Two Inks is the fenced-block exception (see Color exceptions).

Bone is Obsidian's construction rules run in reverse: a warm bone canvas
(`#F3EEE4`) instead of the warm-dark aubergine, "content near-black, chrome
mid" instead of "content near-white, chrome dim," and brass darkened to
`#8a6323` since the shipped `#b08a4a` is tuned for contrast against
near-black and reads too light against bone. Every elevation, border, and
divider step keeps Obsidian's relative position on the ladder, re-based on
the bone canvas. Diff green/red ships as text color, not a swatch, so it is
tuned per canvas the same way brass is: Obsidian keeps `#3FB950`/`#F85149`,
Bone uses GitHub's light-mode diff text `#1a7f37`/`#cf222e` — that domain
color stays the diff exception (never a third hue on the slab), it is just no
longer one literal hex shared by every canvas. Two Inks lives only inside a
fenced block. The ledger's quiet ink is tuned per
canvas the same way: the gray bone shares with chrome (`#8B7F6E`) falls to
3.4:1 on the bone canvas, so Bone darkens `ledgerQuiet` to `#6F6455` (5.0:1)
while Obsidian lifts its own to `#90909B` (6.1:1). Both hold the AA floor
pinned in `groknight.test.ts`, and Bone's quiet tier reads darker than
chrome — content ink, tuned like brass and diff text rather than shared with
the gutter.

## Shape

The general box radius is `groknight.radius = 3`. The transcript card family is
the explicit exception: a 10px radius on a 1px `border` frame, matching the
composer.

The identity tiles are the one place a box holds a drawing: a person or an
agent is one of Speakeasy's twelve creatures on a square plate at the house
radius, and the plate's polarity — coloured creature on ink, ink creature on
colour — is what states the type. See "Identity" below.

A box (border + fill + radius) appears only around:

- something the user must find and act on (an input, a button), or
- a small number of genuinely distinct, non-repeating regions of a screen
  (the merge-approval panel, a safety/policy notice).

A box never appears around an ordinary message, attachment, or avatar. The
structured system-card catalog uses `TranscriptCard`: record tier for facts and
settled asks, ask tier only while a response is needed. Its head, body, rows,
code block, and footer share one spacing and type system on phone and desktop.

Choice options are plates, not ledger rows. A `choice` card (question or poll)
still uses `TranscriptCard` for the ask/record shell — identity, title, subline,
stamp, footer Skip. Its options are not `TranscriptCardRow`. That row is a
two-line ledger fact (state word, title, kind line, hairline). A poll option is
a tap target, so it is its own plate: house radius (`groknight.radius = 3`),
1px border, a gap of `space.sm` between plates, letter on a 26px square, label
in `body`, consequence in `meta` at `ledgerQuiet`. The plate is licensed by the
box rule above (something the user must find and act on). Grant / permission /
target-branch keep footer verbs; they are not option lists.

A rule is not a box: one edge, no fill, no radius. It divides an _index_ — the
Room list, the member list — and nothing else. Transcript messages use one
compact vertical rhythm within a same-speaker run. A speaker-changing byline
gets exactly twice that separation, using proximity alone; there are no turn
dividers. The only edges in the transcript are the quiet 2px left rules shared
by code blocks, tool readouts, and system lines. No speaker rails anywhere.

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
quiet mono `AGENT · model` label (falling back to `AGENT` when unavailable), and
the mono HH:MM stamp pinned to
the right. **The three written parts sit on one baseline.** They are set at two
sizes in two faces, so centring them against each other floats the 10px mono
half a line above the name's feet; the tile is a picture rather than a word, so
it alone stays centred on the row. The name is never set in the 10px mono
uppercase the design reserves for things it wants you to ignore: for a long
time it was, and four voices read as one grey caption. Brass (#b08a4a) on the
name marks the viewer
alone: that accent is the ONLY thing distinguishing your own message, never
weight, size, or geometry. There is no "YOU" caption and no dim-content trick.
Tighter space within paragraphs and more space between turns make the
transcript scannable without weakening the words.

**A human voice states its name once per run, above the words.** A human run's
opening turn carries the byline; consecutive human entries inherit it, and
anything else (another person, an agent message, a merge summary) ends the run
(`buzz/ledger-attribution.ts`). Every agent prose message instead carries its
own full byline and face tile, including consecutive and legacy-projected
messages: the top bar is context, never a substitute for the actual author.

The two surfaces differ here, and only here, because they genuinely differ:

- **A Corner's top bar complements, but never replaces, a message byline.** Its
  own agent messages keep their full author identity even while roster data is
  loading; a row must never fall back to a bare signer key or ordinary-grey prose.
- **A Room holds several voices, so each human run opens with its full byline;
  every agent message does** — name, quiet `AGENT · model` label, face tile,
  stamp. Model labels preserve their casing and truncate at the tail; effort
  never appears in the byline.

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
attachments keep their attachment rows.

**Expanding a machine run is one line per call, and opening a call is its
output.** Three levels — fold, line, detail — and each says something the level
above it did not. A call's line is a **verb** in a fixed narrow column (mono,
dim chrome: `ran`, `read`, `wrote`, `found`, `git`, or an MCP tool's own short
name), the **object** it acted on at the content tone, a **duration** only once
it passes a second (mono, tabular), and an **outcome** pinned right that is
_nothing at all_ when the call succeeded — absence reads faster than a tick —
`failed` in the diff red, or `running` in brass. The object comes from the
command; the harness's own title is a last resort, because a harness will
happily label a directory listing "Reviewed the current changes". A long
command truncates in the MIDDLE: the flags at the end are the half that says
which command this was. Opening one call shows its real output, capped to a few
lines with the rest one tap away, mono at the dim tone — and if all the wire
handed us was a transport envelope with a terminal id, it shows _nothing_,
because a machine identifier is not a result. A failed call arrives already
open, and the fold counts it. Nothing is coloured by tool kind, the command is
never printed twice, and there are no tool counters, file-count badges,
title/body stacks, or failure chips (`buzz/tool-call-row.ts` decides what a
call is, `components/buzz/ActivityTimeline.tsx` draws it — captain report
C88).

A wall of git/CLI output an agent pasted into its own narration remains a
separate ghost line, projected by `buzz/ledger-text.ts`; this rendering change
does not rewrite narrative messages. A `git push` rejection dump never prints
down the slab.

The unit there is a **run of consecutive machine lines**, not a
blank-line-delimited block — a dump is usually written directly under the
sentence introducing it, and a block rule would either swallow that sentence or
miss the dump. The summary truncates; the disclosure copy beside it never does,
because the affordance is the reason the line exists. A fenced code block marks
itself with a 2px left rule in Two Inks structure (see Color exceptions) —
the same vocabulary tool readouts use — never a panel.
Fences of up to four source lines stay inline with a Copy control and no inscription.
A longer fence is one inscribed line (language, line count, and byte size)
plus a four-line peek labelled with what it hides, and opens as a full-page
in-app ArtifactViewer route (`CodeBlock.tsx`, `artifact-viewer.tsx`) where long lines wrap. The
route carries the Room id, originating message id, and code-block index; Back restores the transcript and
re-centres that exact message even if new rows arrived while the code was open.
The byte size reads on the peek inscription and once at the top of the reader.
Copy copies the complete block, including lines hidden by the peek;
selectable text preserves source spaces and tabs. Unlabelled fences and the
`text`, `txt`, `plaintext`, `markdown`, and `md` labels stay monochrome.
Other labelled fences use Two Inks: `json` distinguishes keys from values;
all other labels use the generic scanner (see `syntax-highlight.ts`). Very
large bodies use the full-fidelity monochrome fallback in `CodeHighlighter.tsx`.

**Text still being written says so, and settles by dissolving.** A streaming
turn is not a finished message, and reading like one is a lie the reader pays
for when the words are overwritten or retracted underneath them. So a draft is
written in the provisional face and tone — the italic face (`proseItalic`, the
same family every other italic in the ledger uses) at `ledgerQuiet` — at the
identical size, leading and column as a settled turn, under the byline, tile
and stamp a settled turn would carry, byte for byte. Nothing about the frame
moves; only the words change register. The characters that just arrived fade up
out of the transcript ground as they land, and only those: text already read
never restates itself, nothing is revealed on a clock the producer did not set,
and a harness that REWROTE what it wrote settles whole rather than pretending
the replacement is new. When the durable reply lands, the provisional text
cross-fades into it — italic to upright, quiet to content tone — over one short
transition, and where the reply differs from what was streamed the dissolve is
what carries the reader across the difference; it never snaps. A turn that
FAILS keeps the words the reader was reading, still provisional, with the
server's failure line beneath them: nothing a person was part-way through
evaporates on its own. Reduced motion keeps the provisional register and drops
both animations (`buzz/streaming-prose.ts`, `components/buzz/StreamingProse.tsx`,
`Ledger.SettleFade` — captain report C98).

**A status is inscribed, never framed.** A status is not something the reader
must find and act on, so it earns no box: one dim line in `ledgerQuiet`, at the
same left margin as the prose above it. Only its affordance lifts — `view →`
hangs in the same right gutter the timestamps do, one tonal step brighter, with
a faint tonal flash on press and no border at any point. The drawn corner mark
(`CornerGlyph`: two strokes meeting at the bottom left) means corner, and `→`
means enterable; that pairing is the one "enter this corner" vocabulary used
by `WritePermissionOutcome`. The Room header uses the same mark as the corners
door to open the list rather than one corner.

**A system notification is one sentence in one voice.** The server phrases
every one of them — a join, a leave, a yolo flip, a grant answer, a failed
turn, a pull request, a check, a scheduled prompt — as `<subject> <verb>
[ <object>][ · <consequence>]`: an `@handle`, a plain past-tense verb, the
thing, one short clause. People without handles remain unnamed. No colon, no
em dash, no trailing period, no URL in the text.
The phone has one renderer for it (`LedgerSystemLine`): the `meta` role in
`ledgerQuiet`, no avatar, the stamp in the right gutter, names in brass and
tappable, the object linked when it has a URL. Consecutive lines that share a
verb fold into one sentence — "@candy, @terra and @codex joined" — because three
identical captions in a row are noise, not record. A card is only for what a
tap must settle (a grant request, a permission ask, the merge summary), and
its header sentence is the same grammar.

**A corner's status is never stamped into the transcript.** Not while it runs,
not after it ends. A note inscribed the moment a corner opened scrolls away and
then lies — still saying "open" long after the corner merged — and a terminal
stamp (`Alden ✕ FAILED`, `◇ OPEN`) interrupts a live conversation with a dead
record. So a Room has exactly **one** active-corner affordance, the named
corners door in its header, and that door opens the one place every corner —
running or finished — is recorded, the Room's corners list (also shown in the
desktop work-pane corner list). The transcript keeps the conversation and
nothing else.

**Nothing pins one corner above the composer.** There used to be a line there
naming "the" open corner; a Room holds many at once, so it could only ever
name one of them, and it sat between the reader and the field they were
typing in — chrome in the one place the product asks for attention. It is
retired, not dimmed: the door in the header is the way in, the corners list
answers "what is running", and the Room-list row's own state mark answers it
from outside. The turn line is now the only thing that hangs above the
composer. With no offline hint present, it hangs directly on the composer
with no gap.

**A turn in progress and an open corner are two different facts.** A question
being answered is transient and has nowhere to go, so it shows as one line with
the primary activity verb and elapsed seconds,
without a redundant `thinking` suffix, that disappears when the
reply lands — it navigates nowhere and cannot strand a reader in a dead
channel. When the server accepts a human steer into that exact running corner
turn, the counter briefly appends `· received`; this is the write response made
visible, not a transcript event or an optimistic client guess. The other thing
the line admits is a **stop in its right-hand slot, offered to
the person who asked and to nobody else** (`viewerMayStopTurn`): a question is
the asker's to take back, and a Room where anyone can silence anyone else's
agent mid-sentence is a different product. Everyone else sees the line exactly
as it was. The control is a brass square smaller than the 18pt mark beside it
(hit slop keeps the 44pt target). A press dims it; once pressed it empties to a
brass outline and the counter appends `· stopping` until the cancelled receipt lands,
so the press is visible before the write returns. **A stop keeps what was
already written** — the half-finished answer
settles as an ordinary message and the conversation carries on from it, the way
every stop button a person has used already behaves; retracting it would delete
words they had read and make stopping feel like undoing. The line's last word is
`stopped`, never `done`. A corner is a place that exists, so the header's corners door names the
place rather than the moment. Keeping the two apart is why the corner half
never reaches the turn line: an agent busy on a plain Room reply must not
report corner work. Finished corners remain accessible in the corners list
for reading their history; they are never presented as current work.

**There is no reply echo under an agent turn.** Body threads every Room/DM reply
to the request that triggered it, so the quoted block was always the message
directly above — pure noise on a linear log. A person's own reply is a
deliberate reach back up the transcript, so it keeps its quote, on one dim line
with no bar beside it.

**A quoted excerpt is provenance a reader still reads.** Two lines carry the
quote's provenance: the `↳` reply reference (`author · preview`) and the
`FORWARDED FROM #room` caption under a forwarded body. Both read at the quiet
tier — one tone below the body, never the gutter's ghost tier — and both
clear the AA floor the quiet tier holds, because a provenance line too dim to
read is a quote the reader cannot check
(`chat.quoted-excerpt.design.test.ts`).

**Text is decoded before it is inscribed.** Percent escapes (`%3F`) are
transport, not content, and are resolved at the single projection funnel every
surface reads through (`buzz-event-projection.ts` → `decodePercentEncoding`), so
the transcript and the Room-list preview can never disagree.

The header names the surface honestly or names nothing. A Corner shows its own
kind:9007 slug, never the word "Room"; while either the channel kind or its name
is still resolving, a skeleton stands in rather than a guess. A Room keeps its
linked repository as the subtitle. A Corner's subtitle names its opener and its
server-owned canonical state: `working`, `waiting`, `review`, or `archived`.
Only `waiting` takes brass; `working` and `review` use `ledgerQuiet`, and `archived` uses `ledgerGhost`, because brass marks what wants the viewer.
Every phone and desktop surface renders that contract field directly; PR and
check lifecycle remains narration and never becomes a second client state
machine. Membership consumes no
header width on either surface: the existing overflow sheet carries one Members
row with the current count and opens the existing roster. The Room header's
trailing slot carries the **corners door**: the brass `CornerGlyph` ALONE,
in its own 44pt box, with `space.lg` of bare slab before the overflow dots'
identical 44pt box. No word rides beside it. The two are **siblings** — same
box, same baseline, parted by slab — and the mark is sized to read at
optically the SAME mark-size as the dots: 28 of ink in the 44 box, the same
treatment as the Room-list pair, with the stroke held to the weight it painted
at 16 so the larger box does not read heavier (captain, 2026-09-21). The
accessible name carries the destination; the header stays quiet. It opens the Room's dedicated corners list
(`corners/[roomId]`, windowed with the same cap and archived fallback as the
desktop work-pane corner list) and is the Room's one active-corner affordance.
The approval panel and diff review exist only in a Corner — that is a
difference in content, not in shape language.

Beneath that header a Corner holds its objective — the human's own request, as
one inscribed line that stays for the life of the corner. A slug in the header
does not say what the work is for, and an objective that lives only in the empty
state disappears at the first message, which is when the transcript starts
burying it. It is prose in the secondary tone behind a brass `humanRail`
hairline, the mark the ledger already gives a human's words, and it carries no
box, no fill and no label: a box is for something the reader must act on, and
this is only ever a reminder. It wraps to its full height rather than
truncating, and when there is no objective it renders nothing rather than a
placeholder.

## Index rows

The Room list uses the approved Previews layout in Obsidian and Bone. The
workspace name and existing bezel avatar head the list; the workspace menu
(Members and authorized Workspace settings) sits beside that identity, with
compose in the same header. The search field stays visible below the conversation
toolbar on phone and desktop; its Search action focuses that field. Bookmarks is
a separate brass action beside Search. All, Unread, and Pinned text filters
the list without removing access to quiet Rooms. The Messages section remains
in the list. A Workspace with pinned Rooms opens on Pinned; otherwise it opens
on All.

`ConversationRow.tsx` is shared by mobile and desktop. Names use `body`. An
unread row sits on `bgUnread` with a `bodyStrong` name and a `textPrimary`
preview; a trailing brass dot means the Room has new messages, independent of
corner state; the row's corner summary shares that ground. Read cursors are
unchanged by this styling. Room names retain their brass `#`; DMs use the peer's identity.
On phone, the byline sits above a two-line `body` preview in `textSecondary`;
on desktop, author and preview share a two-line `meta` block. DMs omit the
byline because the peer is already named in the heading. Rows have generous
vertical space and a hairline between conversations. Self attribution is quiet;
other authors use brass. The app's Space Grotesk roles and theme tokens own type
and contrast. Rows grow with content; the old fixed 64px height is not a cap.

Desktop selection uses a subtle fill, one-pixel brass rule and “Open” label.
Mobile has no selected Room state: pressing a conversation navigates away.
Long press immediately toggles pin/unpin; pins are device-local and scoped to viewer and
workspace, separate from server-backed saved-message bookmarks.
The Pinned filter uses text, while pinned rows show the pin glyph. At the
default desktop sidebar width, all filters and both actions fit on the first
toolbar row; the visible search field stays below it. An empty Pinned view is
one shared component (`PinnedConversationsEmpty.tsx`) on phone and desktop: a
single pin glyph, a two-line 22px heading, copy explaining the long-press
action, and a quiet outlined Show all conversations action that returns to All.
Desktop section headings use 20px above and `space.xs` below; the following
row starts after 18px, without a second large section gap. Phone corner
summaries retain a `space.md` bottom margin before the next conversation.
Wide desktop windows keep a 76px Workspace rail beside the 380px default Room
sidebar; narrower windows retain the existing Workspace switcher overlay.

Corner summaries read “2 waiting” in brass when any corner waits; otherwise
they read “5 corners” in quiet ink.
The API batches canonical state derivation for visible corners; archived work
is excluded. On mobile the label opens the existing Room Corners page. On
desktop it toggles an inline list, waiting first, with each corner independently
selectable and draggable. The active Room initially expands; explicit per-Room
choices persist. Expanded rows use the canonical waiting/working/review/idle
vocabulary rather than inventing an ambiguous “needs you” state.

**The standalone corners list is that same index, full height.** The screen
opened from the Room header's corners door (`corners/[roomId]`) is chrome on
the slab like every other index: a hairline header with the Room name as the
eyebrow, the noun as the title, the count alone in a reserved gutter, and rows
at the index's own height as a FLOOR. Its row leads with the opener's 26px face
tile — the byline size, because the opener is secondary to the work — names the
corner at the brightest tier, carries one quiet line (who opened it, and the
PR/check narration once there is one), and closes with the state WORD in a
reserved cell beside the state circle. **A corner's name is never truncated
here**: this is the screen whose whole job is telling corners apart, so the
name prints in full and wraps to as many lines as it needs, and the row grows
with it. Uneven row heights are the accepted cost (captain, 2026-09-20). That
is why this one surface composes its label through `fullCornerTitle` rather
than `displayCornerTitle`'s three-word inline form. The word is not decoration: a circle alone encodes state in colour and
shape only, which is exactly the encoding a colour-blind reader and a screen
reader both lose. No explainer paragraph stands above the list; a screen that
has to describe what its own contents are has not been designed yet.

**The plus is a brass square.** Compose is one 44pt brass square floating at
the bottom right of the list — ink `+`, no shadow, no rounding, contrast with
the slab its only affordance — opening the compose sheet. The header carries
no plus: it is the Workspace name and nothing louder, with `MembersGlyph`
as the Members door. See [Identity](#identity) for the shared glyph and
accessible-name contract.

The Workspace rail is the same slab with one hairline edge. In the drawer,
selection reads three redundant ways: an edge bar (never a floating bracket),
the mark's own heavier frame, and tone — the Workspaces you are _not_ in recede
a step rather than the one you are in lighting up. Drawer commands have mono
micro-labels; their glyphs sit on the chrome's quiet tier.

The persistent desktop strip follows the approved original rail reference:
framed workspace avatars, an icon-only Add control near the top, and the
personal account avatar pinned at the bottom. Its selected workspace uses the
accent frame; it does not inherit the drawer's edge bar or visible command
labels. Each control still has an accessible name. Both rail forms share the
framed workspace picture geometry. Add scrolls with the Workspace tiles;
neither form carries Workspace Settings, which lives in the Room-list header
menu.

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
(`RoomViewIdentity.face`, server column `identities.face_id`); an **agent is
assigned** one — the first animal nobody in its Workspace wears, which also
gives it its name and its soul (`assignSeededAgentIdentity`) — and an identity
with neither wears `defaultFaceForSeed(pubkey)`, Speakeasy's FNV-1a into
twelve, so every device draws the same animal for the same key. Because that
assignment names the agent too, the face travels with the name through
`resolveAgentDisplayIdentity` to every tile: a surface that redraws it from
the seed puts a whale beside the name Foxy and un-does the dedup that kept two
agents apart. The old rule that _shape is the type_ (△ agent, ○ human) is
retired: at the 8px it actually shipped in the transcript no shape ever
resolved, and a creature is a memory hook in a way a triangle never was.

**2 · Plate polarity is the type.** A **person** is a coloured creature on an
ink plate: the drawing with Speakeasy's BRASS swapped for the identity's hue,
BONE and INK kept. An **agent** is the same creature with the hue moved out
from under it — the figure takes BONE wherever the person's carries the hue,
keeps INK, and stands on a plate filled with the agent's own hue. The class
reads from the plate before the species resolves, which is why it survives at
26px where a silhouette did not. Both classes draw the creature **whole**: the
agent was once a flat ink figure with a BONE lens band across its eyes, and at
26px that read as a blindfolded blob — the species never resolved and the eyes,
the one feature that makes a face a face, were the part deliberately deleted.
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
light plate and INK shapes on a dark one, so a creature is drawn twice: a
second copy BEHIND it in which only the shapes painted the vanishing tone are
recoloured to the contrast tone and grown by three units (`recolorEdge`,
`EDGE_GROW`). For a person the hairline shows only where such a shape is the
outer silhouette — bear, cat, bat, whale and pigeon on a dark plate; hare,
heron, moth and owl on a light one; never the hue-bodied fox, octopus and
stag. An agent's plate is always a light hue (lightness ≈0.62), so an agent
takes the light rule in either theme: an INK hairline under its bone shapes,
nothing under its ink ones. Obsidian is dark and Bone is light; the edge
layer's light-ground treatment was carried by Bone before Bone shipped, so
the same tile is already correct on either canvas.

**5 · A gold ring means working.** An agent with a live turn or a live corner
right now takes a gold ring plus a wider low-alpha halo drawn _around_ its
plate, breathing on the shared live clock (`HullLivePulse`). Its proof is the
server-indexed working receipt or the corner's canonical `working` state
(`selectWorkingAgents`), the same signal as the thinking line — never the
delivery-availability fact: a daemon can be available before it has claimed
work, so availability says nothing about whether it is working (C77). It never touches the identity colour or the
creature: who this is and what it is doing stay two separate reads, and a
gold _fill_ would have destroyed the first to say the second. It is mounted
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

**A picture in a bezel is seated in it, never cropped by it.** Every tile
that wears one — the rail tile, the room-list header plate, the Workspace
settings tile, and the person's Settings identity tile — derives one seat from
its own geometry (`buzz/workspace-tile.ts`): the picture is centred inside the
bezel and its radius is the tile's inner radius (tile radius less the bezel)
less the margin of slab around it. That makes the picture's curve concentric
with the bezel's, so the gap to the brass is the same width at the corners as
along the flats at every size. The identity tile is `IDENTITY_SETTINGS_TILE`,
not a Workspace constant. Coverage: `buzz/workspace-tile.test.ts`,
`components/buzz/workspace-nav-parity.contract.test.ts`,
`components/buzz/workspace-picture-seat.browser.test.ts`, and
`app/(app)/beeline/settings/identity-picture-seat.browser.test.ts`.

One concept gets one glyph, product-wide. Members chrome on the Room-list
header, the desktop workspace heading, and the corner roster row is
`MembersGlyph` (`components/buzz/MembersGlyph.tsx`), a peer of `RoomGlyph`:
stroke-only circle over a right-isosceles triangle (equal legs from the apex,
90° apex angle), no fill, no second person, with a heavier stroke than
`RoomGlyph`. The desktop work pane no longer offers members. `Members` is the accessible name (`MEMBERS_LABEL`,
`buzz/vocabulary.ts`). In-list titles (the Members page, Workspace settings, the
roster sheet) keep the word. The retired hexagon `⌬` and the Ionicons
`people-outline` stand-in stay gone. That mark stays visually distinct from the
corner lifecycle glyphs (`◆ ◇ ▲ ✕ ✓ □`, `buzz/corners.ts`), because a diamond on
any Buzz surface means live corner work, never people.

An agent's _name_ is human-authored and never guessed twice. Every surface
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
(gateway `mapping.ts` owns those), Room index rows, the
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

| role          | face                   | size | use                                                              |
| ------------- | ---------------------- | ---- | ---------------------------------------------------------------- |
| `hero`        | Space Grotesk Medium   | 22   | a screen's one big line, index row names (-0.3)                  |
| `body`        | Space Grotesk Regular  | 16   | body text, row titles, buttons (sentence case)                   |
| `bodyStrong`  | Space Grotesk SemiBold | 16   | the emphasised cut of `body`                                     |
| `meta`        | Space Grotesk Regular  | 13   | everything secondary: previews, captions, stamps, counts         |
| `sectionHead` | Space Grotesk Medium   | 10   | section heads ONLY (tracking 2, uppercase)                       |
| `machine`     | IBM Plex Mono          | 13   | literal machine output: commands, paths, hashes, code, tool rows |

Space Grotesk is the one reading face: names, rows, buttons, labels, bylines,
stamps. Mono is for strings a machine produced, never for a byline or a label.
The transcript's day caption is the one caption exception: the
`sectionHead` role in the `machine` face, with `ledgerQuiet` ink and `space.md`
vertical spacing (`Ledger.tsx`, wrapped onto the day-opener cell in
`room-message-cell.tsx`). Absolute weekday+date (`THU 17 SEP`) between days;
the date also rides that day's first byline stamp when the day is not today
(`17 SEP 16:58`). Today never carries a date on the stamp.
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
press), `MonoButton`, `PixelLoader` (four-frame, ~7.5fps — labeled-control busy
only), `HullWaveSignal`
(9-segment sin² live wave), `HullLivePulse` (the same wave reduced to one
mark), `StatusGlyph`, `PixelGateReveal` (176ms strip reveal),
`NewMessageMaterialize` (140ms fade+rise). All reduced-motion aware via
`ReduceMotion.System`, and all of the continuous ones also stop when the app
backgrounds. No primitive exceeds ~240ms except the continuous, low-duty-cycle
loops, which share one clock (`motionTokens.liveCycle`).

At most two of `PixelLoader` / `HullWaveSignal` run on-screen at once.
`HullLivePulse` is deliberately outside that count: it is a single opacity
breath — no geometry, no layout, one animated style — mounted _only_ where
something is genuinely live, so its instance count is bounded by real concurrent
agent work rather than by decoration. On the Room list that means one per live
Room, and if several Rooms are working at once the index is supposed to look
like it. A quiet row must never pay for a clock it does not use: mount the
primitive conditionally, do not pass it `active={false}`.

The provisional lane's two transitions (C98) are style-only and carry no
geometry: an arriving tail walks its colour up from the ground over 160ms, and a
settling reply cross-fades opacity with its provisional ghost over 220ms. Both
are inside the ~240ms bound, both stop the moment they finish, and both are
skipped outright under reduced motion — the provisional style stays either way.

It is also **the only motion "live" is allowed to have.** A working corner's
row and a working agent's gold ring both breathe on it — a calm heartbeat, on
the one clock. Live state must never be reported by something that _travels_: a
sweeping band, a moving crest, a progress bar, or a row of dashes all read as
"something is filling up towards a finish", which is a claim the product cannot
make about an agent's turn, and at rest they read as broken chrome. Breathing
says "still going" and claims nothing else.

A closed poll's fill is a still magnitude, not live progress. The ban on
travelling fills stands for turns, corners, checks, and any claim that work is
filling toward a finish. A closed poll is a recorded tally. Each option plate
may carry a still brass wash whose width is that option's votes over the
leading option's votes (the leader fills the track). The fill does not animate,
pulse, or sweep. Counts stay inscribed. Reduced motion changes nothing because
nothing moves. This is not a license for progress bars elsewhere.

The one drawn exception is the self-painting glyph: splash (`BootPaint`) paints
once and holds because that load ends; in-app load gates (`SurfaceGlyphLoader`)
and the thinking line (`BeelineMarkSpinner`) use the release loop — a brass
stroke draws the Beeline mark, immediately unwinds, and rests empty before
redrawing. It is allowed because the loop returns to nothing every cycle — it
never fills up towards a finish — and because the mark sits in a fixed cell so
nothing around it moves. Reduced motion, a backgrounded app, and a settled mark
all show the same completed static glyph. `PixelLoader`'s four dots stay only
on labeled-control busy (`MonoButton` / `BrassButton` / the Settings version
check), never as a page or Room/Corner load gate.

## Color exceptions, stated so no one re-litigates them

1. **Brass (`#b08a4a` in Obsidian)** marks the viewer's byline name,
   a tagged `@handle` in prose (`MonoMarkdown`'s mention gloss — the Speakeasy
   chat effect), and
   the moment you act on agent work: the ring around a working agent's identity
   mark (working means a live turn or corner, never presence alone), live work
   elsewhere (the Corner's LIVE wave, the Room header's corners sigil, and a
   Room on the index with a live corner), owner role,
   and the merge-approval action. It is never the _only_ signal for any of
   these — each is redundantly encoded by shape, glyph, or copy. Note what brass
   is _not_: identity itself. An agent's plate carries its own signature colour,
   and brass only rings it — a brass-filled plate would spend the one accent on
   something that is true of every agent all the time, which is how an accent
   stops meaning anything. Do not add a second hue; do not let a further meaning
   attach to gold without checking whether it still needs to be redundant with
   something else first.
   A poll tally uses brass as the pigment of that still wash because it is the one
   accent, not because brass now means "winner." Magnitude is the width; a unique
   leader is also the longest bar and `bodyStrong` on its label. Do not fill a
   whole plate in brass to mark the winner, and do not introduce a second hue for
   the graph. An open selected choice takes a brass border (the existing "moment
   you act" meaning), redundant with the letter square lighting. A costly option
   keeps `diffRemoved` on the letter only, redundant with the consequence naming
   the cost.
2. **Diff green/red** (`#3FB950`/`#F85149`, `groknight.diffAdded`/
   `diffRemoved`) exist only inside diff/change-review views, redundant with
   `+`/`−` prefixes and `A`/`M`/`D` status letters. Red is also the failed
   tool call and its error line in an expanded machine run (C88) — redundant
   with the word `failed` and with the row opening itself. This was a deliberate
   captain override of the zero-chroma rule for one universally-understood
   convention — it is not an opening to add more domain-convention colors
   elsewhere without the same explicit sign-off.
3. **Ledger speaker rails** use human blue and agent green only in the dense
   Ledger theme. They are redundant with speaker position/identity and do not
   authorize colored prose, chrome, or status decoration.
4. **Two Inks** (captain 2026-09-19, C composed with B) is the fenced-block
   palette: three roles — structure, name, value — in two theme-tuned hues
   drawn from the canvas family (aubergine lifted, and its cool complement),
   laddered by luminance so the block still parses in greyscale. The theme's
   `syntaxStructure`, `syntaxName`, and `syntaxValue` in
   `apps/mobile/sources/buzz/groknight.ts` own the palette values for each canvas;
   `groknight.test.ts` pins their contrast and luminance order. Hue is the redundant
   channel. It lives only inside a fenced block and the sheet that opens one;
   it does not authorize a fifth exception.

## Agent profiles

Agent bylines and roster identities open Profile. Mentions retain DM navigation. Profile uses the assigned 72px animal mark, a centered name (`agentProfileTypography.name`, 28/36 from the consolidated mock), handle, outlined Message action, two model/effort facts, expandable soul and linked merged work. A phone uses a page; a desktop transcript uses an adjacent pane. The owner uses inline Edit, Save, and Cancel for name and soul; the draft soul previews the generated appearance of the assigned animal. The edit state exposes the existing permission-gated controls, with the destructive action below them. Its field labels are readable body text, explanatory copy uses `ledgerQuiet`, and web/native switches share the brass track and canvas thumb. See [agent profiles](docs/agent-profiles.md) for authorization and verification scope.
