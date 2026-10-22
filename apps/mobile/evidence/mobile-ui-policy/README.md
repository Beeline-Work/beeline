# Mobile UI policy repair

Reproduction R-UIPOL: on main b82f0f7fb, `node --test scripts/mobile-ui-policy.test.mjs` failed with nine raw-button/custom-row violations in PrLifecycleCard and WelcomeCards (28 passed, 1 failed). The same command now passes (29 tests). `node scripts/check-mobile-ui-components.mjs --base origin/main` also passes without adding legacy exceptions or changing rules.

TranscriptNavigationRow owns the inline navigation geometry and separate GitHub/corner targets in the existing shared row module. IndexRow's single-line title and reserved trailing column cannot preserve this rich, wrapping transcript copy. InlineRow shares horizontal page compositions; WelcomeCards keeps its existing Button. These registered components preserve the existing visuals and targets.

The browser proofs build production components with react-native-web, real fonts and SVGs. Native-only services and theme plumbing are shimmed; this is a local built-component demonstration, not a device or production-server capture.

Commands (from apps/mobile):

```
CORNER_LINE_PROOF_OUT=/tmp/uipol-after/corner ONBOARDING_EVIDENCE_DIR=/tmp/uipol-after/welcome npx vitest run sources/test/corner-line.browser.test.ts sources/test/onboarding.browser.test.ts sources/test/lifecycle-cards.browser.test.ts sources/components/buzz/PrLifecycleCard.test.tsx sources/components/buzz/WelcomeCards.test.tsx sources/buzz/design-lint.design.test.ts sources/buzz/calm-lint.design.test.ts --maxWorkers=1
```

The focused run passed (32 tests). The corner proof clicks call-site, Room, DM and long-name links and checks their destinations. The welcome proof advances every slide at phone, tablet and desktop widths, checking fixed Next/scene positions and no composer overlap. The lifecycle proof checks standalone adapter destinations in both themes. Root `npm run typecheck` passed.

Every screenshot under `before/` is byte-identical to its counterpart under `after/`:

- Corner: Obsidian and Bone, desktop column.
- Welcome: widths 320, 390, 768 and 1280, first slide.

Screenshots were inspected for wrapping, target alignment and layout continuity.
