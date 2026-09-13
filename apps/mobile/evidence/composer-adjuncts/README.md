# Composer adjunct visual proof

The screenshots use the production `ConversationComposer` on the Expo web surface with Beeline's bundled Space Grotesk and IBM Plex Mono fonts. The deterministic transcript shell keeps the composer state reproducible without connecting to production. The two reproduced captures preserve the starting source's detached `borderStrong` reply and attachment blocks; the demonstrated captures render the implemented shared component.

## Reproduced

| Reply · 390×844 | Attachments · 390×844 |
| --- | --- |
| ![Detached reply block](reproduced-reply-390x844.png) | ![Detached attachment blocks](reproduced-attachments-390x844.png) |

## Demonstrated

| Reply · 390×844 | Attachments · 390×844 |
| --- | --- |
| ![Integrated reply section](demonstrated-reply-390x844.png) | ![Integrated attachment rows](demonstrated-attachments-390x844.png) |

| Reply and attachments · 390×844 | Reply and attachments · 1440×900 |
| --- | --- |
| ![Combined phone state](demonstrated-both-390x844.png) | ![Combined desktop state](demonstrated-both-1440x900.png) |

## Composer attachment plates

PR #1168's combined 390×844 capture above reproduces the leading image thumbnail and hatched PDF plate. The captures below use the production `ConversationComposer` on the local Expo web surface with the same staged image and PDF, after removing composer-only plates.

| No plates · 390×844 | No plates · 1440×900 |
| --- | --- |
| ![Image and PDF rows without plates on phone](no-plates-both-390x844.png) | ![Image and PDF rows without plates on desktop](no-plates-both-1440x900.png) |
