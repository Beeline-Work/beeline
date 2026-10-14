# Message member picker: search inset and Message button border

Rendered in headless Chrome by `sources/components/buzz/DirectMessagePickerSheet.browser.test.ts`
(light theme, 390 wide), once on `main` and once with the fix.

- `before-idle.png` / `after-idle.png`: the search field started 9px from the sheet edge while the
  title sat at 25px. It now shares the title's 24pt inset, like the Forward picker.
- `before-busy.png` / `after-busy.png`: after tapping Message, every row's button was disabled and
  `Button` drew its disabled outline (`#DED2BC`) around those borderless quiet buttons. Quiet and
  destructive buttons now stay borderless when disabled.
