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
| **Soon** | "soon" in disabled gray, row still tappable for details |

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

### Expanded Panel (New Pattern)
- Capability bullets with bold labels
- Primary action button in brass border

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

## File Location

`proof/workbench-redesign-mock/board.html` — Open in browser, use "Toggle Appearance" button in top-right to switch between Obsidian (dark) and Bone (light) themes.
