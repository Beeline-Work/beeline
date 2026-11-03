# Phone layout debugging report — DONE

Symptom: the phone avatars/labels collided with the download area, and the floating Codex terminal covered the transcript header. The old external video link also remained in a cached preview.

Root cause: the diagram was scaled, but flex centering still used its unscaled height. Scene sizing used `innerHeight` while the page used `100svh`, so browser controls exposed the mismatch. The phone terminal used an absolute offset that intersected the header.

Fix: the phone hero is a normal vertical flow stack. The scene reserves avatar bands around the transcript; connectors use actual CSS rectangles (`phone-layout.js`). The phone invitation is a fully visible inline ledger card (`story.js`), while the desktop terminal stays outside the app window. The external video link is removed. Versioned HTML/CSS/JS links fetch the corrected layout.

Evidence: `overlap-checks.json` contains 336 passing samples: 42 scene/transition points × four requested dimensions × two current-viewport states. Chrome mobile emulation has DPR 2.6, five touch points, and an actual measured 112px small/large viewport difference. All avatars remain visible; no floating phone terminal remains; the inline terminal is fully visible. The identical rectangle check fails on the pre-fix layout (`baseline-failures.json`).

Regression: `web/mock/round6/tests/verify-phone-layout.py`, using `phone-overlap-check.js`. It checks all visible hero HTML fragments, normal ancestor containment, clipping, critical controls and image bounds. Decorative connector SVGs and scan-line decoration are excluded. It explicitly asserts the actual viewport difference because Chrome clears that override during navigation.

Fresh public verification: the 412×915 tunnel preview passes the same check, and a real keyboard submission produces two local agent replies with scrollY remaining zero. No model or fetch/XHR is used. Four-width screenshots and short-viewport stress captures are attached. PNGs use the tool’s CSS-pixel screenshot output; browser DPR/touch settings are recorded separately.

Production `web/index.html` remains unchanged. The mock is ready for review; no push or PR.

Protocol reference: [Chrome small viewport height difference override](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setSmallViewportHeightDifferenceOverride).
