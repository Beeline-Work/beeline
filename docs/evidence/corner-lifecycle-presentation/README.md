# Corner lifecycle presentation

A person who opens a corner with no actual workflows sees its objective and conversation without a workflow link or a workflow page for its lifecycle.

## Reproduction C1

On the original base, `workflow-run-views.test.ts` exercised the phone path: open a code corner with `advanceCorner`, then call `PhoneService.execute('readWorkflowRun', { roomId: cornerId, runId: cornerId }, viewer)` without saving or starting any workflow. It returned the corner contract with Opened and Implement history. The original test passed, confirming the incorrect behavior. The supplied screenshot showed that lifecycle presented as a Corner workflow with All runs and numbered steps.

## Demonstrated

The updated phone-service regression opens the same corner and reads workflow listings from both the corner and its parent. Both return an empty list; opening the lifecycle run returns `workflow run not found`. It repeats with legacy cards carrying `workflowSlug: corner` and a stored version number, with the same result. A saved workflow named `corner` remains listed and readable.

The browser regression mounts the production objective component and saved-workflow observer with phone-operation response fixtures. At 390px and 1180px, in Obsidian and Bone, the plain corner renders its objective with zero SVG glyphs and zero workflow links. The actual saved workflow renders Open workflow, Approve; clicking it produces the workflow-run route with that saved run's Room and run ids. This verifies the rendered objective and navigation action; the phone-service test separately verifies which runs the server returns.

Commands:

```sh
npm test -w @beeline/server -- src/workflow-run-views.test.ts src/corner-lifecycle.test.ts src/workflow-runs.test.ts
npm test --prefix apps/mobile -- --run sources/test/corner-workflow-presentation.browser.test.ts sources/test/resource-observers.browser.test.ts
npm test -w @beeline/body -- src/workflow-corner-e2e.integration.test.ts
```

## Cleanup boundary

Removed the obsolete corner-workflow migration proof, its package command, the mobile copy of the lifecycle workflow contract, and lifecycle-specific workflow projections and output binding. No obsolete corner workflow YAML definition was present. `apps/mobile/maestro/corner-opens.yaml` remains because it tests navigation, not a workflow definition.

The corner lifecycle contract, transition lock, state columns and persisted card discriminator remain runtime authorities. The legacy `corner-workflow-handoff` value and deterministic message-id namespace remain intact for stored history. The migration that deletes previously seeded corner workflow definitions remains necessary; it identifies those old definitions by their extractor marker and preserves workflows people saved themselves.
