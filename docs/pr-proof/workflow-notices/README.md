# Workflow notice rendering

Reproduction workflow-notice-1: start a saved workflow, reassign its current
role, hand it off to a gate, cancel it, then read the Room through PhoneService.
Before this fix, the start, handoff and cancellation messages were stored and
projected as `card`, which fell through to an ordinary speaker row. The same
service test now returns `system` for start, reassignment, handoff and
cancellation, keeps the exact text and wake assertions, and keeps the gate's
choice as `card`.

The four PNGs show before and after on a compiled component harness, using
the real Room message projection and Ledger components with native device
dependencies shimmed. The plain-text Markdown body is shimmed; the system
line renderer is real. These are browser captures at 390px and 1180px in
Obsidian and Bone, not screenshots from a signed-in phone. The native React
renderer test also checks web, iOS and Android platform settings and verifies
that a structured object's URL still reaches the opening callback.

Commands, from `apps/server` and `apps/mobile` respectively:

```sh
npx vitest run src/workflow-runs.test.ts -t workflow-notice-1
npx vitest run sources/components/buzz/Ledger.provisional.test.tsx sources/buzz/room-view-presentation.test.ts sources/buzz/system-lines.test.ts
BEELINE_DESIGN_PROOF_DIR=/path/to/existing/output npx vitest run sources/test/workflow-notice.browser.test.ts
```

Existing stored workflow notices stay unchanged; there is no migration.
New notices retain their `workflow-handoff` card type and run data for the
workflow engine, with `system` presentation selecting the existing renderer
on web and mobile. No new message kind, wording, sender or wake rule is added.

The built-service acceptance proof uses an isolated database and real HTTP
requests: claim a turn, save and start a workflow, hand off to its terminal,
then fetch the Room as a person. Both notices return `presentation: system`
and keep their short run identifier. From the repository root:

```sh
npm run prove:workflow-notices
```
