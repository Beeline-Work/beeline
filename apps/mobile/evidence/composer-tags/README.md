# Composer member tags (web, real Chrome key presses)

`web-real-keys.png`: `scripts/composer-tags-proof.tsx` in Chrome at 390 px,
obsidian (top) and bone (bottom), driven with real key presses through
chrome-devtools-axi (`type`, `press ArrowRight`, `press Backspace`).

1. `@ruby please ask @speedy too`: the leading `@ruby` is plain input text,
   styled like the later `@speedy`; no pill, overlay or indent.
2. The cursor right after `@ruby`, one Backspace: `@ruby` is gone and the
   cursor is at 0.
3. Typing `@ru` at the start opens the MENTION suggestions with `@ruby`.
4. Typing `@sp` mid-message opens them with `@speedy`.
5. `@ruby `, Backspace takes the space, the next Backspace empties the field
   and the placeholder shows.

The CI check of the same page with synthetic key events is
`ConversationComposer.tags.browser.test.ts`.
