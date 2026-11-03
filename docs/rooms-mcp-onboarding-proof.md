# Rooms MCP first-Workspace onboarding proof

The consent screenshot and browser proof use only an ephemeral PGlite database on
`http://127.0.0.1:18987`, with the synthetic `Connector Reviewer` GitHub identity.
There is no production database, account, Workspace or helper in this proof.

Start the fixture after building the server:

```sh
npm run build -w @beeline/server
MCP_PROOF_PORT=18987 node --import tsx scripts/prove-rooms-mcp.mjs --serve --new-user
```

`--new-user` skips all identity, Workspace, Room and membership seeds. The actual
Beeline GitHub login, ticket exchange and identity creation run against the local
server; the upstream GitHub provider alone is a synthetic fixture.

Using `chrome-devtools-axi` in session `mcp-onboard-87`, register a public Codex
client with an S256 verifier, navigate to its authorization URL and choose
Continue with GitHub. The zero-Workspace consent page retained Joins as and It
can, displayed “Allow will create your Workspace, Connector's team, with a public
#general Room.”, had no Workspace checkbox and left Allow enabled. After clicking
Allow and exchanging the authorization code, `list_rooms` returned only `general`
and the Codex member byline. `read_messages`, `send_message`, and `read_messages`
then confirmed “Local onboarding proof: Codex joined and posted in general.” was
persisted under that member's identity.

![Zero-Workspace consent with Allow enabled](evidence/mcp-onboarding/zero-workspace-consent.png)

Regression coverage in `apps/server/src/rooms-mcp.test.ts`:

- `MCP-ONBOARD-1: new sign-in creates an owned Workspace and public general on Allow, then reads and posts through MCP`
- `MCP-ONBOARD-2: new-person %s refusal leaves no Workspace or grant` (Cancel, wrong Origin, missing selection marker, malformed Workspace selection, invalid webhook)
- `MCP-WORKSPACE-1: rejects empty, malformed, duplicate and foreign selections without granting membership` (existing-Workspace refusal retained)

`apps/server/src/rooms-mcp-consent-ui.test.ts` also checks
`explains first-run creation with no picker and leaves Allow enabled`, including
the actual static page enhancement script and escaped Workspace names.
