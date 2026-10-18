# Service-review provider proof

The corrected `relay-stack/web/subprocessors/index.html` was rendered in Chromium
at 390×1100 and 1280×1000. The rendered DOM identifies the review model provider
as `Anthropic`, contains no generic staff-selected provider category, and reports
no horizontal document overflow at either size.

- [Mobile provider table](subprocessors-mobile.png)
- [Desktop provider table](subprocessors-desktop.png)
- [Verified processing path and evidence](../../service-review-providers.md)

The page is repository content; no real workspace data is present in either image.
The policy remains vendor-neutral. Squire's returned query data and Neon's database
hosting are covered by their named table rows, along with Squire's disclosed Fly
hosting infrastructure.

The service integration proof uses synthetic records. A paginated read runs
inside `SET TRANSACTION READ ONLY` and stops when the workspace opts out.
The provider inventory is a disclosure, without a runtime provider gate.

Commands:

```sh
npm test -w @beeline/server -- src/identity-live.e2e.test.ts src/feedback-triage-workflow.test.ts --maxWorkers=1 --minWorkers=1
node --test scripts/pages-site.test.mjs
npm run typecheck
npm run dead-code
```
