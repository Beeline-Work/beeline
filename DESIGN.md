---
name: Beeline
description: Obsidian Refined — agent work logged across one dark slab, with Bone as its light counterpart.
colors:
  brass: "#b08a4a"
  brand-mark: "#E5A645"
  obsidian-canvas: "#14091A"
  obsidian-raised: "#190e21"
  obsidian-unread: "#1a1220"
  obsidian-highlight: "#1e1326"
  obsidian-hover: "#21162a"
  obsidian-pressed: "#271c31"
  obsidian-border: "#291e33"
  obsidian-border-strong: "#3b3048"
  obsidian-text-primary: "#f0f0f3"
  obsidian-text-secondary: "#c9c9d1"
  obsidian-ledger-quiet: "#90909B"
  obsidian-text-muted: "#83838d"
  obsidian-ledger-ghost: "#6c6c76"
  bone-brass: "#8a6323"
  bone-canvas: "#F3EEE4"
  bone-raised: "#ECE4D5"
  bone-unread: "#EFE8DA"
  bone-highlight: "#E4D9C4"
  bone-border: "#DED2BC"
  bone-border-strong: "#C9BBA0"
  bone-text-primary: "#171310"
  bone-text-secondary: "#4A4038"
  bone-ledger-quiet: "#6F6455"
  bone-text-muted: "#8B7F6E"
  bone-ledger-ghost: "#A79C89"
  diff-added-obsidian: "#3FB950"
  diff-removed-obsidian: "#F85149"
  diff-added-bone: "#1a7f37"
  diff-removed-bone: "#cf222e"
  syntax-name-obsidian: "#a58ec6"
  syntax-value-obsidian: "#a8cde8"
  syntax-name-bone: "#6b5a83"
  syntax-value-bone: "#1e4460"
  dialog-danger: "#c4544d"
typography:
  hero:
    fontFamily: "SpaceGrotesk-Medium"
    fontSize: "22px"
    lineHeight: "32px"
    letterSpacing: "-0.3px"
  body:
    fontFamily: "SpaceGrotesk-Regular"
    fontSize: "16px"
    lineHeight: "23px"
    letterSpacing: "0"
  bodyStrong:
    fontFamily: "SpaceGrotesk-SemiBold"
    fontSize: "16px"
    lineHeight: "23px"
    letterSpacing: "0"
  meta:
    fontFamily: "SpaceGrotesk-Regular"
    fontSize: "13px"
    lineHeight: "19px"
    letterSpacing: "0"
  sectionHead:
    fontFamily: "SpaceGrotesk-Medium"
    fontSize: "10px"
    lineHeight: "15px"
    letterSpacing: "2px"
  machine:
    fontFamily: "IBMPlexMono-Regular"
    fontSize: "13px"
    lineHeight: "19px"
    letterSpacing: "0"
  prose:
    fontFamily: "SpaceGrotesk-Regular"
    fontSize: "16px"
    lineHeight: "23px"
rounded:
  house: "3px"
  code: "8px"
  transcript-card: "10px"
  room-card: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
components:
  button:
    rounded: "{rounded.house}"
    height: "44px"
    typography: "{typography.body}"
  transcript-card:
    backgroundColor: "{colors.obsidian-raised}"
    rounded: "{rounded.transcript-card}"
  room-card:
    rounded: "{rounded.room-card}"
  poll-option:
    rounded: "{rounded.house}"
  conversation-row-selected:
    backgroundColor: "{colors.obsidian-highlight}"
---

# Design System: Beeline

