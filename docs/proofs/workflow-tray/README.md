# Workflow approval clarity

Reproduction `tray-choice-clarity`: Tubing Crew → Tray → Needs You → workflow approval.
The reported screenshot showed `feedback-triage: approve`, `dispatch` / `skip` with
`go to dispatch` / `go to done`, plus a second `Skip` control.

The browser stand-in renders the shipped NeedsYouCell at 390px in Obsidian and
Bone. Before frames show the reported card shape. After frames show the gate's
existing `does` description and each target's `does`, with only explicit outcome
buttons. Hover reveals the separate Dismiss control. Browser clicks preserve
option IDs A/B; Dismiss calls only the dismissal callback. No horizontal overflow.

The isolated service regression saves a reduced feedback workflow starting at its
approval gate, reads the tray through PhoneService, then answers its projected
skip option through answerChoice. The run reaches done. It also exercises a
historical contract without descriptions, using readable fallbacks. The tray
regression dismisses an existing workflow card through clearNeedsYou and verifies
its room_choices status stays open. Ordinary non-workflow choices retain Skip.

The production workflow was not advanced for this proof: that would decide a
person's real approval. The browser and isolated service are the stand-ins.

Run from the repository root:

```sh
npm test -w @beeline/server -- src/workflow-runs.test.ts -t 'demonstrates tray-choice-clarity' --maxWorkers=1 --minWorkers=1
npm test -w @beeline/server -- src/needs-you.test.ts -t 'shows an open question addressed' --maxWorkers=1 --minWorkers=1
BEELINE_DESIGN_PROOF_DIR=/tmp/jellybean-tray-proof npm test --prefix apps/mobile -- run sources/test/workflow-tray.browser.test.ts --maxWorkers=1 --minWorkers=1
```

Create the screenshot destination before running the browser proof. Screenshots
use the same fixture and components as the test, with the pointer over the row to
make Dismiss visible. Existing already-posted gate prompts are not rewritten;
removing the redundant Skip works for existing runId-bearing cards too.
