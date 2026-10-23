# Repository subscription link proof

Reproduction SUB-LINK: receive an issue event for a repository subscription, then read its committed Room system line. Previously the writer composed `Beeline received a repository event · issue.opened` with no issue identity or URL. The integration regression now verifies the committed text, GitHub subject, linked object, unchanged quoted payload and exactly one command for duplicate deliveries. The star regression enters through `GitHubOperations.processWebhook`.

The screenshot uses the shipped `LedgerSystemLine` Room renderer in an isolated dark Room-width container (390 CSS pixels). The runner checks the container width, no horizontal overflow, and that tapping the issue object passes its exact GitHub URL to navigation. Chrome enforces a wider outer window; the capture is cropped to the measured Room container. This is a local renderer stand-in, not a production Room screenshot: this branch is not deployed, and firing a live subscription would create real agent commands. The service path is exercised separately against the migrated isolated database by `agent-subscriptions.test.ts`.

Run from `apps/mobile`:

```sh
node --import tsx scripts/run-repository-subscription-proof.mts
```

Expected: `PASS SUB-LINK — issue tap opens its GitHub URL`.

Merged pull request wording has formatter coverage. The existing early return suppressing merged deliveries remains unchanged to honor the brief's requirement to preserve wakes; merged deliveries still do not post subscription lines. Enabling those deliveries requires a scope decision.