Source of truth for tokens: `apps/mobile/sources/buzz/groknight.ts` (`beelineThemes.obsidian`, `beelineThemes.bone`, `typeRoles`, `space`, `layout`), exposed to components as `theme.buzz`. Motion constants: `motionTokens` in `apps/mobile/sources/components/buzz/MonoHull.tsx`. The frontmatter mirrors those files; when they disagree, the code wins and this file is stale. Known drift from these rules is listed under [Design inconsistencies](#design-inconsistencies).

## Overview

**Creative North Star: "Obsidian Refined — the slab"**

The phone is a single slab of obsidian, and Beeline's output is logged across it. The interface recedes so the agents' work *is* the screen. There are no chat bubbles or per-message frames. Structured records and asks use the one `TranscriptCard` anatomy; everything else sits directly on the slab.

It reads like a focused technical conversation, not a chat app. The governing readability rule: **content near-white, chrome dim, never the reverse.** Prose hierarchy comes from weight and brightness at one size. Chrome (Room-list header, transcript header, Workspace rail) has no plate of its own; it is the same canvas as the content, held apart by one hairline and by type weight.

Bone is the same language run in reverse for light mode: content near-black, chrome mid, on a warm bone canvas. Settings → Appearance picks the theme; it follows the system until chosen.

**Key Characteristics:**
- One canvas, edge to edge; press and hover are the only luminance steps above it.
- One accent (brass), always redundant with shape, glyph, or copy.
- Four type sizes plus one mono role, held by a lint.
- Boxes only around what you act on, or around a single non-repeating region.
- Live state breathes; it never travels or fills.

## Colors

A near-monochrome aubergine-black (or warm bone) ladder with one brass accent and four named exceptions.

### Primary
- **Brass** (`accent`, Obsidian `#b08a4a`, Bone `#8a6323`): the viewer's own byline name, `@handle` mentions in prose, live work (a working agent's ring, the corners door, a Room with a live corner), owner role, unread dots, attention rings, and the action you take on agent work. Bone darkens it because the Obsidian brass is too light on bone. `brassWash` / `brassWashStrong` (18% / 28% alpha) are its only tints.
- **Brand mark gold** (`brandMark`, `#E5A645`, from `buzz/brand.json`): the Beeline mark and a live workflow glyph only.

