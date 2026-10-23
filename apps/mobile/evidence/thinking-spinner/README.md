# Leading thinking spinner

Reproduction THINKING-SPINNER-1: open a transcript with Ruby working, at phone (360 × 892) and desktop (1280 × 860), in Bone and Obsidian. Current main puts the spinner after the elapsed counter. The corrected build puts the same animated mark before the name, with its visible left edge at the transcript left edge and STOP at the right edge.

`before/` is a full Expo web export of current main b157997f0e76573d020e06dced1745a79e677ed0. `after/` is the corrected full app. The four comparison images show main on the left and this change on the right; full screenshots and DOM rectangles are included. `after-room/` and `after-corner/` cover the corresponding routes in both themes and sizes.

The leading cell removes only the SVG's transparent left inset from its layout width, aligning its unchanged painted shape with text. Its right-hand transparent inset and the original 8-point cell-to-name gap remain unchanged. The 18-point SVG, path, ink, animation, timer, STOP and vertical metrics are unchanged. Settled lines retain their existing layout. This is JavaScript-only and needs no store binary change.

## Proof and limits

The screenshot pixel measurement reports the mark within half a point of the transcript's left edge, with STOP exactly at the right edge. `kit/measure.py` asserts the one-point tolerance and the original gap. Screenshots capture live animation at different phases, not a replacement static mark.

The live web browser check reached the Workspace onboarding screen with no available Workspace. No account or Workspace was created or changed. The screenshots therefore use the local preview build, with the existing disposable monolith/database fixture, not production. The desktop router opens corners in the main transcript; it does not expose the legacy inspector cockpit on this route. Inspector coverage uses its existing component suite and the progress-row test with `inset=false` as the closest stand-in, rather than claiming a live inspector screenshot.

## Re-run on squire

Read scripts before running. Existing disposable service: http://127.0.0.1:18890; database: loopback port 5557, beeline_latency_rig. Fixture setup is in `../thinking-margins/README.md` and its seed kit. No production credentials are involved.

Export each revision from `apps/mobile`:

```sh
EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:18895 NODE_OPTIONS=--max-old-space-size=6144 npx expo export --platform web --output-dir /tmp/jellybean-spinner/after
```

Metro reused the old local backend URL from its cached environment in this proof. In **both exported outputs only**, replace the endpoint string `http://127.0.0.1:18890` with `http://127.0.0.1:18895` in the JS bundles. No component source was substituted. The checked-in preview server forwards to the same disposable monolith and adapts CORS to its existing permitted origin; response data and authentication behavior remain real. It leaves the existing preview ports untouched.

From repository root:

```sh
printf '%s' /tmp/jellybean-spinner/after > /tmp/jellybean-spinner/active
node apps/mobile/evidence/thinking-spinner/kit/serve.mjs
```

Then, with LATENCY_RIG_DATABASE_URL set to that disposable database, run `node apps/mobile/evidence/thinking-spinner/kit/capture.mjs after`. Optional final arguments `18894 room` or `18894 corner` select those routes. Switch the active path to the before build for `before` captures. The capture signs in through the local review fixture and refreshes working turns before every viewport.

```sh
python3 -I apps/mobile/evidence/thinking-spinner/kit/measure.py
python3 -I apps/mobile/evidence/thinking-spinner/kit/compose.py
```

Validation: root `npm run typecheck`; `npm run lint:ui-components`; progress-row, glyph, composer-layout and desktop-inspector tests; design and calm lints.
