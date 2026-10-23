# CI stays in review

Reproduction CORNER-STATE / CI-REVIEW uses server-derived fixtures and the built
ConversationRow and DesktopRoomCorners components in headless Chrome. A live
production capture is not repeatable on demand because it requires a PR with CI
running at capture time. This local component build is the screenshot stand-in;
the service integration test exercises the actual read and live-update paths.

Before: pending CI and the human merge decision both show waiting; each Room
has a waiting count of one. After: pending CI shows review with no waiting count;
the human merge decision stays waiting with a count of one.

- [Before](before.png) ([server projection](before.json))
- [After](after.png) ([server projection](after.json))

Generate the after fixture from the current server projection and render it:

```sh
npm run build -w @beeline/api-contract
node --import tsx apps/mobile/scripts/ci-review-proof.mts after
```

The `before` argument re-renders the saved pre-fix server projection. It does not
pretend that the current server still produces the old mapping. Fixtures model a
human-addressed merge question; the service test creates that question through a
needs-decision report and verifies both pending and passing checks.

No native code or rendering behavior changes. Existing clients already render
the server state verbatim, so deploying the server supplies the fix.