### Neutral
- **Canvas** (`bgBase` / `bgVoid` / `appCanvas`): Obsidian `#14091A` (Speakeasy's aubergine), Bone `#F3EEE4`.
- **Elevation ladder**: `bgRaised`/`bgCode` → `bgUnread` → `bgHighlight` (selection) → `bgHover` → `bgPressed` → `bgTexturePeak`. Each stop keeps the same relative offset in both themes.
- **Content inks**: `textPrimary` (narration, human messages, names), `textSecondary` (body under a lead line, previews).
- **Ledger quiet** (`ledgerQuiet`, Obsidian `#90909B`, Bone `#6F6455`): the ledger's own reading matter — previews, stamps, system lines, quoted excerpts. It holds WCAG AA (≥4.5:1) on every resting ground, pinned in `groknight.test.ts`. Never re-dim it.
- **Chrome / muted** (`textMuted`, `chrome`): labels and chrome only, never narration.
- **Ghost** (`ledgerGhost`, `textDisabled`): idle glyphs, skipped steps, the gutter's lowest tier.
- **Borders**: `border` (hairlines), `borderStrong` (rules, connectors, pending rings).

### Appearance
Obsidian Refined is the default. Bone is its only counterpart (the older Editorial Ink and Ledger sets are retired). Both share `radius`, type roles, and spacing; only colour values differ. `unistyles.ts` registers each at three text sizes.

### Color exceptions
Stated so no one re-litigates them. Each is redundant with a non-colour signal, and none licenses a fifth.

1. **Brass** is the one accent (see Primary). It never fills an identity plate: an agent's plate carries its own hue and brass only rings it. A closed poll's still brass wash is pigment for magnitude, not "winner"; the leader is also the longest bar and `bodyStrong`.
2. **Diff green/red** (`diffAdded`/`diffRemoved`) appear only in diff and change-review views and on a failed tool call, redundant with `+`/`−`, status letters, or the word `failed`. Tuned per canvas because they ship as text colour.
3. **No speaker rails.** No transcript rail carries a human or agent colour; the ledger reads by proximity and byline.
4. **Two Inks** (`syntaxStructure`, `syntaxName`, `syntaxValue`) is the fenced-code palette: three roles in two hues from the canvas family, laddered by luminance so a block still parses in greyscale. It lives only inside a fenced block and the reader that opens one.

`dialogDanger` (`#c4544d`) marks destructive dialog actions only.

## Typography

**Reading face:** Space Grotesk (Regular, Medium, SemiBold)
**Machine face:** IBM Plex Mono (Regular, Italic, SemiBold)
**Emphasis:** Space Grotesk Medium. Space Grotesk ships no italic, so emphasis is weight, never a second family.

**Character:** a technical grotesk for everything a person reads, and a plex mono reserved for strings a machine produced.

### Type
Four sizes, one mono role, held by a lint. The roles live in `typeRoles` (on every theme as `theme.buzz.type`). Each carries family, size, line height (1.45×, rounded) and tracking. A screen spreads a role; it never sets a raw size.

| role          | face                   | size | line | use                                                              |
| ------------- | ---------------------- | ---- | ---- | ---------------------------------------------------------------- |
| `hero`        | Space Grotesk Medium   | 22   | 32   | a screen's one big line (tracking −0.3)                          |
| `body`        | Space Grotesk Regular  | 16   | 23   | body text, row titles and names, buttons (sentence case)         |
| `bodyStrong`  | Space Grotesk SemiBold | 16   | 23   | emphasised `body`; page titles                                   |
| `meta`        | Space Grotesk Regular  | 13   | 19   | previews, captions, stamps, counts, eyebrows                     |
| `sectionHead` | Space Grotesk Medium   | 10   | 15   | section heads only (tracking 2, uppercase)                       |
| `machine`     | IBM Plex Mono          | 13   | 19   | commands, paths, hashes, code, tool rows, byline tags and stamps |

Transcript prose uses `proseSize` 16 on `proseLineHeight` 23, the `body` role's own leading. Transcript cards use the same 16/23 body, with `machine`-size (13) kinds and paths (`transcriptCard`).

The transcript's day caption is the one caption exception: `sectionHead` in the `machine` face at `ledgerQuiet` (`THU 17 SEP`). The date also rides that day's first byline stamp when the day is not today.

**The Calm Lint.** `calm-lint.design.test.ts` scans every `sources/**/*.ts(x)` for raw `fontSize:` outside {22, 16, 13, 10}, `letterSpacing:` outside {−0.3, 0, 2}, and computed sizes (arithmetic or ternaries), and holds each file to its count in `apps/mobile/design/calm-baseline.json`. The token sources (`buzz/groknight.ts`, `theme.ts`) are not scanned. Counts only shrink; regenerate with `CALM_BASELINE_WRITE=1 npx vitest run sources/buzz/calm-lint`. `Typography.mono()` marks deliberate machine identifiers (allowlist in `components/buzz/Typography.test.ts`).

**The Mono Is For Machines Rule.** Space Grotesk carries names, rows, buttons, labels and bylines. Mono is for strings a machine produced, plus the byline's model tag and stamp.

## Layout

- **Spacing scale** (`space`): 4 · 8 · 16 · 24 · 32 · 48 (`xs`…`xxl`). `layout`: rows 64, sections 24 apart, screens start 24 below the header.
- **Transcript rhythm:** 12 between entries in a same-speaker run, 24 at a speaker change, by proximity alone; no turn dividers. Prose shares one left content edge; stamps hang in a right gutter.
- **Phone Room list:** each section is one card (`roomCard`: radius 14, inset 16, 8 between sections) with hairlines between rows inside it. Rows have a 68 minimum height on phone, 62 on desktop, and a one-line `meta` preview.
- **Desktop:** a 76 px Workspace rail beside a 380 px Room sidebar at windows ≥1360 px wide; narrower windows use the Workspace switcher overlay. A second pane (corners, artifacts) defaults dismissed and opens only with a reason.
- **Touch targets:** 44 pt for every control (corners door, overflow, compose, reference chips, opened-corner links).

## Elevation & Depth

Flat by default. Depth is tonal: the elevation ladder in Colors, one hairline, and type weight. Chrome carries no plate, texture, or shadow.

- **Lifted surfaces** (`HullSurface`, a faint scratch texture) are reserved for something that genuinely floats over the slab and does not repeat: modal sheets and the merge-approval panel.
- **Floating surfaces** (`HullDialog`, `HullActionSheet`) carry the one product-wide shadow (`dialogShadowColor` `#000`, radius 48, y-offset 18) at a per-theme `dialogShadowOpacity`: 0.55 on Obsidian, 0.14 on Bone, where the denser shadow reads as a grey smear.
- **No other shadow and no blur.** Prompts, toasts and hint panels sit flat on `bgRaised` with a hairline. The one exception is the listening mic's brass glow, which tracks voice volume (a live signal, not elevation).
- Transcript asks use `TranscriptCard`'s raised fill without texture; transcript records have no fill.

**The Flat Chrome Rule.** Headers, rails and lists never gain a fill or shadow to separate themselves; a hairline and weight do that work.

## Shapes

### Shape
- **House radius** `radius = 3`: inputs, buttons, poll plates, reference chips, identity plates.
- **Transcript card family:** radius 10 on a 1 px border, matching the composer. Code blocks inside a card use 8.
- **Phone Room-list cards:** radius 14 (`roomCard.cornerRadius`).
- Circles for state (`StateCircle`), dots and counts.

A **box** (border + fill + radius) appears only around something the user must find and act on (an input, a button, a poll option), or a small number of distinct, non-repeating regions (the merge-approval panel, a safety notice, a grant card). A box never wraps an ordinary message, attachment, or avatar.

A **rule** is one edge, no fill, no radius. Hairlines divide an index (Room list, members, settings). In the transcript, code fences and ghost lines take a quiet 2 px left rule; tool runs use a hairline top edge.

**Choice options are plates, not ledger rows.** A poll or question option is its own house-radius plate with a 1 px border, `space.sm` apart, a letter on a 26 px square, label in `body`, consequence in `meta` at `ledgerQuiet`.

## Components

### The ledger
Rooms and corners render one transcript primitive, `components/buzz/Ledger.tsx`, fed by one branch in `app/(app)/beeline/chat/_chat-surface.tsx`. A shape only one surface needs is a design fork, not a quiet second implementation.

- **One size.** Every message is Space Grotesk 16/23. A long agent turn's first line takes Medium at `textPrimary`; following paragraphs take Regular one step down. A human message is plain body text, never bolded or enlarged.
- **Byline.** Each run opens with a 26 px face tile, the name in the speaker's signature hue (Medium, body size), a mono `machine` tag (the model name, or `AGENT`), and the mono HH:MM stamp pinned right. The written parts share one baseline; the tile is centred. Brass on the name marks the viewer (and agents with a generated portrait). A human run's first entry carries the byline; every agent message carries its own (`buzz/ledger-attribution.ts`).
- **Machine runs.** Agent tool work folds to one mono line: `N steps · F failed · duration`. Expanded, each call is one line: family glyph (`>_` shell, `≡` file, `⋯` thought, `·` other) at `ledgerGhost`, the object at content tone, duration only past one second, and a verdict pinned right (dim `✓`, brass `✗` with the reason inline, or the one spinner). Long commands truncate in the middle. Opening a call shows its output in `ToolOutputSheet`, never inline (`buzz/tool-call-row.ts`, `buzz/tool-ledger.ts`, `components/buzz/ActivityTimeline.tsx`).
- **Machine noise.** A wall of git/CLI output an agent pastes into its narration is projected as a separate ghost line (`buzz/ledger-text.ts` `splitLedgerText`) with a 2 px `agentRail` left rule. The unit is a run of consecutive machine lines, not a blank-line block.
- **Fenced code.** A fence of up to four lines stays inline with Copy. A longer fence is one inscribed line (language · lines · bytes) plus a four-line peek, and opens the full-page `ArtifactViewer` route; Back re-centres the originating message. Copy copies the whole block. Plain labels (`text`, `md`, …) stay monochrome; others use Two Inks; very large bodies use the monochrome fallback (`CodeBlock.tsx`, `syntax-highlight.ts`, `CodeHighlighter.tsx`).
- **Provisional text.** A streaming draft renders as plain prose at `ledgerQuiet`, in the same face, size, leading and column as a settled turn, under the same byline. When the durable reply lands it cross-fades in over 220 ms; reduced motion settles instantly. A failed turn keeps the draft with the failure line beneath (`components/buzz/StreamingProse.tsx`, `Ledger.tsx`).
- **System lines.** One sentence, `<subject> <verb>[ <object>][ · <consequence>]`, rendered by `LedgerSystemLine` in `meta` at `ledgerQuiet`: no avatar, no rule, names in brass and tappable, stamp in the right gutter. Same-verb runs fold ("@a, @b and @c joined", `buzz/system-lines.ts`). A card is only for what a tap must settle.
- **No corner status in the transcript.** A Room's one active-corner affordance is the corners door in its header; nothing pins a corner above the composer.
- **Turn line.** A question being answered shows one line above the composer: activity verb + elapsed seconds, `· received` when a steer lands, `· stopping` then `stopped` after a stop. The stop control (`■ STOP`, brass `sectionHead`) is offered to the requester and Room owners/admins (`viewerMayStopTurn`); a stop keeps what was written.
- **Replies and quotes.** The `↳ author · preview` reference and the `FORWARDED FROM #room` caption read at `ledgerQuiet`. A reply to the message directly above shows no echo.
- **Header.** A corner shows its name; a Room shows its linked repository as the subtitle. A corner's subtitle names its opener and canonical state: `waiting` in brass, `working`/`review` at `ledgerQuiet`, `archived` at `ledgerGhost`. The Room header's trailing slot holds the corners door (brass `CornerGlyph` alone in a 44 pt box) beside the overflow dots. The Room and corner overflow sheets both carry Members with a live count.
- **Corner objective.** Under a corner's header, `CornerObjectiveLine` shows the objective in `textSecondary` behind a 2 px `humanRail`, a brief preview (≤3 lines) with a brass "Read brief" link, and the live workflow step when one runs. No box, no label; it wraps rather than truncates.

### Transcript cards
`TranscriptCard` is the one structured-card anatomy (grant, permission, merge summary, choice, notification): head with identity, title, subline and stamp; rows; code block; footer verbs. Record tier for facts and settled asks, ask tier (raised fill) only while a response is needed. Radius 10, 1 px border, 16 side padding, 26 px identity.

### Buttons
- **`Button`** (`components/buzz/Button.tsx`) is the one button: house radius, 44 tall, `body` label in Space Grotesk Medium, sentence case, a pressed state. Variants: `primary` (filled `buttonPrimaryFill`), `secondary` (1 px `borderStrong`), `brass` (1 px `accent`, brass label).
- **Busy:** `PixelLoader` (four frames, ~7.5 fps) appears only inside a labelled control.

### Index rows
- **`ConversationRow.tsx`** is shared by phone and desktop. Names use `body` (SemiBold when unread); previews are one `meta` line in `textSecondary` (`textPrimary` when unread) with `@author · ` inline. Room names carry a brass `#`. A trailing brass dot means new messages; it gains a ring only while the Room needs the viewer (an approval waiting or an unread mention, `roomRowAttentionReason`). Long press toggles a device-local pin.
- **Desktop selection** is `bgHighlight` plus a 1 px brass left rule. The phone has no selected state.
- **Corner toggle.** A Room row shows the brass `CornerGlyph` toggle only when the viewer has at least one open corner there (`Expand N corners`); long-pressing the toggle opens a new corner (humans only).
- **Standalone corners list** (`corners/[roomId]`): `PageHeader` with the Room name as eyebrow; each row leads with the opener's 26 px tile, prints the corner's full name (`fullCornerTitle`, never truncated), one quiet line, and the state word beside its `StateCircle`.
- **Tray** (`TrayGlyph`, brass count compacting to `9+`): two sections, Needs you then Saved, each under a `sectionHead` with a brass count. Cells are the asking sentence over one `meta` line; swipe right (phone) or hover (desktop) to dismiss.
- **Settings and profiles** use only `SettingsRow` rows under `sectionHead` headings, one hairline apart, with a reserved trailing column. `PageHeader` is the page title: a `meta` eyebrow naming the parent over a `bodyStrong` (or `hero`) title.
- **Compose** is a 44 pt brass `+` in the Room-list header that turns 45° into a close mark while the sheet is open.
- **Workspace rail.** The drawer marks selection with an edge bar, the mark's heavier frame, and receding tone for the others. The desktop strip uses framed avatars, an icon-only Add, and the account avatar at the bottom.

### Workflows
- **`WorkflowGlyph`** is one filled polygon in the corner's 24 viewBox: the corner mark turned 135° with a stem rising from the elbow. Brand-mark gold while a run is live, the theme's `ledgerGhost` when idle; inline at `CORNER_META_SIZE` (13).
- **Run page** (`app/(app)/beeline/workflow-run.tsx`, `WorkflowRunLine`, data from `buzz/workflow-graph.ts` `workflowRunLine`): a `hero` status line, a `meta` line of who/when/how long, the saved ≤140-character `summary` (absent on legacy revisions) in `body`/`textSecondary`, then a `Steps` section head and one vertical line read like a GitHub Actions run. Only reached visits appear, in execution order; every repeated visit gets its own row. No future terminal or graph-path rows.
- **Steps** are 20 pt circles, never colour alone: done (brass disc + check), current (brass ring + dot under a 32 pt breathing halo), pending (hollow `textMuted` ring), skipped (dashed ghost ring with a slash), failed (`textSecondary` ring with an x). Connectors are 2 pt: brass where the run went, dashed ghost beside a skip, `borderStrong` ahead. Each title has its saved ≤140-character `does` sentence beneath it instead of exit/gate prose; legacy steps keep their name. Tapping a step opens its readout on a 2 pt `borderStrong` rule. Gates are records, never controls; answering stays in the corner.
- **Step assignee.** Each step with a role shows who holds or held it at the row's right, beside the duration: a 20 pt `IdentityMark` and the `@handle` in `meta`, in the identity's hue, brass when it is the viewer (`workflowStepAssignee`). The current step is the run's holder (the viewer when it waits on them), a reached visit whoever left it (the person who answered a gate). Steps with no role read `Automatic` and carry no mark. Role names never appear on the page. Elapsed duration uses server entry/exit times; current durations tick and finished durations stay stable. A working agent’s newest available chunk replaces the previous chunk under its current visit in `meta`/`ledgerQuiet`, two lines. Its finished visit displays its own committed final reply in `body`/`textSecondary`, retained across refresh and viewers; absent output stays empty and receipts are supplementary.

### Identity
`components/buzz/IdentityMark.tsx` is the one identity component (a test bans any other `*Avatar*`). Faces come from `buzz/faces/`, hues from `buzz/identity-mark.ts`.

1. **Species is the face.** People and agents are one of Speakeasy's twelve creatures (fox, owl, pigeon, hare, stag, whale, moth, octopus, heron, bear, cat, bat). People choose at onboarding; the server assigns an agent's, together with its name. Without either, `defaultFaceForSeed` (FNV-1a) picks the same animal on every device.
2. **Plate polarity is the type.** A person is a coloured creature on an ink plate; an agent is the same creature in bone on a plate of its own hue.
3. **Colour is the memory.** Each identity has one deterministic hue from a curated, scrambled 16-hue palette (≥20° apart), used on the creature, the plate, and the byline name.
4. **The edge layer** (`recolorEdge`, `EDGE_GROW = 3`) draws a contrast copy behind shapes that would vanish on their plate.
5. **A gold ring means working**: a live turn or corner (`selectWorkingAgents`), breathing on `HullLivePulse`, never presence alone. It never touches the identity colour.

**Workspace plate.** Every Workspace mark is a 3×3 block/slot/cut/void plate in tones of one brass hue (`WORKSPACE_BRASS_HUE` ≈ 40°); it goes solid below `CYPHER_MIN_SIZE` (24). Owners may set a Workspace picture, seated concentric inside its bezel (`buzz/workspace-tile.ts`).

**Pictures.** Relay photos for people and agents stay off (`PHOTO_OVERRIDES_ENABLED`, `photoIdentityMarksEnabled`). The image exceptions are Workspace pictures, server-generated agent portraits (`/v1/agent-avatars/`), and connector logos.

**Names and vocabulary.** An agent's name comes from its registered `displayName` via `resolveAgentDisplayIdentity`; the soul shapes personality and art, never the name. "Room," never "Channel." `Members` names the surface (`MEMBERS_LABEL`); its sections are `People N` and `Agents N`. Room and corner names carry the `#` mark wherever they are exposed (`displayRoomIndexTitle`, `displayCornerTitle`), added at render only. Room and corner state is the drawn `StateCircle`, never a typed diamond.

### Motion
Primitives live in `components/buzz/MonoHull.tsx` with `motionTokens`: reveal 176 ms (`PixelGateReveal`), confirm 240 ms, loader frame 133 ms, new-message 140 ms fade+rise (`NewMessageMaterialize`), demote dip 90 ms, and one live clock `liveCycle` 1120 ms. All respect `ReduceMotion.System`; continuous ones stop when the app backgrounds. Nothing but the continuous loops exceeds ~240 ms.

- **Live breathes, never travels.** `HullLivePulse` (one opacity breath) is the only motion "live" may have. It is mounted only where something is genuinely live, so mount it conditionally, never `active={false}`. No sweeping bands, progress bars, or marching dashes for turns, corners or checks.
- At most two of `PixelLoader` / `HullWaveSignal` run on screen at once.
- **The self-painting glyph** is the one drawn loop: `BootPaint` paints once on splash; `SurfaceGlyphLoader` (page and Room load gates) and `BeelineMarkSpinner` (thinking line) draw the Beeline mark, unwind, and rest empty. Reduced motion shows the static mark.
- **Exceptions:** the provisional settle cross-fade (220 ms); a closed poll's still brass wash (magnitude, not progress).

### Agent and human profiles
Profiles reuse Settings typography, spacing and `SettingsRow`. Bylines open profiles; mentions and Message open DMs. Phone pushes a page; desktop opens an adjacent pane. Human profiles show identity, Workspace role (with explicit Edit/Save/Cancel when authorized) and the read-only grant ledger. Agent profiles show the mark or generated portrait, model, effort, owner, expandable soul and merged work. See [agent profiles](docs/agent-profiles.md).

## Do's and Don'ts

### Do:
- **Do** read colours, type, radius and spacing from `theme.buzz` so Obsidian and Bone both work.
- **Do** spread a type role (`...theme.buzz.type.meta`); never set a raw `fontSize`.
- **Do** encode every state redundantly: glyph, word, or shape alongside colour.
- **Do** keep content brighter than chrome, and `ledgerQuiet` at or above AA.
- **Do** give every control a 44 pt target and an accessible name.
- **Do** mount live motion only where something is live.

### Don't:
- **Don't** add a second accent hue or let brass fill an identity plate.
- **Don't** box ordinary messages, attachments or avatars, or add speaker rails.
- **Don't** style a human message differently from body text.
- **Don't** show live work with anything that travels or fills.
- **Don't** add another avatar component, button family, card frame or page header; extend `IdentityMark`, `Button`, `TranscriptCard` or `PageHeader`.
- **Don't** use IBM Plex Sans or Bricolage Grotesque in the app; the app loads neither.
- **Don't** write a colour literal, an off-scale spacing value or radius, or a shadow in a component.

## Enforcement

The rules above are held by lints in the mobile vitest suite, which CI's MOBILE SUITE runs on every change under `apps/mobile`:

- **The Calm Lint** (`buzz/calm-lint.design.test.ts`): type sizes, line heights and tracking (see Type), including raw values placed on the next line. A computed value (arithmetic, a ternary, parentheses or a call such as `Math.round(17)`) counts as raw.
- **The Design Lint** (`buzz/design-lint.design.test.ts`): colour literals outside the token source and named brand-mark files; padding, margin and gap off the spacing scale; radii outside {3, 8, 10, 14} (a circle is `size / 2`); shadows, including any nonzero Android `elevation`, outside `HullDialog`/`HullActionSheet`; IBM Plex Sans, Bricolage Grotesque and `SpaceGrotesk-Bold`; and the retired `MonoButton`, `BrassButton`, `OnboardingButton`, `RoundButton`, `MobileGlass` and `navigation/Header`. A spacing or radius value is traced to its literal, even across lines, through local constants (before trusting a theme alias), local tables, the module an imported constant comes from, parentheses, arithmetic and `Math.*`. Each branch of a ternary or fallback is checked, and so is a number beside a runtime value in `Math.max`/`Math.min`. A number added to a token or a runtime value (`space.sm + 2`, `insets.bottom + 40`) must itself be on the scale, and a radius token takes nothing added.

Each file is held to its per-rule count in `apps/mobile/design/design-baseline.json`; counts only shrink. Regenerate with `DESIGN_BASELINE_WRITE=1 npx vitest run sources/buzz/design-lint`. Every baseline row must carry the reason its geometry is not a scale step in `DESIGN_BASELINE_REASONS` (`buzz/design-lint.ts`), and an allowlist entry (`DESIGN_ALLOWLIST`) must name the decision that licenses it. The `beeline-review` skill checks UI changes against this file and these lints, and requires proof in both themes.

## Design inconsistencies

None open. The list recorded on 2026-10-03 was fixed in full; the lints in Enforcement keep those classes from returning. The off-scale geometry the design baseline still holds (the arrival halo's concentric radii, the Ledger marginalia column, the QR quiet zone, centring and border compensation, the turn line's pixel budget, the workflow rail column) is not spacing rhythm, and each file names its reason in `DESIGN_BASELINE_REASONS`. Record a newly found inconsistency here, with its file and line, until it is fixed.
