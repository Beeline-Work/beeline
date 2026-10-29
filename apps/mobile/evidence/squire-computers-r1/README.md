# Reproduction R1

Settings → Connectors → Trusty Squire showed eight computers needing sign-in.
`before.jpg` is the owner's Android screenshot. Production read-only investigation
confirmed connected broker reports on squire plus Ronnie's failed sign-in work.
Ronnie remains an active identity; its agent update predates the latest connected
report. Cursor2, Firstmate, Muse and Pidoong are rooms_mcp_members, created by the
remote MCP membership path, not helper runtimes. They cannot report machine IDs.

The fix excludes remote MCP members and retired identities. It timestamps queued
and reported sign-in work and ignores work older than the machine's latest
connected report. Legacy work uses only its Squire report timestamp (or zero when absent),
never the general agent update timestamp. Unrelated machine/model/preference
updates cannot revive an expired sign-in failure. Legacy work on the latest
reporting agent remains conservative. Fresh reconnect failures still
win. Existing reconnect regressions remain unchanged.

`after.png` renders the actual mobile service component in Bone at phone width
with a faithful four-computer fixture: squire signed in, three other computers
need sign-in, and no remote member rows. This is a browser rendering, not a
production Android deployment. The HTTP readWorkbench integration regression
exercises shared-machine aggregation, old and fresh sibling failures, retirement,
and remote-member exclusion. The review regression first failed on the prior
head: changing only a sibling agent update time revived its stale error. It now
passes without changing Squire work or broker health. No production records were changed.

Commands:

- `npm test -w @beeline/server -- --run src/workbench.integration.test.ts`
- `npm test --prefix apps/mobile -- --run sources/test/squire-computers-r1.browser.test.ts`
- `npm run typecheck -w @beeline/server`
