# Browser consent repair

Reproduction MCP-CONSENT-ORIGIN (2026-10-27): built loopback server → dynamic
registration → authorize → Continue with GitHub → Allow. Chrome sent
`Origin: null`; consent returned HTTP 400 `{"error":"invalid_request"}`.
The fixture runs real Beeline migrations, browser-bound login and OAuth handlers;
only upstream GitHub is synthetic. No production credentials are used.

Changing only Referrer-Policy to `same-origin` exposed a second failure on the
same path: Chrome rejected the callback redirect under `form-action 'self'`.
The final fix permits the flow's already validated callback origin in that
directive on the approval page only. Login and edit pages retain self-only form
destinations; redirects retain `no-referrer`. The consent origin check is unchanged.

## Re-run

With Google Chrome installed, build and start the fixture in one terminal:

```sh
npm run build
MCP_PROOF_PORT=18965 node --import tsx scripts/prove-rooms-mcp.mjs --serve
```

Install Playwright outside the checkout, then run the browser proof:

```sh
npm install --prefix /tmp/rooms-mcp-browser playwright-core --no-package-lock
MCP_BROWSER_PLAYWRIGHT=/tmp/rooms-mcp-browser/node_modules/playwright-core/index.mjs \
  node scripts/prove-rooms-mcp-consent-browser.mjs
```

The proof opens an actual callback listener on loopback port 9876. It exercises
Allow and Cancel in separate flows and Edit/Save in each. `--before` reproduces
the original failure against a build of the old source. Optional
`MCP_BROWSER_CHROME` selects Chrome's executable.

## Demonstrated

The same Reproduction MCP-CONSENT-ORIGIN passed in headless Google Chrome:

- Allow and Cancel sent `Origin: http://127.0.0.1:18965`, returned HTTP 302,
  and reached the separate callback listener. Allow supplied a code; Cancel
  supplied `access_denied`. State and issuer matched.
- Edit/Save returned to consent with HTTP 302.
- Code exchange succeeded, followed by `initialize`, `tools/list`, and
  `tools/call` for `list_rooms`. The new client has no Room memberships, so its
  bounded Room list is empty.
- Cross-site and literal `null` Origin POSTs were refused with HTTP 400 even with
  the valid browser cookie and flow. The HTTP suite additionally rejects missing
  Origin for Save, Allow and Cancel.
- The existing built SDK proof passed, including Room listing, reading, posting,
  agent reply routing, removal, disconnect and subsequent HTTP 401.
- The Rooms MCP HTTP suite passed (20 tests), and root typecheck passed.
  Running the new assertions against the old source failed (18 tests), including
  the consent policy assertion, before restoring the fixed source and rerunning.

## Production browser limitation

Trusty Squire reached Settings → Connectors on `web.usebeeline.app` in the existing
owner session. That account had no visible AI clients section. The vaulted
reviewer-bypass link exists, but sealed login loading returned
`POST /v1/vault/browser-fill → 400 unsupported_credential_type` for its `value`
field. A live browser card was posted for human reviewer sign-in handback.
Production reviewer listing and disconnect are not claimed. The concrete
remaining check is reviewer sign-in through that card, then list and disconnect
a dedicated test client. No production release was performed.
