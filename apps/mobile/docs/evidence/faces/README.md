# Faces contact sheet

`contact-sheet.png` is rendered from the REAL `IdentityMark` component (react-test-renderer → SVG markup → browser screenshot), not from a mockup: all twelve creatures as people on the dark plate and on the light plate (the edge layer flips), all twelve as agents (ink figure, lens band, hue plate), an alive ring, and the 26px byline scale.

Regenerate:

```sh
cd apps/mobile
FACES_EVIDENCE_DIR=/tmp/faces npx vitest run sources/buzz/faces/evidence.test.tsx
# then screenshot /tmp/faces/faces.html at ~980px wide
```
