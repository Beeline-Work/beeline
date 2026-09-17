# Workbench Visual Redesign — Mock Report

## Visual Concept: Instrument Panel

The redesign treats each tool as an **instrument in a control panel**. Rather than cards or lists, each row is a single instrument reading that communicates status through multiple channels:

1. **Position**: Terminal states align right (connected/active values)
2. **Weight**: Active/connecting states use bold text
3. **Form**: Distinct glyphs for each state (circle, dot, check, x)
4. **Color**: Secondary signal, supporting but never sole indicator

## State Coverage

### Workbench Home — Tool Cards
| State | Visual Treatment |
|-------|-----------------|
| **Not Connected** | "connect" in brass accent, chevron indicates action |
| **Connecting** | "installing" in bold brass + pulsing amber dot |
| **Connected** | "connected" in muted gray + filled green dot |
| **Error** | "error" in red + red dot marker |

### Connect Flow
| Screen | States Shown |
|--------|--------------|
| **Helper Picker** | Online helpers with "pair" action, offline helpers dimmed with "offline" label |
| **No Helpers** | Empty state with CLI command block |
| **Install Progress** | Step list with done (check), active (pulse), pending (dot), failed (x) |
| **Sign In Required** | Completed steps checked, sign-in button in brass |
| **Failed Step** | Red X marker + error reason text + retry button |

### Desktop Variant
- Side panel navigation with selected state
- Three-column stat grid for tool summary
- Keys table with host metadata

### Expanded Panel (Accordion)
- One-sentence user-story explanation per tool, revealed by the accordion
- Connect action lives as a compact button on the row's side (no large bottom action button)

## Typography

| Role | Font | Size | Weight |
|------|------|------|--------|
| Hero | Space Grotesk | 22px | 500 |
| Body | Space Grotesk | 16px | 400/600 |
| Meta | Space Grotesk | 13px | 400 |
| Machine | IBM Plex Mono | 13px | 400 |
| Section | Space Grotesk | 10px | 500, +2px tracking, uppercase |

**Tabular figures** used for status values and timestamps (IBM Plex Mono).

## Color (Obsidian/Bone)

| Token | Dark | Light |
|-------|------|-------|
| Canvas | #14091A | #F3EEE4 |
| Raised | #190e21 | #ECE4D5 |
| Accent | #b08a4a | #8a6323 |
| Success | #7a9b76 | #5a7a56 |
| Danger | #c4544d | #c4544d |
| Text Primary | #f0f0f3 | #171310 |
| Text Secondary | #c9c9d1 | #4A4038 |
| Text Muted | #83838d | #8B7F6E |

## Revision 2 (captain feedback)

1. **Unified Google Workspace integration.** All Google-related entries (Gmail, Google Calendar, and the implicit YouTube surface) are grouped into ONE item titled **Google Workspace** with a single Connect button. Per-service entries and buttons were removed. Explanation copy: "Covers Gmail, Google Calendar, YouTube, and other Google services."
2. **Succinct one-sentence user-story explanations.** Every tool's descriptive explanation was replaced with a single value-proposition statement:
   - **Trusty Squire**: "With Trusty Squire, just by linking your Google account, B-Line agents can sign up for software services for you without you having to be involved."
   - **Tailscale** (newly added to the board): "Allows the machines in your B-Line network to connect to each other to form a tailnet."
   - **Coinbase Wallet**: "With Coinbase's non-custodial wallet API, you can transfer and receive crypto assets across 16 different EVM chains as well as Solana—with free transaction fees on Base."
   - **Google Workspace**: covered by the unified entry copy above.
3. **Layout & action streamlining.** Every tool cell now carries ONE compact Connect button aligned directly on the side of its cell (`.cbtn`: brass border, 3px radius, compact padding), standardized across the Workbench Home states, the desktop sidebar, and the expanded panel. The large full-width Connect action that sat at the bottom of the expanded tool panel was removed. Accordion/expandable mechanics for tool explanations are unchanged.

## Design Decisions

1. **No emoji**: Status uses styled glyphs (check, x, bullet, dot) with CSS animations
2. **No glassmorphism**: Flat, purposeful surfaces with 1px borders
3. **No rainbow gradients**: Single brass accent against grayscale canvas
4. **Row height**: 64px minimum for touch targets
5. **Border radius**: 3px for UI chrome, 12px for device frames only

## Open Questions

1. Should the "connected" dot be clickable to show connection health?
2. Does the desktop layout need a collapsed sidebar state?
3. Should failed steps show a "view logs" expansion?
4. Is the pulsing animation rate (1.4s) appropriate for accessibility?
5. Should the unified Google Workspace entry break out per-service status (e.g. which Google grants are active) once connected?

## File Location

`proof/workbench-redesign-mock/board.html` — Open in browser, use "Toggle Appearance" button in top-right to switch between Obsidian (dark) and Bone (light) themes.
