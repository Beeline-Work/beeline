# Connector action proof

Reproductions: CONNECTOR-SEARCH-REMOVAL, REMOVE-1, MCP-URL-1.

Run from the repository root:

    CONNECTOR_BROWSER_PROOF=1 npm test -w @beeline/server -- src/app-connections.integration.test.ts -t CONNECTOR-BROWSER

The isolated PGlite database runs the actual PhoneService. A loopback bridge permits Workbench reads, search, connect and disconnect plus a fixture reset. A separate browser renders the real React Native Web screens and invokes operations over HTTP. It clicks Slack, its app row, and Disconnect; remounts Connectors; then independently rereads PhoneService and verifies Slack is absent. This runs at phone and desktop widths in Bone and Obsidian.

The same client searches fly and https://mcp.fly.io, clicks Fly, invokes the actual connect operation and verifies the OAuth handoff and retention of six keys. Cold/warm cache behavior is independently covered by MCP-DISCOVERY-1.

Captures named before/after show immediately before and after the tested action on the fixed build, NOT the old source revision. Original human screenshots in the brief establish the original visual failure. Initial component and saved-key projection regressions establish the prior behavior.

Limits: phone captures use a narrow web renderer, not a native device; no Android device was attached. Provider calls use controlled fixtures matching verified Fly metadata. Helper presence and sign-in URL publication are simulated. The browser OAuth handoff is intercepted; actual OAuth completion is not claimed. No production connections were modified. REMOVE-1 covers Slack, Supabase and WhatsApp removal, cross-owner denial and late callbacks.

Live Fly endpoint: https://mcp.fly.io; authorization server: https://fly.io/mcp/oauth. The complete official registry latest-version fly query returned no Fly-owned entry. io.fly/company-mcp is Beeline's generated company manifest identity, not a published registry entry.
