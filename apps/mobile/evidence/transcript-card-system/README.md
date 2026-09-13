# TranscriptCard visual proof

The deterministic fixture uses the production Obsidian tokens and the exact
`TranscriptCard` geometry. Chrome DevTools captured both phone views at
390×844 and the desktop view at 1440×900.

| Captain-approved mock                              | Implementation proof                                    |
| -------------------------------------------------- | ------------------------------------------------------- |
| ![Mock phone, records](mock-phone-top-390x844.png) | ![Implementation phone, records](phone-top-390x844.png) |
| ![Mock phone, asks](mock-phone-asks-390x844.png)   | ![Implementation phone, asks](phone-asks-390x844.png)   |

![Desktop implementation](desktop-1440x900.png)

The two phone captures collectively show the corner-open record, one-row merge
fold, collapsed many-row PR fold, workflow failure row, pending permission ask,
pending script grant, and settled ask. The desktop capture uses the same card
anatomy and transcript fixture.
